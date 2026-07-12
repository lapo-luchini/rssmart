import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tempDb, testConfig } from './helpers.js';
import {
  recomputeScores, recomputeOneScore, topicPrefs,
  scheduleRecompute, recomputeIfDue, clearScheduledRecompute,
} from '../src/scoring.js';
import { openDb } from '../src/db.js';

const vecBuf = (...values) => Buffer.from(Float16Array.from(values).buffer);

function seed(db, articles) {
  db.prepare("INSERT INTO feeds (id, url) VALUES (1, 'http://f')").run();
  const insArt = db.prepare(
    "INSERT INTO articles (feed_id, guid, title, vote) VALUES (1, ?, ?, ?)",
  );
  const insTopic = db.prepare(
    'INSERT INTO topics (name) VALUES (?) ON CONFLICT (name) DO UPDATE SET name = name RETURNING id',
  );
  const link = db.prepare(
    'INSERT INTO article_topics (article_id, topic_id) VALUES (?, ?)',
  );
  const ids = {};
  for (const a of articles) {
    const { lastInsertRowid } = insArt.run(`g-${a.title}`, a.title, a.vote ?? 0);
    ids[a.title] = Number(lastInsertRowid);
    for (const t of a.topics ?? []) link.run(lastInsertRowid, insTopic.get(t).id);
  }
  return ids;
}

const score = (db, id) =>
  db.prepare('SELECT score FROM articles WHERE id = ?').get(id).score;

test('no votes -> neutral preference and zero scores', async () => {
  const db = tempDb();
  const ids = seed(db, [{ title: 'a', topics: ['tech'] }, { title: 'b' }]);
  const result = await recomputeScores(db, testConfig());
  assert.equal(score(db, ids.a), 0);
  assert.equal(score(db, ids.b), 0, 'topicless article scores 0');
  assert.equal(topicPrefs(db)[0].pref, 0);
  assert.equal(result.count, 2, 'reports how many articles it scored');
  assert.ok(result.ms >= 0, 'reports how long it took');
});

test('upvotes raise topic preference with Laplace smoothing', async () => {
  const db = tempDb();
  const ids = seed(db, [
    { title: 'a', topics: ['tech'], vote: 1 },
    { title: 'b', topics: ['tech'] },
  ]);
  await recomputeScores(db, testConfig());
  // pref = (1+1)/(1+0+2)*2-1 = 1/3
  assert.ok(Math.abs(score(db, ids.b) - 1 / 3) < 1e-9);
  const [tech] = topicPrefs(db);
  assert.deepEqual(
    { name: tech.name, up: tech.up, down: tech.down },
    { name: 'tech', up: 1, down: 0 },
  );
  assert.ok(Math.abs(tech.pref - 1 / 3) < 1e-9);
});

test('downvotes lower preference; multi-topic articles average', async () => {
  const db = tempDb();
  const ids = seed(db, [
    { title: 'liked', topics: ['tech'], vote: 1 },
    { title: 'hated', topics: ['sports'], vote: -1 },
    { title: 'mixed', topics: ['tech', 'sports'] },
  ]);
  await recomputeScores(db, testConfig());
  // tech pref = 1/3, sports pref = -1/3 -> mixed averages to 0
  assert.ok(Math.abs(score(db, ids.mixed)) < 1e-9);

  // Flipping the sports vote to +1 makes both topics positive.
  db.prepare("UPDATE articles SET vote = 1 WHERE title = 'hated'").run();
  await recomputeScores(db, testConfig());
  assert.ok(Math.abs(score(db, ids.mixed) - 1 / 3) < 1e-9);
});

test('blended score combines topics, embedding kNN, depth and feed', async () => {
  const db = tempDb();
  const ids = seed(db, [
    { title: 'liked', topics: ['tech'], vote: 1 },
    { title: 'candidate', topics: ['tech'] },
    { title: 'unrelated' },
  ]);
  db.prepare('UPDATE articles SET text_embedding = ? WHERE id = ?')
    .run(vecBuf(1, 0), ids.liked);
  db.prepare('UPDATE articles SET text_embedding = ?, depth = 5 WHERE id = ?')
    .run(vecBuf(1, 0), ids.candidate);
  db.prepare('UPDATE articles SET text_embedding = ?, depth = 1 WHERE id = ?')
    .run(vecBuf(0, 1), ids.unrelated);

  const config = testConfig();
  config.scoring.weights = { topics: 0.4, embedding: 0.3, depth: 0.2, feed: 0.1 };
  await recomputeScores(db, config);

  const parts = (id) => db.prepare(`
    SELECT score, score_topics, score_embedding, score_depth, score_feed
    FROM articles WHERE id = ?
  `).get(id);
  const near = (x, y) => assert.ok(Math.abs(x - y) < 1e-9, `${x} != ${y}`);

  // candidate: tech pref 1/3, identical embedding to the liked article
  // (kNN signal = vote/2 = 0.5), depth 5 -> +1, feed pref 1/3
  const c = parts(ids.candidate);
  near(c.score_topics, 0.4 / 3);
  near(c.score_embedding, 0.3 / 2);
  near(c.score_depth, 0.2);
  near(c.score_feed, 0.1 / 3);
  near(c.score, c.score_topics + c.score_embedding + c.score_depth + c.score_feed);

  // unrelated: no topics, orthogonal embedding, depth 1 -> -1, feed +1/3
  const u = parts(ids.unrelated);
  near(u.score_topics, 0);
  near(u.score_embedding, 0);
  near(u.score_depth, -0.2);
  near(u.score_feed, 0.1 / 3);

  // the voted article itself is excluded from its own kNN neighborhood
  const l = parts(ids.liked);
  near(l.score_embedding, 0);

  // a WOW vote (+2) counts double everywhere: pref (2+1)/(2+2)*2-1 = 0.5,
  // kNN signal 2/2 = 1
  db.prepare('UPDATE articles SET vote = 2 WHERE id = ?').run(ids.liked);
  await recomputeScores(db, config);
  const c2 = parts(ids.candidate);
  near(c2.score_topics, 0.4 * 0.5);
  near(c2.score_embedding, 0.3);
});

