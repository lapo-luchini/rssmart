import { statSync } from 'node:fs';
import { getEnrichTimings, getEnrichMaxTimings } from './enrich.js';

// Prometheus text exposition format:
// https://prometheus.io/docs/instrumenting/exposition_formats/
// Label values need escaping of backslash/quote/newline; ours are always
// simple enums or numbers, but escaping costs nothing and avoids a subtly
// broken /metrics response if that ever changes.
function escapeLabelValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labelsToString(labels) {
  const entries = Object.entries(labels ?? {});
  if (entries.length === 0) return '';
  return `{${entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',')}}`;
}

function metric(lines, name, type, help, samples) {
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  for (const [labels, value] of samples) {
    lines.push(`${name}${labelsToString(labels)} ${value}`);
  }
}

/** Sum of the main db file + WAL + shared-memory index, however much of
 *  that trio currently exists (WAL/SHM only appear once something's been
 *  written under WAL mode) — the real on-disk footprint, not just the
 *  logical page count in the main file. */
function dbSizeBytes(dbPath) {
  let total = 0;
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      total += statSync(path).size;
    } catch {
      // doesn't exist yet (no WAL activity) or db is ':memory:' (tests) — skip
    }
  }
  return total;
}

/** Per-table data/index sizes via SQLite's dbstat virtual table — a
 *  compile-time SQLite option. better-sqlite3 always has it; bun:sqlite
 *  (confirmed on both the official release and a NixOS-packaged build)
 *  does not — probed live rather than assumed, same as scripts/dbstats.js's
 *  own probe for its report. dbstat enumerates b-trees (one per table, one
 *  per index) by name; joining sqlite_master maps each index back to the
 *  table it belongs to, so index pages can be summed per owning table
 *  instead of listed as their own unrelated series. */
function dbTableBytes(db) {
  try {
    const rows = db.prepare(`
      SELECT m.tbl_name AS table_name, m.type AS kind, SUM(d.pgsize) AS bytes
      FROM dbstat d
      JOIN sqlite_master m ON m.name = d.name
      WHERE m.type IN ('table', 'index')
      GROUP BY m.tbl_name, m.type
    `).all();
    return { available: true, rows };
  } catch {
    return { available: false, rows: [] };
  }
}

/** Runtime + SQLite identification — shared between rssmart_build_info
 *  below and bin/rssmart.js's own startup banner, so both report exactly
 *  the same values from exactly the same query instead of two independent
 *  (and possibly drifting) implementations. */
export function getRuntimeInfo(db) {
  const runtime = typeof Bun !== 'undefined'
    ? { type: 'bun', version: Bun.version }
    : { type: 'node', version: process.version.replace(/^v/, '') };
  const { v: sqliteVersion } = db.prepare('SELECT sqlite_version() AS v').get();
  return { runtime: runtime.type, runtimeVersion: runtime.version, sqliteVersion };
}

/**
 * Render current app + process state as Prometheus text exposition format
 * for a scrape-based dashboard (article/vote/feed counts, db size, process
 * memory). Every query here is a plain COUNT/GROUP BY over small tables
 * (articles, feeds, topics) — cheap enough (a few ms even at tens of
 * thousands of rows, same tables /api/stats already scans on every page
 * load) that there's no real benefit to caching between the 30s scrapes
 * this is built for. Caching would need its own change-detection query
 * (see topicPrefs/feedList's cache-key pattern elsewhere in this codebase)
 * that costs about as much as just re-running these directly, for no
 * externally visible upside — a scraper always wants the current value,
 * never a deliberately-stale one.
 */
