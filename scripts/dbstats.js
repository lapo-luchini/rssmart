#!/usr/bin/env node
// Reports where rssmart's SQLite file's bytes actually go: total file size,
// per-table/index size (precise, via SQLite's dbstat virtual table where
// available), and a per-column breakdown of the `articles` table, which
// dominates the file. Read-only — never writes anything.
//
// Usage: node scripts/dbstats.js [config-path]
// (same config resolution as bin/rssmart.js: arg > RSSMART_CONFIG > ./config.yaml)

import { statSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';

function fmtBytes(bytes) {
  if (bytes == null) return '—';
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function printTable(rows, columns) {
  const widths = columns.map((c) =>
    Math.max(c.label.length, ...rows.map((r) => String(r[c.key] ?? '').length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(line(columns.map((c) => c.label)));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const r of rows) console.log(line(columns.map((c) => r[c.key] ?? '')));
}

const config = loadConfig(process.argv[2]);
const db = openDb(config.db);

console.log(`Database: ${config.db}`);
console.log(`File size: ${fmtBytes(statSync(config.db).size)}`);

const { page_size: pageSize } = db.prepare('PRAGMA page_size').get();
const { page_count: pageCount } = db.prepare('PRAGMA page_count').get();
const { freelist_count: freelistCount } = db.prepare('PRAGMA freelist_count').get();
if (freelistCount > 0) {
  console.log(
    `Reclaimable via VACUUM: ~${fmtBytes(freelistCount * pageSize)} ` +
      `(${freelistCount} freed pages not yet returned to the filesystem)`,
  );
}
console.log();

console.log('Row counts:');
const tables = ['articles', 'feeds', 'topics', 'article_topics', 'topic_aliases', 'meta'];
printTable(
  tables.map((name) => ({ name, rows: db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n })),
  [{ key: 'name', label: 'table' }, { key: 'rows', label: 'rows' }],
);
console.log();

// dbstat gives real, precise per-table/index byte sizes straight from
// SQLite's own page accounting (includes row/page overhead, unlike a
// LENGTH()-sum estimate) — but it's a compile-time SQLite option.
// better-sqlite3 always has it; bun:sqlite (confirmed on both the
// official release and a NixOS-packaged build) does not. Probed for
// live rather than assumed, since a fact this specific isn't worth
// hardcoding into a runtime branch.
let dbstatRows = null;
try {
  dbstatRows = db.prepare('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC').all();
} catch {
  // no such table: dbstat — fall through to the estimate-only path below
}

if (dbstatRows) {
  console.log('Table/index sizes (from SQLite\'s own page accounting):');
  printTable(
    dbstatRows.map((r) => ({ name: r.name, bytes: fmtBytes(r.bytes) })),
    [{ key: 'name', label: 'name' }, { key: 'bytes', label: 'size' }],
  );
} else {
  console.log(
    'Table/index sizes: unavailable (this SQLite build has no dbstat virtual ' +
      'table — seen on the official upstream Bun release; try Node, or a ' +
      'different Bun build, for this section).',
  );
}
console.log();

console.log('articles column breakdown (own stored bytes, brotli-compressed where applicable):');
const cols = db.prepare(`
  SELECT
    SUM(LENGTH(embedding))      AS embedding,
    SUM(LENGTH(text_embedding)) AS text_embedding,
    SUM(LENGTH(content))        AS content,
    SUM(LENGTH(full_content))   AS full_content,
    SUM(LENGTH(summary))        AS summary,
    SUM(LENGTH(title))          AS title,
    SUM(LENGTH(url))            AS url,
    SUM(LENGTH(author))         AS author,
    SUM(LENGTH(enrich_note))    AS enrich_note
  FROM articles
`).get();
const namedTotal = Object.values(cols).reduce((a, b) => a + (b ?? 0), 0);
const rows = Object.entries(cols)
  .map(([column, bytes]) => ({ column, bytes: fmtBytes(bytes) }))
  .sort((a, b) => (cols[b.column] ?? 0) - (cols[a.column] ?? 0));
const articlesTableBytes = dbstatRows?.find((r) => r.name === 'articles')?.bytes;
if (articlesTableBytes) {
  rows.push({ column: '(other columns + row/page overhead)', bytes: fmtBytes(articlesTableBytes - namedTotal) });
}
printTable(rows, [{ key: 'column', label: 'column' }, { key: 'bytes', label: 'size' }]);

db.close();