test('embedding kNN keeps only the k nearest voted articles, not the whole voted set', async () => {
  const db = tempDb();
  const ids = seed(db, [
    { title: 'v1', vote: 2 },  // WOW up -> vote/2 = 1
    { title: 'v2', vote: -2 }, // WOW down -> vote/2 = -1
    { title: 'v3', vote: 1 },
    { title: 'v4', vote: 1 },
    { title: 'v5', vote: 1 },  // similarity clamps to 0 - excluded either way
    { title: 'candidate' },
  ]);
  const cos = (deg) => {
    const rad = (deg * Math.PI) / 180;
    return vecBuf(Math.cos(rad), Math.sin(rad));
  };
  db.prepare('UPDATE articles SET text_embedding = ? WHERE id = ?').run(cos(0), ids.candidate);
  db.prepare('UPDATE articles SET text_embedding = ? WHERE id = ?').run(cos(0), ids.v1);   // sim 1
  db.prepare('UPDATE articles SET text_embedding = ? WHERE id = ?').run(cos(30), ids.v2);  // sim ~0.866
  db.prepare('UPDATE articles SET text_embedding = ? WHERE id = ?').run(cos(60), ids.v3);  // sim 0.5
  db.prepare('UPDATE articles SET text_embedding = ? WHERE id = ?').run(cos(90), ids.v4);  // sim 0
  db.prepare('UPDATE articles SET text_embedding = ? WHERE id = ?').run(cos(180), ids.v5); // sim -1 -> 0

  const config = testConfig();
  config.scoring.weights = { topics: 0, embedding: 1, depth: 0, feed: 0 };
  config.scoring.knn = 2; // fewer than the 5 voted articles - forces top-k truncation
  await recomputeScores(db, config);

  const embScore = db.prepare('SELECT score_embedding FROM articles WHERE id = ?').get(ids.candidate).score_embedding;
  // only v1 (sim 1) and v2 (sim ~0.866) survive the k=2 cutoff - v3/v4/v5 must
  // be excluded even though they'd otherwise contribute to the weighted average
  const sim1 = 1;
  const sim2 = Math.cos((30 * Math.PI) / 180);
  const expected = (sim1 * 1 + sim2 * -1) / (sim1 + sim2);
  assert.ok(Math.abs(embScore - expected) < 1e-3, `expected ~${expected}, got ${embScore}`);
});

test('embedding kNN tie at the k-th cutoff keeps the earlier-inserted (lower id) voted article', async () => {
  const db = tempDb();
  const ids = seed(db, [
    { title: 'first', vote: 2 },  // inserted first, tied similarity
    { title: 'second', vote: -2 }, // inserted second, same similarity as "first"
    { title: 'candidate' },
  ]);
  const vec = vecBuf(1, 0);
  db.prepare('UPDATE articles SET text_embedding = ? WHERE id = ?').run(vec, ids.candidate);
  db.prepare('UPDATE articles SET text_embedding = ? WHERE id = ?').run(vec, ids.first);
  db.prepare('UPDATE articles SET text_embedding = ? WHERE id = ?').run(vec, ids.second);

  const config = testConfig();
  config.scoring.weights = { topics: 0, embedding: 1, depth: 0, feed: 0 };
  config.scoring.knn = 1; // only room for one of the two identical-similarity votes
  await recomputeScores(db, config);

  const embScore = db.prepare('SELECT score_embedding FROM articles WHERE id = ?').get(ids.candidate).score_embedding;
  // "first" (vote/2 = 1) wins the tie over "second" (vote/2 = -1) - matching
  // voted's original (insertion) order, the same tie-break a stable sort on
  // {sim, vote} pairs would have produced.
  assert.ok(Math.abs(embScore - 1) < 1e-9, `expected 1 (first's vote wins the tie), got ${embScore}`);
});

