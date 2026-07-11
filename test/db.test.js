import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb } from './helpers.js';
import { repairDuplicateGroups, repairMojibake, repairOversizedContent, compressExistingContent, openDb } from '../src/db.js';
import { decompressText } from '../src/compress.js';

test('openDb sets a non-zero busy_timeout so concurrent writers wait rather than fail immediately', () => {
  // better-sqlite3 waits out lock contention by default; bun:sqlite
  // doesn't unless told to (observed as an immediate SQLITE_BUSY under
  // real concurrent cron + serve writers) — this pins the fix in place.
  const db = tempDb();
  const { timeout } = db.prepare('PRAGMA busy_timeout').get();
  assert.ok(timeout >= 5000, `expected a multi-second busy_timeout, got ${timeout}`);
});

test('repairDuplicateGroups breaks cycles and flattens chains', () => {
  const db = tempDb();
  db.prepare("INSERT INTO feeds (id, url) VALUES (1, 'http://f')").run();
  const ins = db.prepare(
    'INSERT INTO articles (id, feed_id, guid, title) VALUES (?, 1, ?, ?)',
  );
  for (let id = 1; id <= 6; id++) ins.run(id, `g${id}`, `Article ${id}`);
  const set = db.prepare('UPDATE articles SET duplicate_of = ? WHERE id = ?');

  set.run(1, 2);    // 2 -> 1              (fine already)
  set.run(2, 3);    // 3 -> 2 -> 1         (chain)
  set.run(5, 4);    // 4 <-> 5             (the mutual-duplicate bug)
  set.run(4, 5);
  set.run(6, 6);    // self-reference

  repairDuplicateGroups(db);

  const dup = (id) =>
    db.prepare('SELECT duplicate_of FROM articles WHERE id = ?').get(id).duplicate_of;
  assert.equal(dup(2), 1);
  assert.equal(dup(3), 1, 'chain flattened to the root');
  assert.equal(dup(4), null, '2-cycle: smaller id becomes root');
  assert.equal(dup(5), 4);
  assert.equal(dup(6), null, 'self-reference cleared');

  // idempotent
  repairDuplicateGroups(db);
  assert.equal(dup(3), 1);
  assert.equal(dup(5), 4);
});

test('repairMojibake nulls out full_content corrupted by a wrong-charset decode', () => {
  const db = tempDb();
  db.prepare("INSERT INTO feeds (id, url) VALUES (1, 'http://f')").run();
  const ins = db.prepare(
    'INSERT INTO articles (id, feed_id, guid, title, full_content) VALUES (?, 1, ?, ?, ?)',
  );
  ins.run(1, 'g1', 'Corrupted', 'Citt� e perch�, gi� pronta');
  ins.run(2, 'g2', 'Clean', '<p>Perfectly good extracted text.</p>');
  ins.run(3, 'g3', 'No content', null);

  repairMojibake(db);

  const fullContent = (id) =>
    db.prepare('SELECT full_content FROM articles WHERE id = ?').get(id).full_content;
  assert.equal(fullContent(1), null, 'corrupted full_content cleared for re-fetch');
  assert.equal(fullContent(2), '<p>Perfectly good extracted text.</p>', 'clean content left alone');
  assert.equal(fullContent(3), null);

  // idempotent
  repairMojibake(db);
  assert.equal(fullContent(2), '<p>Perfectly good extracted text.</p>');
});

test('repairOversizedContent nulls out full_content stored before the size cap existed', () => {
  const db = tempDb();
  db.prepare("INSERT INTO feeds (id, url) VALUES (1, 'http://f')").run();
  const ins = db.prepare(
    'INSERT INTO articles (id, feed_id, guid, title, full_content) VALUES (?, 1, ?, ?, ?)',
  );
  ins.run(1, 'g1', 'Huge', 'x'.repeat(200));
  ins.run(2, 'g2', 'Fits', 'x'.repeat(100));
  ins.run(3, 'g3', 'No content', null);

  repairOversizedContent(db, { maxChars: 100 });

  const fullContent = (id) =>
    db.prepare('SELECT full_content FROM articles WHERE id = ?').get(id).full_content;
  assert.equal(fullContent(1), null, 'oversized content cleared for re-fetch');
  assert.equal(fullContent(2), 'x'.repeat(100), 'content exactly at the cap is left alone');
  assert.equal(fullContent(3), null);

  // idempotent
  repairOversizedContent(db, { maxChars: 100 });
  assert.equal(fullContent(2), 'x'.repeat(100));
});

test('compressExistingContent brotli-compresses plain-text content/full_content in place', () => {
  const db = tempDb();
  db.prepare("INSERT INTO feeds (id, url) VALUES (1, 'http://f')").run();
  const ins = db.prepare(
    'INSERT INTO articles (id, feed_id, guid, title, content, full_content) VALUES (?, 1, ?, ?, ?, ?)',
  );
  ins.run(1, 'g1', 'Both fields', 'the feed teaser', '<p>the extracted body</p>');
  ins.run(2, 'g2', 'Content only', 'just a teaser', null);
  ins.run(3, 'g3', 'Neither', null, null);

  compressExistingContent(db);

  const row = (id) => db.prepare('SELECT content, full_content FROM articles WHERE id = ?').get(id);
  const r1 = row(1);
  assert.ok(r1.content instanceof Uint8Array, 'stored as bytes, not the original string');
  assert.equal(decompressText(r1.content), 'the feed teaser');
  assert.equal(decompressText(r1.full_content), '<p>the extracted body</p>');

  const r2 = row(2);
  assert.equal(decompressText(r2.content), 'just a teaser');
  assert.equal(r2.full_content, null);

  const r3 = row(3);
  assert.equal(r3.content, null);
  assert.equal(r3.full_content, null);
});
