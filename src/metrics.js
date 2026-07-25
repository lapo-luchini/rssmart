import { statSync } from 'node:fs';

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

  metric(lines, 'rssmart_db_bytes', 'gauge', 'On-disk size of the SQLite database (main file + WAL + SHM).', [
    [{}, dbSizeBytes(config.db)],
  ]);

  metric(lines, 'rssmart_build_info', 'gauge', 'Always 1; the commit label identifies the running build.', [
    [{ commit: commitHash || 'unknown' }, 1],
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

  return lines.join('\n') + '\n';
}