test('recomputeOneScore matches a full recomputeScores for that one article, and touches nothing else', async () => {
  const db = tempDb();
  const ids = seed(db, [
    { title: 'liked', topics: ['tech'], vote: 1 },
    { title: 'candidate', topics: ['tech'] },
    { title: 'other', topics: ['tech'] },
  ]);
  db.prepare('UPDATE articles SET text_embedding = ? WHERE id = ?')
    .run(vecBuf(1, 0), ids.liked);
  db.prepare('UPDATE articles SET text_embedding = ?, depth = 5 WHERE id = ?')
    .run(vecBuf(1, 0), ids.candidate);
  db.prepare('UPDATE articles SET text_embedding = ?, depth = 3 WHERE id = ?')
    .run(vecBuf(1, 0), ids.other);

  const config = testConfig();
  config.scoring.weights = { topics: 0.4, embedding: 0.3, depth: 0.2, feed: 0.1 };
  const parts = (id) => db.prepare(`
    SELECT score, score_topics, score_embedding, score_depth, score_feed
    FROM articles WHERE id = ?
  `).get(id);

  await recomputeScores(db, config);
  const groundTruth = parts(ids.candidate);
  const otherBefore = parts(ids.other);
  assert.ok(groundTruth.score !== 0, 'sanity: candidate has a non-trivial score to reproduce');

  // scramble candidate's stored score, leave everything else untouched
  db.prepare(`
    UPDATE articles SET score = -99, score_topics = -99, score_embedding = -99,
    score_depth = -99, score_feed = -99 WHERE id = ?
  `).run(ids.candidate);

  recomputeOneScore(db, config, ids.candidate);
  assert.deepEqual(parts(ids.candidate), groundTruth, 'scoped recompute reproduces the full sweep\'s result');
  assert.deepEqual(parts(ids.other), otherBefore, 'recomputeOneScore never touches other articles');
});

test('scheduleRecompute + recomputeIfDue: debounced, and survives a process restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rssmart-debounce-'));
  const dbPath = join(dir, 'test.db');
  const config = testConfig();

  let db = openDb(dbPath);
  seed(db, [{ title: 'a', topics: ['tech'], vote: 1 }, { title: 'b', topics: ['tech'] }]);

  // scheduled far in the future: not due yet
  scheduleRecompute(db, 3600);
  assert.equal(await recomputeIfDue(db, config), false, 'not due yet');
  assert.equal(score(db, seedTitleId(db, 'b')), 0, 'no recompute happened');

  // force it overdue directly (bypassing the public API's positive-delay
  // convention, which has no "already elapsed" case of its own)
  db.prepare(`
    UPDATE meta SET value = '2000-01-01T00:00:00Z' WHERE key = 'score_recompute_due_at'
  `).run();
  db.close();

  // reopen a fresh connection to the same file — simulates an app restart;
  // the pending due-marker must not have been an in-memory-only timer
  db = openDb(dbPath);
  const result = await recomputeIfDue(db, config);
  assert.ok(result, 'overdue work runs on the next check after "restart"');
  assert.equal(result.count, 2, 'reports how many articles it scored');
  assert.ok(result.ms >= 0, 'reports how long it took');
  assert.ok(Math.abs(score(db, seedTitleId(db, 'b')) - 1 / 3) < 1e-9, 'the deferred recompute actually ran');

  // due-marker is cleared after running: nothing left to do
  assert.equal(await recomputeIfDue(db, config), false, 'idempotent: nothing pending after it already ran');

  // clearScheduledRecompute cancels a still-pending (not yet due) marker
  scheduleRecompute(db, 3600);
  clearScheduledRecompute(db);
  assert.equal(await recomputeIfDue(db, config), false, 'cleared marker never fires');

  db.close();
});

test('recomputeScores yields to the event loop between chunks, never blocking it for the full run', async () => {
  const db = tempDb();
  // Enough rows that, with yieldEveryMs forced to 0 (yield after every
  // single row), several yields happen before the sweep finishes - one
  // yield wouldn't distinguish "yields once, then blocks anyway" from a
  // genuinely non-blocking sweep.
  seed(db, Array.from({ length: 20 }, (_, i) => ({
    title: `t${i}`, topics: ['tech'], vote: i % 2 === 0 ? 1 : -1,
  })));

  let sideEffectRan = false;
  const swept = recomputeScores(db, testConfig(), { yieldEveryMs: 0 }).then(() => 'swept');
  const marker = new Promise((resolve) => setTimeout(() => {
    sideEffectRan = true;
    resolve('marker');
  }, 0));

  const winner = await Promise.race([swept, marker]);
  assert.equal(winner, 'marker', 'an independent timer ran before the full sweep finished');
  assert.ok(sideEffectRan);
  await swept; // let the sweep actually finish before the db closes
});

function seedTitleId(db, title) {
  return db.prepare('SELECT id FROM articles WHERE title = ?').get(title).id;
}
