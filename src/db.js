import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { compressText } from './compress.js';

// Bun ships a native SQLite driver (bun:sqlite) with an API modeled closely
// on better-sqlite3 — prepare/get/all/run/transaction/exec all match,
// including multi-statement exec() and BLOB round-tripping via Buffer-
// compatible Uint8Array. Loading the driver only for the runtime that's
// actually running means a Bun install never needs to compile the
// better-sqlite3 native addon, and a Node install never touches bun:sqlite.
const Database = typeof Bun !== 'undefined'
  ? (await import('bun:sqlite')).Database
  : (await import('better-sqlite3')).default;

const MIGRATIONS = [
  // v1 — initial schema
  `
  CREATE TABLE feeds (
    id INTEGER PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    title TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    last_fetched_at TEXT,
    last_status TEXT
  );

  CREATE TABLE articles (
    id INTEGER PRIMARY KEY,
    feed_id INTEGER NOT NULL REFERENCES feeds(id),
    guid TEXT NOT NULL,
    url TEXT,
    title TEXT NOT NULL,
    author TEXT,
    published_at TEXT,
    content TEXT,
    summary TEXT,
    embedding BLOB,
    status TEXT NOT NULL DEFAULT 'pending',
    enrich_attempts INTEGER NOT NULL DEFAULT 0,
    duplicate_of INTEGER REFERENCES articles(id),
    score REAL NOT NULL DEFAULT 0,
    vote INTEGER NOT NULL DEFAULT 0,
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE (feed_id, guid)
  );
  CREATE INDEX idx_articles_status ON articles(status);
  CREATE INDEX idx_articles_read ON articles(read_at);
  CREATE INDEX idx_articles_published ON articles(published_at);

  CREATE TABLE topics (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );

  CREATE TABLE article_topics (
    article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    PRIMARY KEY (article_id, topic_id)
  );
  `,
  // v2 — readable content fetched from the article's origin page, used when
  // the RSS entry itself is too thin (e.g. Hacker News link-only items)
  `
  ALTER TABLE articles ADD COLUMN full_content TEXT;
  `,
  // v3 — blended scoring: a style-bearing embedding of the article text
  // (the dedup embedding is of our own uniform summary and carries no
  // style), an LLM depth rating, and the persisted score components
  `
  ALTER TABLE articles ADD COLUMN text_embedding BLOB;
  ALTER TABLE articles ADD COLUMN depth INTEGER;
  ALTER TABLE articles ADD COLUMN score_topics REAL NOT NULL DEFAULT 0;
  ALTER TABLE articles ADD COLUMN score_embedding REAL NOT NULL DEFAULT 0;
  ALTER TABLE articles ADD COLUMN score_depth REAL NOT NULL DEFAULT 0;
  ALTER TABLE articles ADD COLUMN score_feed REAL NOT NULL DEFAULT 0;
  `,
  // v4 — client-side feed management: fetch outcome counters (the feed list
  // itself already lives in the feeds table, which becomes the source of
  // truth; config feeds are only seeds)
  `
  ALTER TABLE feeds ADD COLUMN ok_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE feeds ADD COLUMN error_count INTEGER NOT NULL DEFAULT 0;
  `,
  // v5 — the feed's human-facing site (OPML htmlUrl); auto-backfilled from
  // the RSS channel's <link> on fetch
  `
  ALTER TABLE feeds ADD COLUMN html_url TEXT;
  `,
  // v6 — adaptive per-feed scheduling (next due time + optional manual
  // interval override) and a meta table for the enrichment lease
  `
  ALTER TABLE feeds ADD COLUMN next_fetch_at TEXT;
  ALTER TABLE feeds ADD COLUMN fetch_interval_min INTEGER;
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // v7 — duplicate bundling: duplicate_of must always point to a group root
  // (repair pre-existing cycles/chains created by re-enrichment)
  (db) => {
    db.exec('CREATE INDEX idx_articles_duplicate_of ON articles(duplicate_of);');
    repairDuplicateGroups(db);
  },
  // v8 — on-demand reclassification: a persistent reader note fed to the
  // LLM, and a priority flag so requests jump the newest-first queue
  `
  ALTER TABLE articles ADD COLUMN enrich_note TEXT;
  ALTER TABLE articles ADD COLUMN enrich_priority INTEGER NOT NULL DEFAULT 0;
  `,
  // v9 — repair full_content mojibake from before fetchArticleText decoded
  // pages using their declared charset (src/charset.js): non-UTF-8 origin
  // pages (iso-8859-1/windows-1252, still common) were decoded as UTF-8
  // regardless, replacing every affected character with U+FFFD.
  (db) => repairMojibake(db),
  // v10 — cap fetched article size (fetchArticleText's maxChars, default
  // 50,000): some URLs extract as a huge, mostly-irrelevant blob rather
  // than one article — seen live as an 8-row, ~47MB blowup from FreeBSD's
  // newsflash page, where every #anchor for a distinct announcement
  // fetches the exact same full-history page since fragments never reach
  // the server. Clear anything already over the cap so it's naturally
  // re-fetched, now bounded, next time.
  (db) => repairOversizedContent(db),
  // v11 — compress content/full_content (brotli, see src/compress.js):
  // these two columns dwarfed the rest of the database (75.7MB of 131.9MB
  // measured live pre-compression). Still declared TEXT in the schema —
  // SQLite's TEXT affinity only coerces numeric input, never BLOBs, so
  // storing compressed bytes there needs no ALTER TABLE. One-time pass
  // over existing plain-text rows; every write from here on
  // (ingestFeed, articleText, getReaderContent) stores pre-compressed.
  (db) => compressExistingContent(db),
  // v12 — topic-merge alias history (src/topicMerge.js): when a reader
  // approves collapsing topic A into topic B, the mapping is recorded here
  // so a *future* classification that names A again (the model has no
  // memory of the merge) redirects to B automatically instead of
  // recreating A. ON DELETE CASCADE: if the canonical topic itself is ever
  // deleted, its aliases are meaningless and should go with it.
  `
  CREATE TABLE topic_aliases (
    alias_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    canonical_topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    merged_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );
  `,
  // v13 — track when a vote was last changed, for recency-weighted scoring
  // (voteDecayHalflifeYears in scoring config). Existing votes backfilled
  // from read_at (the closest approximation available at migration time).
  (db) => {
    db.exec("ALTER TABLE articles ADD COLUMN voted_at TEXT");
    db.exec("UPDATE articles SET voted_at = read_at WHERE vote != 0");
  },
  // v14 — persist the exploratory bonus so it displays in the score tooltip.
  "ALTER TABLE articles ADD COLUMN score_bonus REAL NOT NULL DEFAULT 0;",
  // v15 — distinguish RSS/Atom feeds from Mastodon API sources.
  "ALTER TABLE feeds ADD COLUMN type TEXT NOT NULL DEFAULT 'rss';",
  // v16 — triage's round-robin sort (server.js's DATE_ROUND_ROBIN) ranks
  // and looks up articles per feed_id; nothing indexed that column before.
  "CREATE INDEX idx_articles_feed_id ON articles(feed_id);",
  // v17 — /api/stats' COUNT/SUM over status/read_at/duplicate_of used to be
  // a full table scan, which means reading every row's full on-disk bytes —
  // dominated by the embedding/text_embedding BLOBs and compressed
  // content/full_content, not the three small columns actually needed.
  // Live evidence (rssmart_db_query_seconds_total tracking almost exactly
  // one /api/stats request's 26.8s wall-clock time, while a plain disk
  // write+fsync probe taken moments later stayed under 10ms) pointed at
  // this scan's sheer page count, not a broadly stalled disk. A covering
  // index over just these three columns lets SQLite answer the whole
  // query from compact index pages, never touching the BLOB-heavy rows.
  "CREATE INDEX idx_articles_stats ON articles(status, read_at, duplicate_of);",
  // v18 — topicPrefs (src/scoring.js, backs /api/topics) had the same
  // full-scan problem twice over: its own change-detection cache-key
  // query (SUM(vote != 0), SUM(status = 'enriched')) was a plain
  // `SCAN articles`, fixed the same way as v17 with a covering index.
  // The actual per-topic aggregation query is a different shape though:
  // it LEFT JOINs article_topics -> articles by id (the rowid), once per
  // article-topic link (thousands of rows), and a rowid lookup always
  // reads the full row — there's no way to "cover" a rowid join with a
  // normal index in the abstract. A redundant secondary index over
  // (id, vote) makes it *possible* for SQLite to answer "vote WHERE
  // id = ?" from that small index alone — confirmed via EXPLAIN QUERY
  // PLAN that it changes "SEARCH a USING INTEGER PRIMARY KEY" to
  // "SEARCH a USING COVERING INDEX idx_articles_id_vote" and returns
  // identical rows. BUT SQLite's query planner doesn't pick this
  // automatically (its cost model has no notion of "this row is
  // expensive because of BLOB overflow pages") — topicPrefs' own query
  // has to force it with `INDEXED BY idx_articles_id_vote` (see
  // src/scoring.js). The index alone, without that hint, changes nothing.
  (db) => {
    db.exec('CREATE INDEX idx_articles_vote_status ON articles(vote, status);');
    db.exec('CREATE INDEX idx_articles_id_vote ON articles(id, vote);');
  },
  // v19 — idx_articles_id_vote (v18) turned out too narrow: topicPrefs'
  // real query needs voted_at/created_at too (decayedVoteExpr, used
  // whenever scoring.voteDecayHalflifeYears is set — the documented
  // default). Verified live: forcing v18's (id, vote) index via INDEXED
  // BY still showed "SEARCH a USING INDEX" (no "COVERING") once the
  // decay expression was included — it had to fall back to the main
  // table for the extra columns, defeating the point. Widening to
  // (id, vote, voted_at, created_at) gets the real "USING COVERING
  // INDEX" plan; confirmed identical output too (row-for-row, aside from
  // ~1e-8-scale float summation-order noise in the decayed-vote sums,
  // inherent to any change in aggregation order and not a real diff).
  (db) => {
    db.exec('DROP INDEX idx_articles_id_vote;');
    db.exec('CREATE INDEX idx_articles_id_vote ON articles(id, vote, voted_at, created_at);');
  },
  // v20 — "explore" sort (src/server.js, src/scoring.js): persists how
  // different an article is from everything voted on so far (1 - highest
  // similarity to any voted article), computed once per recompute sweep
  // from the same pairSims already used for the exploratory-bonus lift, so
  // sorting by it is a plain ORDER BY, not a per-request redo of that
  // embedding comparison. NULL (not 0) until there's a real
  // basis to compute it — no embedding yet, or nothing voted on at all.
  "ALTER TABLE articles ADD COLUMN score_novelty REAL;",
];

/**
 * Null out full_content corrupted by decoding a non-UTF-8 page as UTF-8
 * (every affected character becomes U+FFFD, irrecoverably). full_content is
 * a lazy cache (see getReaderContent in enrich.js), not authoritative data,
 * so this is enough — it's naturally re-fetched, now correctly decoded,
 * next time it's requested. Idempotent: a clean DB has nothing to touch.
 */
export function repairMojibake(db) {
  db.exec(`
    UPDATE articles SET full_content = NULL
    WHERE full_content LIKE '%' || char(65533) || '%'
  `);
}

/**
 * Null out full_content stored before fetchArticleText capped its size
 * (see maxChars there). full_content is a lazy cache, not authoritative
 * data, so clearing an oversized row is enough — it's naturally re-fetched
 * and re-capped next time it's requested. The threshold here is the
 * migration's own fixed one-time cleanup bar, independent of whatever
 * enrich.maxArticleChars is configured to later.
 */
export function repairOversizedContent(db, { maxChars = 50_000 } = {}) {
  db.prepare('UPDATE articles SET full_content = NULL WHERE LENGTH(full_content) > ?').run(maxChars);
}

/**
 * One-time brotli-compress every existing plain-text content/full_content
 * value in place. Runs once (v11); every write after this migration already
 * stores compressed bytes (ingestFeed, articleText, getReaderContent), so
 * there's nothing left to catch up on a clean-from-here DB. Unlike
 * repairMojibake/repairOversizedContent, this is NOT safe to call twice —
 * it has no way to tell "plain text" from "already compressed", so a second
 * pass would compress the compressed bytes again. Safe here only because
 * the migration framework's user_version tracking guarantees it runs once.
 */
export function compressExistingContent(db) {
  const rows = db.prepare(`
    SELECT id, content, full_content FROM articles
    WHERE content IS NOT NULL OR full_content IS NOT NULL
  `).all();
  const update = db.prepare('UPDATE articles SET content = ?, full_content = ? WHERE id = ?');
  for (const row of rows) {
    update.run(
      row.content != null ? compressText(row.content) : null,
      row.full_content != null ? compressText(row.full_content) : null,
      row.id,
    );
  }
}

/**
 * Normalize duplicate groups to a single level: every duplicate_of points
 * to a root article whose own duplicate_of is NULL. Re-enrichment used to
 * create A<->B cycles (hiding both) and A->B->C chains.
 */
export function repairDuplicateGroups(db) {
  // self-references and 2-cycles: the smaller id becomes the root
  db.exec(`
    UPDATE articles SET duplicate_of = NULL
    WHERE duplicate_of = id
       OR (duplicate_of IS NOT NULL AND id < duplicate_of AND
           (SELECT d.duplicate_of FROM articles d WHERE d.id = articles.duplicate_of) = articles.id)
  `);
  // flatten chains one hop at a time until every pointer hits a root
  const hop = db.prepare(`
    UPDATE articles SET duplicate_of = (
      SELECT d.duplicate_of FROM articles d WHERE d.id = articles.duplicate_of
    )
    WHERE duplicate_of IS NOT NULL
      AND (SELECT d.duplicate_of FROM articles d WHERE d.id = articles.duplicate_of) IS NOT NULL
  `);
  for (let i = 0; i < 10 && hop.run().changes > 0; i++);
  // anything still nested after that is a longer cycle: promote to root
  db.exec(`
    UPDATE articles SET duplicate_of = NULL
    WHERE duplicate_of IS NOT NULL
      AND (SELECT d.duplicate_of FROM articles d WHERE d.id = articles.duplicate_of) IS NOT NULL
  `);
}

// Cumulative time spent inside any SQLite query, across the whole app
// (every db.prepare(...).run/get/all call site — API handlers, scoring,
// enrichment, ingest — not just enrichment's own "db" phase timing in
// enrich.js). Companion to the event-loop-lag watchdog (lagWatchdog.js):
// lets a stall be attributed to "this process spent Xs in SQLite" vs
// something else, without instrumenting every call site by hand.
let _dbQueryMs = 0;
export function getDbQueryMs() { return _dbQueryMs; }

// Wraps db.prepare so every statement it returns times its own run/get/all
// calls — one choke point covering the whole app automatically, including
// statements prepared once and reused many times (the common pattern
// here, e.g. scoring.js's `const save = db.prepare(...)`). db.exec()
// (schema/migrations below) isn't wrapped: one-time startup work, not
// part of what runs while the app is actually serving requests.
function instrumentQueryTiming(db) {
  const rawPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = rawPrepare(sql);
    for (const method of ['run', 'get', 'all']) {
      const raw = stmt[method]?.bind(stmt);
      if (!raw) continue;
      stmt[method] = (...args) => {
        const start = performance.now();
        try {
          return raw(...args);
        } finally {
          _dbQueryMs += performance.now() - start;
        }
      };
    }
    return stmt;
  };
}

// bun:sqlite has no .pragma() convenience method (better-sqlite3's is just
// sugar over this same pattern, which is why it exists at all: whether a
// given pragma form returns a row is inconsistent — journal_mode does even
// when "setting" it, foreign_keys doesn't). bun:sqlite's .get() tolerates
// either case; better-sqlite3 statically classifies each statement as
// data-returning or not and throws if you call the wrong one of get()/run(),
// so fall back to run() on that specific error rather than guess per pragma.
function pragma(db, statement) {
  const stmt = db.prepare(`PRAGMA ${statement}`);
  try {
    return stmt.get();
  } catch (err) {
    if (!/does not return data/i.test(err.message)) throw err;
    return stmt.run();
  }
}

/** Open (creating if necessary) the SQLite database and apply migrations. */
export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  instrumentQueryTiming(db);
  pragma(db, 'journal_mode = WAL');
  pragma(db, 'foreign_keys = ON');
  // better-sqlite3 waits out lock contention by default; bun:sqlite does
  // not (observed: an immediate SQLITE_BUSY under concurrent cron + serve
  // writers, a supported scenario the enrichment lease already relies on
  // being safe). Set it explicitly so both drivers behave the same way.
  pragma(db, 'busy_timeout = 5000');
  // Limit SQLite page cache to ~16MB (4000 pages × 4KB) — prevents unbounded
  // memory growth under bun:sqlite which defaults to caching many pages.
  pragma(db, 'cache_size = -16000');

  const version = pragma(db, 'user_version').user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      const migration = MIGRATIONS[v];
      if (typeof migration === 'function') migration(db);
      else db.exec(migration);
      pragma(db, `user_version = ${v + 1}`);
    })();
  }
  return db;
}