export function renderMetrics(db, config, commitHash) {
  const lines = [];

  const articles = db.prepare(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(read_at IS NOT NULL), 0) AS read,
           COALESCE(SUM(duplicate_of IS NOT NULL), 0) AS duplicates,
           COALESCE(SUM(status = 'pending'), 0) AS pending,
           COALESCE(SUM(status = 'enriched'), 0) AS enriched,
           COALESCE(SUM(status = 'error'), 0) AS errored
    FROM articles
  `).get();

  metric(lines, 'rssmart_articles_count', 'gauge', 'Total number of articles.', [
    [{}, articles.total],
  ]);
  metric(lines, 'rssmart_articles', 'gauge', 'Number of articles by classification status.', [
    [{ status: 'pending' }, articles.pending],
    [{ status: 'enriched' }, articles.enriched],
    [{ status: 'error' }, articles.errored],
  ]);
  metric(lines, 'rssmart_articles_read', 'gauge', 'Number of articles marked as read.', [
    [{}, articles.read],
  ]);
  metric(lines, 'rssmart_articles_duplicates', 'gauge', 'Number of articles marked as a duplicate of another.', [
    [{}, articles.duplicates],
  ]);

  // Every vote value always appears, even at 0 count, so a dashboard never
  // needs `or vector(0)` for a value that simply hasn't happened yet (e.g.
  // a fresh install with no downvotes).
  const voteCounts = new Map([-2, -1, 1, 2].map((v) => [v, 0]));
  for (const row of db.prepare(
    'SELECT vote, COUNT(*) AS c FROM articles WHERE vote != 0 GROUP BY vote',
  ).all()) {
    voteCounts.set(row.vote, row.c);
  }
  metric(lines, 'rssmart_votes', 'gauge', 'Number of articles with a given (non-zero) vote value.',
    [...voteCounts].map(([vote, c]) => [{ value: String(vote) }, c]));

  const feeds = db.prepare(`
    SELECT COALESCE(SUM(active), 0) AS active, COUNT(*) AS total,
           COALESCE(SUM(ok_count), 0) AS ok, COALESCE(SUM(error_count), 0) AS errored
    FROM feeds
  `).get();
  metric(lines, 'rssmart_feeds', 'gauge', 'Number of feeds by active state.', [
    [{ active: 'true' }, feeds.active],
    [{ active: 'false' }, feeds.total - feeds.active],
  ]);
  metric(lines, 'rssmart_feed_fetches_total', 'counter',
    'Total feed fetch attempts by outcome, summed across all feeds since each was added.', [
      [{ result: 'ok' }, feeds.ok],
      [{ result: 'error' }, feeds.errored],
    ]);

  const { topics } = db.prepare('SELECT COUNT(*) AS topics FROM topics').get();
  metric(lines, 'rssmart_topics', 'gauge', 'Number of distinct topics.', [[{}, topics]]);

  // Cumulative time per enrichment phase — a counter (only ever grows,
  // process lifetime), so rate()/irate() per phase in Prometheus directly
  // answers "what fraction of enrichment time is LLM vs readability
  // parsing vs DB writes" as an ongoing trend, not a one-off snapshot.
  const enrichTimings = getEnrichTimings();
  metric(lines, 'rssmart_enrich_seconds_total', 'counter',
    'Cumulative wall-clock time spent per enrichment phase (fetch, parse, chat, embed, dedup, db).',
    Object.entries(enrichTimings).map(([phase, ms]) => [{ phase }, ms / 1000]));

  // Slowest single article's contribution to each phase — a cumulative
  // average (above) hides a lone pathological outlier (e.g. a huge page
  // taking seconds to parse) among many fast ones; this surfaces it.
  const enrichMax = getEnrichMaxTimings();
  metric(lines, 'rssmart_enrich_slowest_seconds', 'gauge',
    'Slowest single article observed per enrichment phase, since process start.',
    Object.entries(enrichMax).map(([phase, ms]) => [{ phase }, ms / 1000]));

  metric(lines, 'rssmart_db_bytes', 'gauge', 'On-disk size of the SQLite database (main file + WAL + SHM).', [
    [{}, dbSizeBytes(config.db)],
  ]);

  const dbTables = dbTableBytes(db);
  metric(lines, 'rssmart_db_dbstat_available', 'gauge',
    'Whether this SQLite build supports the dbstat virtual table backing rssmart_db_table_bytes (1) or not (0).', [
      [{}, dbTables.available ? 1 : 0],
    ]);
  if (dbTables.available) {
    metric(lines, 'rssmart_db_table_bytes', 'gauge',
      "On-disk bytes per table, split into its own data pages (kind=\"data\") and all its indexes' pages combined (kind=\"index\").",
      dbTables.rows.map((r) => [{ table: r.table_name, kind: r.kind === 'table' ? 'data' : 'index' }, r.bytes]));
  }

  const { runtime, runtimeVersion, sqliteVersion } = getRuntimeInfo(db);
  metric(lines, 'rssmart_build_info', 'gauge', 'Always 1; labels identify the running build and runtime.', [
    [{
      commit: commitHash || 'unknown',
      runtime,
      runtime_version: runtimeVersion,
      sqlite_version: sqliteVersion,
    }, 1],
  ]);

  // Standard prom-client-style names (unprefixed) for the process/runtime
  // section, so generic Node.js Grafana dashboards recognize them without
  // any rssmart-specific configuration.
  const mem = process.memoryUsage();
  metric(lines, 'process_start_time_seconds', 'gauge', 'Unix time the process started.', [
    [{}, Math.round((Date.now() - process.uptime() * 1000) / 1000)],
  ]);
  metric(lines, 'process_resident_memory_bytes', 'gauge', 'Resident set size.', [[{}, mem.rss]]);
  metric(lines, 'nodejs_heap_size_used_bytes', 'gauge', 'V8 heap used.', [[{}, mem.heapUsed]]);
  metric(lines, 'nodejs_heap_size_total_bytes', 'gauge', 'V8 heap total.', [[{}, mem.heapTotal]]);
  // Not logged on the CLI (scheduler.js's memLog only prints rss/heap), but
  // one field away on the same process.memoryUsage() call, and arrayBuffers
  // specifically is exactly the number the Float16Array/ArrayBuffer leak
  // hunting earlier in this project's history would have wanted to graph.
  metric(lines, 'nodejs_external_memory_bytes', 'gauge', 'Memory used by C++ objects bound to JS objects, outside the V8 heap.', [[{}, mem.external]]);
  metric(lines, 'nodejs_arraybuffers_bytes', 'gauge', 'Memory used by ArrayBuffers and Buffers (a subset of external).', [[{}, mem.arrayBuffers]]);

  return lines.join('\n') + '\n';
}
