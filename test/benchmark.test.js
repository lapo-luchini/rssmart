import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tempDb } from './helpers.js';
import { selectDedupPairs, writePairManifest, requireDedupPairs, prefixDiagnostics } from '../scripts/bench-utils.js';

function fixture(t) {
  const db = tempDb();
  t.after(() => db.close());
  db.exec("INSERT INTO feeds (id, url) VALUES (1, 'https://one.invalid'), (2, 'https://two.invalid')");
  const insert = db.prepare(`
    INSERT INTO articles (id, feed_id, guid, title, summary, published_at, duplicate_of)
    VALUES (?, ?, ?, ?, 'summary', ?, ?)
  `);
  for (const [id, feed, root, date] of [
    [1, 1, null, '2026-09-01'], [2, 1, 1, '2026-09-02'], [3, 1, 1, '2026-09-03'],
    [4, 1, null, '2026-09-01'], [5, 1, 4, '2026-09-02'],
    [6, 2, null, '2026-09-01'], [7, 2, 6, '2026-09-02'],
    [8, 1, null, '2025-01-01'], [9, 1, 8, '2025-01-02'],
  ]) insert.run(id, feed, `guid-${id}`, `Article ${id}`, date, root);
  return db;
}

test('negative benchmark pairs exclude roots/children/siblings and are unique, same-feed and recent', (t) => {
  const db = fixture(t);
  const sample = selectDedupPairs(db);
  assert.deepEqual(sample.negatives, [[1, 4], [1, 5], [2, 4], [2, 5], [3, 4], [3, 5]]);
  assert.equal(sample.manifest.availableNegatives, 6);
  const positiveKeys = new Set(sample.positives.map((p) => [p.dup_id, p.root_id].sort((a, b) => a - b).join(':')));
  assert.ok(sample.negatives.every((p) => !positiveKeys.has(p.join(':'))));
  assert.equal(new Set(sample.negatives.map((p) => p.join(':'))).size, sample.negatives.length);
  requireDedupPairs(sample);
});

test('seeded pair selection and its persisted manifest reproduce exactly', (t) => {
  const db = fixture(t);
  const opts = { positiveCount: 5, negativeCount: 3, seed: 31 };
  const first = selectDedupPairs(db, opts);
  const second = selectDedupPairs(db, opts);
  assert.deepEqual(first, second);
  assert.equal(first.negatives.length, 3);
  const dir = mkdtempSync(join(tmpdir(), 'rssmart-pairs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = writePairManifest(dir, first);
  assert.deepEqual(JSON.parse(readFileSync(path)), first.manifest);
  assert.notEqual(writePairManifest(dir, second), path, 'separate runs never overwrite a manifest');
});

test('empty samples terminate and malformed group ancestry fails instead of creating false negatives', (t) => {
  const db = fixture(t);
  const empty = selectDedupPairs(db, { positiveCount: 0 });
  assert.deepEqual(empty.articles, []);
  assert.deepEqual(empty.negatives, []);
  assert.throws(() => requireDedupPairs(empty), /sample is insufficient/);
  db.exec('UPDATE articles SET duplicate_of = 2 WHERE id = 3');
  assert.throws(() => selectDedupPairs(db), /requires flat duplicate groups/);
});

test('negative/noninteger/nonfinite sample sizes are rejected before selection', (t) => {
  const db = fixture(t);
  for (const positiveCount of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => selectDedupPairs(db, { positiveCount }), /nonnegative safe integers/);
  }
  assert.throws(() => selectDedupPairs(db, { windowDays: NaN }), /finite and nonnegative/);
});

test('prefix energy can differ while returned short vectors agree perfectly with each prefix', () => {
  const shorter = [1 / Math.sqrt(5), 2 / Math.sqrt(5)];
  const low = prefixDiagnostics([0.1, 0.2, Math.sqrt(0.95), 0], shorter);
  const high = prefixDiagnostics([0.4, 0.8, Math.sqrt(0.2), 0], shorter);
  assert.ok(Math.abs(low.retainedEnergy - 0.05) < 1e-12);
  assert.ok(Math.abs(high.retainedEnergy - 0.8) < 1e-12);
  for (const value of [low, high]) {
    assert.ok(Math.abs(value.prefixCosine - 1) < 1e-12);
    assert.ok(Math.abs(value.paddedCosine - Math.sqrt(value.retainedEnergy)) < 1e-12);
  }
  assert.throws(() => prefixDiagnostics([1], [1, 0]), /dimensions/);
  assert.throws(() => prefixDiagnostics([0, 1], [1]), /zero vector or prefix/);
  assert.throws(() => prefixDiagnostics([Infinity], [1]), /non-finite/);
});
