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
