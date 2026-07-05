import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, testConfig } from './helpers.js';
import { recomputeScores, topicPrefs } from '../src/scoring.js';

const vecBuf = (...values) => Buffer.from(Float32Array.from(values).buffer);

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

test('no votes -> neutral preference and zero scores', () => {
  const db = tempDb();
  const ids = seed(db, [{ title: 'a', topics: ['tech'] }, { title: 'b' }]);
  recomputeScores(db, testConfig());
  assert.equal(score(db, ids.a), 0);
  assert.equal(score(db, ids.b), 0, 'topicless article scores 0');
  assert.equal(topicPrefs(db)[0].pref, 0);
});

test('upvotes raise topic preference with Laplace smoothing', () => {
  const db = tempDb();
  const ids = seed(db, [
    { title: 'a', topics: ['tech'], vote: 1 },
    { title: 'b', topics: ['tech'] },
  ]);
  recomputeScores(db, testConfig());
  // pref = (1+1)/(1+0+2)*2-1 = 1/3
  assert.ok(Math.abs(score(db, ids.b) - 1 / 3) < 1e-9);
  const [tech] = topicPrefs(db);
  assert.deepEqual(
    { name: tech.name, up: tech.up, down: tech.down },
    { name: 'tech', up: 1, down: 0 },
  );
  assert.ok(Math.abs(tech.pref - 1 / 3) < 1e-9);
});

test('downvotes lower preference; multi-topic articles average', () => {
  const db = tempDb();
  const ids = seed(db, [
    { title: 'liked', topics: ['tech'], vote: 1 },
    { title: 'hated', topics: ['sports'], vote: -1 },
    { title: 'mixed', topics: ['tech', 'sports'] },
  ]);
  recomputeScores(db, testConfig());
  // tech pref = 1/3, sports pref = -1/3 -> mixed averages to 0
  assert.ok(Math.abs(score(db, ids.mixed)) < 1e-9);

  // Flipping the sports vote to +1 makes both topics positive.
  db.prepare("UPDATE articles SET vote = 1 WHERE title = 'hated'").run();
  recomputeScores(db, testConfig());
  assert.ok(Math.abs(score(db, ids.mixed) - 1 / 3) < 1e-9);
});

test('blended score combines topics, embedding kNN, depth and feed', () => {
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
  recomputeScores(db, config);

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
  recomputeScores(db, config);
  const c2 = parts(ids.candidate);
  near(c2.score_topics, 0.4 * 0.5);
  near(c2.score_embedding, 0.3);
});
