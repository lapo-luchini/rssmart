import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb } from './helpers.js';
import { repairDuplicateGroups, openDb } from '../src/db.js';

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
