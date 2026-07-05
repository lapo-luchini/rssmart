import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, testConfig } from './helpers.js';
import { createApp } from '../src/server.js';
import { recomputeScores } from '../src/scoring.js';

let db;
let base;
let server;
let ids;

function seed() {
  db.prepare("INSERT INTO feeds (id, url, title) VALUES (1, 'http://f', 'Feed One')").run();
  const insArt = db.prepare(`
    INSERT INTO articles (feed_id, guid, title, content, summary, status,
                          published_at, vote, read_at, duplicate_of)
    VALUES (1, @guid, @title, @content, @summary, 'enriched',
            @published_at, @vote, @read_at, @duplicate_of)
  `);
  const insTopic = db.prepare('INSERT INTO topics (name) VALUES (?) RETURNING id');
  const link = db.prepare('INSERT INTO article_topics VALUES (?, ?)');

  const tech = insTopic.get('tech').id;
  const sports = insTopic.get('sports').id;

  const base = {
    content: 'body', summary: 'sum', vote: 0, read_at: null, duplicate_of: null,
  };
  const out = {};
  out.liked = Number(insArt.run({ ...base, guid: 'g1', title: 'Liked tech story', published_at: '2026-07-01T00:00:00Z', vote: 1 }).lastInsertRowid);
  link.run(out.liked, tech);
  out.fresh = Number(insArt.run({ ...base, guid: 'g2', title: 'Fresh tech story', published_at: '2026-07-03T00:00:00Z' }).lastInsertRowid);
  link.run(out.fresh, tech);
  out.sporty = Number(insArt.run({ ...base, guid: 'g3', title: 'Sports story', published_at: '2026-07-04T00:00:00Z' }).lastInsertRowid);
  link.run(out.sporty, sports);
  out.readOne = Number(insArt.run({ ...base, guid: 'g4', title: 'Already read', published_at: '2026-07-02T00:00:00Z', read_at: '2026-07-02T10:00:00Z' }).lastInsertRowid);
  out.dupe = Number(insArt.run({ ...base, guid: 'g5', title: 'Fresh tech story (copy)', published_at: '2026-07-03T01:00:00Z', duplicate_of: out.fresh }).lastInsertRowid);
  recomputeScores(db);
  return out;
}

before(async () => {
  db = tempDb();
  ids = seed();
  const app = createApp(db, testConfig());
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const get = async (path) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
};
const post = async (path, payload) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
};

test('default view: unread, no dupes, sorted by score then date', async () => {
  const { status, body } = await get('/api/articles');
  assert.equal(status, 200);
  const titles = body.articles.map((a) => a.title);
  // liked(read? no) has vote=1 & tech pref 2/3... fresh shares tech topic ->
  // both score alike; sports has neutral 0. Read + duplicate are excluded.
  assert.deepEqual(titles, ['Fresh tech story', 'Liked tech story', 'Sports story']);
  assert.equal(body.total, 3);
  assert.deepEqual(body.articles[0].topics, ['tech']);
  assert.equal(body.articles[0].feed_title, 'Feed One');
});

test('view=all with dupes=1 returns everything, date sorted', async () => {
  const { body } = await get('/api/articles?view=all&dupes=1&sort=date');
  assert.equal(body.total, 5);
  assert.equal(body.articles[0].title, 'Sports story');
});

test('topic, feed, search filters', async () => {
  const byTopic = await get('/api/articles?view=all&topic=sports');
  assert.deepEqual(byTopic.body.articles.map((a) => a.title), ['Sports story']);

  const byFeed = await get('/api/articles?view=all&feed_id=1');
  assert.equal(byFeed.body.total, 4, 'dupes still hidden by default');

  const byQ = await get('/api/articles?view=all&q=Already');
  assert.deepEqual(byQ.body.articles.map((a) => a.title), ['Already read']);
});

test('article detail includes content; unknown id -> 404', async () => {
  const ok = await get(`/api/articles/${ids.fresh}`);
  assert.equal(ok.body.content, 'body');
  const missing = await get('/api/articles/99999');
  assert.equal(missing.status, 404);
});

test('voting validates input, persists and recomputes scores', async () => {
  const bad = await post(`/api/articles/${ids.sporty}/vote`, { vote: 5 });
  assert.equal(bad.status, 400);

  const before = (await get(`/api/articles/${ids.sporty}`)).body.score;
  assert.equal(before, 0);
  const { status, body } = await post(`/api/articles/${ids.sporty}/vote`, { vote: 1 });
  assert.equal(status, 200);
  assert.equal(body.vote, 1);
  assert.ok(body.score > 0, 'sports preference rose after upvote');

  await post(`/api/articles/${ids.sporty}/vote`, { vote: 0 }); // restore
});

test('read toggling', async () => {
  const on = await post(`/api/articles/${ids.fresh}/read`, { read: true });
  assert.ok(on.body.read_at);
  const list = await get('/api/articles');
  assert.ok(!list.body.articles.some((a) => a.id === ids.fresh));
  const off = await post(`/api/articles/${ids.fresh}/read`, { read: false });
  assert.equal(off.body.read_at, null);
});

test('topics, feeds and stats endpoints', async () => {
  const topics = await get('/api/topics');
  const tech = topics.body.find((t) => t.name === 'tech');
  assert.equal(tech.up, 1);
  assert.ok(tech.pref > 0);

  const feeds = await get('/api/feeds');
  assert.equal(feeds.body[0].articles, 5);

  const stats = await get('/api/stats');
  assert.deepEqual(
    { total: stats.body.total, duplicates: stats.body.duplicates },
    { total: 5, duplicates: 1 },
  );
});
