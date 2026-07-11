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
  pragma(db, 'journal_mode = WAL');
  pragma(db, 'foreign_keys = ON');
  // better-sqlite3 waits out lock contention by default; bun:sqlite does
  // not (observed: an immediate SQLITE_BUSY under concurrent cron + serve
  // writers, a supported scenario the enrichment lease already relies on
  // being safe). Set it explicitly so both drivers behave the same way.
  pragma(db, 'busy_timeout = 5000');

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
