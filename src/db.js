import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
];

/** Open (creating if necessary) the SQLite database and apply migrations. */
export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const version = db.pragma('user_version', { simple: true });
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}
