import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb } from './helpers.js';
import { recomputeScores, topicPrefs } from '../src/scoring.js';

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
  recomputeScores(db);
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
  recomputeScores(db);
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
  recomputeScores(db);
  // tech pref = 1/3, sports pref = -1/3 -> mixed averages to 0
  assert.ok(Math.abs(score(db, ids.mixed)) < 1e-9);

  // Flipping the sports vote to +1 makes both topics positive.
  db.prepare("UPDATE articles SET vote = 1 WHERE title = 'hated'").run();
  recomputeScores(db);
  assert.ok(Math.abs(score(db, ids.mixed) - 1 / 3) < 1e-9);
});
