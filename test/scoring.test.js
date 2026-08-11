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

test('topicPrefs marks which topics are within the LLM-suggested cap, matching existingTopicNames exactly', () => {
  const db = tempDb();
  seed(db, [
    { title: 'a1', topics: ['popular'] },
    { title: 'a2', topics: ['popular'] },
    { title: 'a3', topics: ['popular'] },
    { title: 'b1', topics: ['medium'] },
    { title: 'b2', topics: ['medium'] },
    { title: 'c1', topics: ['rare'] },
  ]);

  const withCap = topicPrefs(db, 2); // only the top 2 most-used topics fit
  const byName = Object.fromEntries(withCap.map((t) => [t.name, t.suggested]));
  assert.deepEqual(byName, { popular: true, medium: true, rare: false });

  const uncapped = topicPrefs(db); // maxSuggested falsy -> field omitted entirely
  assert.ok(uncapped.every((t) => !('suggested' in t)), 'no cap given -> no suggested field at all');
});

test('topicPrefs computes the suggested-topics lookup once, not once per topic row', () => {
  // Regression: the "suggested" field used to call existingTopicNames()
  // (its own topics/article_topics aggregation query) inside rows.map(),
  // once per topic — a 552-topic real-world corpus measured this at
  // ~42ms x 552 = ~23s of pure duplicate work, on top of any indexing.
  // Counting matching prepare() calls, not timing, since timing is too
  // flaky to assert on in a test.
  const db = tempDb();
  seed(db, Array.from({ length: 30 }, (_, i) => ({ title: `t${i}`, topics: [`topic${i}`] })));

  const rawPrepare = db.prepare.bind(db);
  let existingTopicNamesCalls = 0;
  db.prepare = (sql) => {
    // existingTopicNames selects only t.name (no articles join); the
    // main aggregation query selects t.id, t.name and joins articles —
    // this pattern is unique to existingTopicNames' own query.
    if (/SELECT t\.name FROM topics/.test(sql)) existingTopicNamesCalls++;
    return rawPrepare(sql);
  };

  const rows = topicPrefs(db, 10);
  assert.equal(rows.length, 30);
  assert.equal(existingTopicNamesCalls, 1, "existingTopicNames' query ran once total, not once per topic row");
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

  // candidate: tech pref 1/3 blended 70/30 with topic-neighbor signal
  // (identical embedding + same topic as liked → neighbor vote/2 = 0.5),
  // anti-kNN up pass (same vec → sim=1, value=0.5), depth 5 → +1, feed pref 1/3
  const topicBase = 1 / 3;
  const topicNeighbor = 0.5;
  const blendedTopic = topicBase * 0.7 + topicNeighbor * 0.3;
  const c = parts(ids.candidate);
  near(c.score_topics, 0.4 * blendedTopic);
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

  // a WOW vote (+2) counts double: pref (2+1)/(2+2)*2-1 = 0.5,
  // topic-neighbor signal = 2/2 = 1, blended 70/30 = 0.5*0.7+1*0.3 = 0.65
  db.prepare('UPDATE articles SET vote = 2 WHERE id = ?').run(ids.liked);
  await recomputeScores(db, config);
  const c2 = parts(ids.candidate);
  near(c2.score_topics, 0.4 * (0.5 * 0.7 + 1 * 0.3));
  near(c2.score_embedding, 0.3);
});

test('score_novelty: 1 - highest similarity to any voted article, null when there\'s no basis', async () => {
  const db = tempDb();
  const ids = seed(db, [
    { title: 'liked', vote: 1 },
    { title: 'same-as-liked' },
    { title: 'orthogonal-to-liked' },
    { title: 'no-embedding-yet' },
  ]);
  db.prepare('UPDATE articles SET text_embedding = ? WHERE id = ?').run(vecBuf(1, 0), ids.liked);
  db.prepare('UPDATE articles SET text_embedding = ? WHERE id = ?').run(vecBuf(1, 0), ids['same-as-liked']);
  db.prepare('UPDATE articles SET text_embedding = ? WHERE id = ?').run(vecBuf(0, 1), ids['orthogonal-to-liked']);

  await recomputeScores(db, testConfig());
  const novelty = (id) => db.prepare('SELECT score_novelty FROM articles WHERE id = ?').get(id).score_novelty;
  const near = (x, y) => assert.ok(Math.abs(x - y) < 1e-9, `${x} != ${y}`);

  near(novelty(ids['same-as-liked']), 0, 'identical to a voted article -> not novel at all');
  near(novelty(ids['orthogonal-to-liked']), 1, 'nothing in common with anything voted -> maximally novel');
  assert.equal(novelty(ids['no-embedding-yet']), null, 'no embedding yet -> no basis to judge novelty');
  near(novelty(ids.liked), 0, "a voted article's nearest voted neighbor is itself (sim=1) -- trivially not novel, unlike score_embedding which excludes self");
});

