import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { databaseVersion } from '../src/dbVersion.js';
import { recomputeScores, recomputeOneScore, topicPrefs } from '../src/scoring.js';
import { tempDb, testConfig } from './helpers.js';

const blob = (values) => Buffer.from(Float16Array.from(values).buffer);
const embeddingConfig = () => {
  const config = testConfig();
  config.scoring.weights = { topics: 0, embedding: 1, depth: 0, feed: 0 };
  return config;
};
function seed(db, { id = 1, vote = 0, vec = [1, 0], topic = null } = {}) {
  db.prepare("INSERT OR IGNORE INTO feeds (id, url) VALUES (1, 'https://example.invalid')").run();
  db.prepare(`INSERT INTO articles
    (id, feed_id, guid, title, vote, voted_at, status, text_embedding)
    VALUES (?, 1, ?, 'Article', ?, '2026-01-01T00:00:00Z', 'enriched', ?)
  `).run(id, String(id), vote, blob(vec));
  if (topic) {
    const row = db.prepare('INSERT INTO topics (name) VALUES (?) RETURNING id').get(topic);
    db.prepare('INSERT INTO article_topics (article_id, topic_id) VALUES (?, ?)').run(id, row.id);
  }
}
const score = (db, id) => db.prepare('SELECT score_embedding AS value FROM articles WHERE id = ?').get(id).value;
const closeAfter = (t, db = tempDb()) => { t.after(() => db.close()); return db; };

test('databaseVersion changes after local writes and external commits, but not plain reads', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rssmart-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'test.db'));
  const other = openDb(join(dir, 'test.db'));
  t.after(() => { other.close(); db.close(); });
  const initial = databaseVersion(db);
  assert.equal(databaseVersion(db), initial);
  seed(db);
  const local = databaseVersion(db);
  assert.notEqual(local, initial);
  other.prepare('UPDATE articles SET vote = 1 WHERE id = 1').run();
  assert.notEqual(databaseVersion(db), local);
});

test('topic preferences reflect every vote transition without changing voted row count', (t) => {
  const db = closeAfter(t);
  seed(db, { topic: 'subject' });
  for (const vote of [0, 1, 2, -1, 0]) {
    db.prepare('UPDATE articles SET vote = ? WHERE id = 1').run(vote);
    const [row] = topicPrefs(db);
    assert.ok(Math.abs(row.pref - vote / (Math.abs(vote) + 2)) < 1e-12);
    assert.equal(row.up_raw, Math.max(vote, 0));
    assert.equal(row.down_raw, Math.max(-vote, 0));
  }
});

test('topic preference caches stay isolated across equally sized databases', (t) => {
  const a = closeAfter(t), b = closeAfter(t);
  seed(a, { vote: 1, topic: 'database-a' });
  seed(b, { vote: -1, topic: 'database-b' });
  const first = topicPrefs(a);
  assert.equal(topicPrefs(b)[0].name, 'database-b');
  assert.ok(topicPrefs(b)[0].pref < 0);
  assert.strictEqual(topicPrefs(a), first);
});

test('topic cache observes another connection changing a vote', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rssmart-topic-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'test.db')), other = openDb(join(dir, 'test.db'));
  t.after(() => { other.close(); db.close(); });
  seed(db, { vote: 1, topic: 'subject' });
  assert.ok(topicPrefs(db)[0].pref > 0);
  other.prepare('UPDATE articles SET vote = -1 WHERE id = 1').run();
  assert.ok(topicPrefs(db)[0].pref < 0);
});

test('decayed topic statistics expire with time even when data does not change', (t) => {
  const db = closeAfter(t);
  seed(db, { vote: 1, topic: 'subject' });
  let now = Date.parse('2026-09-20T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const first = topicPrefs(db, null, 1);
  assert.strictEqual(topicPrefs(db, null, 1), first);
  now += 1000;
  assert.notStrictEqual(topicPrefs(db, null, 1), first);
});

test('a same-size voted embedding replacement changes the next full sweep', async (t) => {
  const db = closeAfter(t), config = embeddingConfig();
  seed(db, { vote: 1 }); seed(db, { id: 2 });
  await recomputeScores(db, config);
  assert.equal(score(db, 2), 0.5);
  db.prepare('UPDATE articles SET text_embedding = ? WHERE id = 1').run(blob([0, 1]));
  await recomputeScores(db, config);
  assert.equal(score(db, 2), 0);
});

test('equal-sum vote swaps with identical timestamps invalidate the voted snapshot', async (t) => {
  const db = closeAfter(t), config = embeddingConfig();
  seed(db, { vote: 1 }); seed(db, { id: 2, vote: -1, vec: [0, 1] }); seed(db, { id: 3 });
  await recomputeScores(db, config);
  assert.equal(score(db, 3), 0.5);
  db.prepare('UPDATE articles SET vote = -vote WHERE vote != 0').run();
  await recomputeScores(db, config);
  assert.equal(score(db, 3), -0.5);
});

test('another connection replacing a voted vector invalidates single-article scoring', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rssmart-voted-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'test.db')), other = openDb(join(dir, 'test.db'));
  t.after(() => { other.close(); db.close(); });
  const config = embeddingConfig();
  seed(db, { vote: 1 }); seed(db, { id: 2 });
  recomputeOneScore(db, config, 2);
  assert.equal(score(db, 2), 0.5);
  other.prepare('UPDATE articles SET text_embedding = ? WHERE id = 1').run(blob([0, 1]));
  recomputeOneScore(db, config, 2);
  assert.equal(score(db, 2), 0);
});

test('vote decay advances by one half-life with a warm vector cache', async (t) => {
  const db = closeAfter(t), config = embeddingConfig();
  config.scoring.voteDecayHalflifeYears = 1;
  seed(db, { vote: 1 }); seed(db, { id: 2 });
  let now = Date.parse('2026-01-01T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  await recomputeScores(db, config);
  assert.equal(score(db, 2), 0.5);
  now += 365.25 * 86400000;
  await recomputeScores(db, config);
  assert.ok(Math.abs(score(db, 2) - 0.25) < 1e-12);
  recomputeOneScore(db, config, 2);
  assert.ok(Math.abs(score(db, 2) - 0.25) < 1e-12);
});
