import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDb, testConfig } from './helpers.js';
import { openDb } from '../src/db.js';
import { enrichPending, recheckDuplicates } from '../src/enrich.js';
import { compressText } from '../src/compress.js';

const vec = (v = [1, 0]) => Float16Array.from(v);
const blob = (v) => v == null ? null : Buffer.from(vec(v).buffer);
function setup(t) {
  const db = tempDb(); t.after(() => db.close());
  db.prepare("INSERT INTO feeds (id,url) VALUES (1,'https://example.invalid')").run();
  return { db, config: testConfig() };
}
function article(db, id, { embedding = [1, 0], parent = null, createdAt = new Date().toISOString(), status = 'enriched' } = {}) {
  db.prepare(`INSERT INTO articles
    (id,feed_id,guid,title,content,embedding,duplicate_of,created_at,status)
    VALUES (?,1,?,'Article',?,?,?,?,?)`)
    .run(id, String(id), compressText('Article body'), blob(embedding), parent, createdAt, status);
}
const parents = (db) => db.prepare('SELECT id,duplicate_of FROM articles ORDER BY id').all();
function assertFlat(db) {
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM articles a JOIN articles p ON p.id=a.duplicate_of
    WHERE p.duplicate_of IS NOT NULL OR a.id=p.id`).get().n, 0);
}

test('reattaching a root moves all of its children to the matched root', (t) => {
  const { db, config } = setup(t);
  article(db, 1); article(db, 2, { embedding: [0, 1], parent: 1 }); article(db, 3);
  assert.equal(recheckDuplicates(db, config, 1).duplicateOf, 3);
  assert.deepEqual(parents(db), [{ id: 1, duplicate_of: 3 }, { id: 2, duplicate_of: 3 }, { id: 3, duplicate_of: null }]);
  assertFlat(db);
});

test('moving a root also flattens existing deeper descendants', (t) => {
  const { db, config } = setup(t);
  article(db, 1); article(db, 2, { embedding: [0, 1], parent: 1 }); article(db, 3);
  article(db, 4, { embedding: [0, 1], parent: 2 });
  recheckDuplicates(db, config, 1);
  assert.deepEqual(parents(db).map((r) => r.duplicate_of), [3, 3, null, 3]);
  assertFlat(db);
});

test('matching one of a roots own copies keeps the root and cannot form a cycle', (t) => {
  const { db, config } = setup(t);
  article(db, 1); article(db, 2, { parent: 1 });
  assert.equal(recheckDuplicates(db, config, 1).duplicateOf, null);
  assert.deepEqual(parents(db).map((r) => r.duplicate_of), [null, 1]);
  assertFlat(db);
});

test('reclassification uses the same atomic group move as manual rechecking', async (t) => {
  const { db, config } = setup(t);
  article(db, 1, { embedding: [0, 1], status: 'pending' });
  article(db, 2, { embedding: [0, 1], parent: 1 }); article(db, 3);
  const llm = { available: async () => true, embed: async () => vec(),
    chatJSON: async () => ({ topics: ['topic'], summary: 'Summary', depth: 3 }) };
  const result = await enrichPending(db, config, llm);
  assert.equal(result.enriched, 1);
  assert.deepEqual(parents(db).map((r) => r.duplicate_of), [3, 3, null]);
  assertFlat(db);
});

test('a failing child update cannot leave a half-moved group', (t) => {
  const { db, config } = setup(t);
  article(db, 1); article(db, 2, { embedding: [0, 1], parent: 1 }); article(db, 3);
  db.exec(`CREATE TRIGGER reject_move BEFORE UPDATE OF duplicate_of ON articles
    WHEN NEW.id=2 BEGIN SELECT RAISE(ABORT,'reject child'); END`);
  assert.throws(() => recheckDuplicates(db, config, 1), /reject child/);
  assert.deepEqual(parents(db).map((r) => r.duplicate_of), [null, 1, null]);
  assertFlat(db);
});

test('a late vector on an older row becomes visible to a warm dedup cache', (t) => {
  const { db, config } = setup(t);
  article(db, 1, { embedding: null, createdAt: new Date(Date.now() - 86400000).toISOString() });
  article(db, 2, { embedding: [0, 1] }); article(db, 3, { embedding: null });
  assert.equal(recheckDuplicates(db, config, 3, vec()).duplicateOf, null);
  db.prepare('UPDATE articles SET embedding=? WHERE id=1').run(blob([1, 0]));
  assert.equal(recheckDuplicates(db, config, 3, vec()).duplicateOf, 1);
});

test('same-time replacements and deleted vectors cannot hide behind created_at', (t) => {
  const { db, config } = setup(t);
  const createdAt = new Date().toISOString();
  article(db, 1, { embedding: [0, 1], createdAt }); article(db, 2, { embedding: null, createdAt });
  assert.equal(recheckDuplicates(db, config, 2, vec()).duplicateOf, null);
  db.prepare('UPDATE articles SET embedding=? WHERE id=1').run(blob([1, 0]));
  assert.equal(recheckDuplicates(db, config, 2, vec()).duplicateOf, 1);
  db.prepare('UPDATE articles SET duplicate_of=NULL WHERE id=2').run();
  db.prepare('DELETE FROM articles WHERE id=1').run();
  assert.equal(recheckDuplicates(db, config, 2, vec()).duplicateOf, null);
});

test('dedup sees a vector replaced by another SQLite connection', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rssmart-dedup-state-'));
  const db = openDb(join(dir, 'test.db')), other = openDb(join(dir, 'test.db'));
  t.after(() => { other.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.prepare("INSERT INTO feeds (id,url) VALUES (1,'https://example.invalid')").run();
  article(db, 1, { embedding: [0, 1] }); article(db, 2, { embedding: null });
  assert.equal(recheckDuplicates(db, testConfig(), 2, vec()).duplicateOf, null);
  other.prepare('UPDATE articles SET embedding=? WHERE id=1').run(blob([1, 0]));
  assert.equal(recheckDuplicates(db, testConfig(), 2, vec()).duplicateOf, 1);
});

test('dedup prunes expired cached vectors when only the clock advances', (t) => {
  const { db, config } = setup(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  article(db, 1, { createdAt: new Date(now).toISOString() }); article(db, 2, { embedding: null });
  assert.equal(recheckDuplicates(db, config, 2, vec([0, 1])).duplicateOf, null);
  now += 15 * 86400000;
  assert.equal(recheckDuplicates(db, config, 2, vec()).duplicateOf, null);
  assert.equal(db.prepare('SELECT embedding FROM articles WHERE id=1').get().embedding, null);
});

test('a vector arriving during classification participates in its final duplicate decision', async (t) => {
  const { db, config } = setup(t);
  article(db, 1, { embedding: null, createdAt: new Date(Date.now() - 86400000).toISOString() });
  article(db, 2, { embedding: [0, 1] }); article(db, 3, { embedding: null, status: 'pending' });
  const llm = { available: async () => true, embed: async () => vec(), chatJSON: async () => {
    db.prepare('UPDATE articles SET embedding=? WHERE id=1').run(blob([1, 0]));
    return { topics: ['topic'], summary: 'Summary', depth: 3 };
  } };
  assert.equal((await enrichPending(db, config, llm)).enriched, 1);
  assert.equal(db.prepare('SELECT duplicate_of FROM articles WHERE id=3').get().duplicate_of, 1);
  assertFlat(db);
});