test('score_novelty stays null for everyone when nothing has been voted on yet', async () => {
  const db = tempDb();
  const ids = seed(db, [{ title: 'a' }, { title: 'b' }]);
  db.prepare('UPDATE articles SET text_embedding = ? WHERE id = ?').run(vecBuf(1, 0), ids.a);
  db.prepare('UPDATE articles SET text_embedding = ? WHERE id = ?').run(vecBuf(0, 1), ids.b);

  await recomputeScores(db, testConfig());
  const novelty = (id) => db.prepare('SELECT score_novelty FROM articles WHERE id = ?').get(id).score_novelty;
  assert.equal(novelty(ids.a), null);
  assert.equal(novelty(ids.b), null);
});

test('embedding anti-kNN: separate up/down passes, each limited to k', async () => {
  const db = tempDb();
  const ids = seed(db, [
    { title: 'v1', vote: 2 },  // WOW up -> abs/2 = 1
    { title: 'v2', vote: -2 }, // WOW down -> abs/2 = 1
    { title: 'v3', vote: 1 },
    { title: 'v4', vote: 1 },
    { title: 'v5', vote: 1 },  // similarity clamps to 0 — excluded either way
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
  config.scoring.knn = 2; // each polarity gets its own k=2 limit
  await recomputeScores(db, config);

  const embScore = db.prepare('SELECT score_embedding FROM articles WHERE id = ?').get(ids.candidate).score_embedding;
  // up pass: v1 (sim 1, abs/2=1) and v3 (sim 0.5, abs/2=0.5) surviving k=2
  // down pass: v2 (sim ~0.866, abs/2=1) alone (k=2 but only 1 downvote)
  const sim1 = 1, sim2 = Math.cos((30 * Math.PI) / 180), sim3 = 0.5;
  const up = (sim1 * 1 + sim3 * 0.5) / (sim1 + sim3);
  const down = sim2 * 1 / sim2;
  const expected = Math.max(-1, Math.min(1, up - down));
  assert.ok(Math.abs(embScore - expected) < 1e-3, `expected ~${expected}, got ${embScore}`);
});

test('anti-kNN: up and down passes are independent — tied similarity does not starve either polarity', async () => {
  const db = tempDb();
  const ids = seed(db, [
    { title: 'first', vote: 2 },   // up, abs/2 = 1
    { title: 'second', vote: -2 },  // down, abs/2 = 1
    { title: 'candidate' },
  ]);
  const vec = vecBuf(1, 0);
  db.prepare('UPDATE articles SET text_embedding = ? WHERE id = ?').run(vec, ids.candidate);
  db.prepare('UPDATE articles SET text_embedding = ? WHERE id = ?').run(vec, ids.first);
  db.prepare('UPDATE articles SET text_embedding = ? WHERE id = ?').run(vec, ids.second);

  const config = testConfig();
  config.scoring.weights = { topics: 0, embedding: 1, depth: 0, feed: 0 };
  config.scoring.knn = 1; // each polarity gets its own k=1
  await recomputeScores(db, config);

  const embScore = db.prepare('SELECT score_embedding FROM articles WHERE id = ?').get(ids.candidate).score_embedding;
  // up pass picks "first" (sim=1), down pass picks "second" (sim=1)
  // anti-kNN = 1 − 1 = 0 — neither polarity dominates, they cancel
  assert.ok(Math.abs(embScore) < 1e-9, `expected 0 (up-down cancel), got ${embScore}`);
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
