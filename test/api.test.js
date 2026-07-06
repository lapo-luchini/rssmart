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
  // one unclassified article, marked read so unread-view assertions stay put
  out.pending = Number(db.prepare(`
    INSERT INTO articles (feed_id, guid, title, content, status, published_at, read_at)
    VALUES (1, 'g6', 'Awaiting classification', 'body', 'pending',
            '2026-06-30T00:00:00Z', '2026-06-30T10:00:00Z')
  `).run().lastInsertRowid);
  recomputeScores(db, testConfig());
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
  assert.equal(body.total, 6);
  assert.equal(body.articles[0].title, 'Sports story');
  const dupe = body.articles.find((a) => a.duplicate_of);
  assert.equal(dupe.duplicate_title, 'Fresh tech story', 'repeats carry the original title');
});

test('repeats are bundled: best of group shown, others via /versions', async () => {
  const { body } = await get('/api/articles?view=all');
  const fresh = body.articles.find((a) => a.id === ids.fresh);
  assert.ok(fresh, 'the higher-scoring member represents the group');
  assert.equal(fresh.versions, 2);
  assert.ok(!body.articles.some((a) => a.id === ids.dupe), 'the repeat is bundled away');

  const versions = await get(`/api/articles/${ids.fresh}/versions`);
  assert.deepEqual(versions.body.map((a) => a.id), [ids.dupe]);
  // works from the repeat's side too
  const fromDupe = await get(`/api/articles/${ids.dupe}/versions`);
  assert.deepEqual(fromDupe.body.map((a) => a.id), [ids.fresh]);

  const missing = await get('/api/articles/99999/versions');
  assert.equal(missing.status, 404);
});

test('status filter narrows to classified (or pending) articles', async () => {
  const enriched = await get('/api/articles?view=all&status=enriched');
  assert.equal(enriched.body.total, 4, 'pending article excluded');

  const pending = await get('/api/articles?view=all&status=pending');
  assert.deepEqual(pending.body.articles.map((a) => a.title), ['Awaiting classification']);

  const bad = await get('/api/articles?view=all&status=bogus');
  assert.equal(bad.status, 400);
});

test('topic, feed, search filters', async () => {
  const byTopic = await get('/api/articles?view=all&topic=sports');
  assert.deepEqual(byTopic.body.articles.map((a) => a.title), ['Sports story']);

  const byFeed = await get('/api/articles?view=all&feed_id=1');
  assert.equal(byFeed.body.total, 5, 'dupes still hidden by default');

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
  for (const vote of [5, -3, 1.5, '1']) {
    const bad = await post(`/api/articles/${ids.sporty}/vote`, { vote });
    assert.equal(bad.status, 400, `vote ${vote} rejected`);
  }

  const before = (await get(`/api/articles/${ids.sporty}`)).body.score;
  assert.equal(before, 0);
  const { status, body } = await post(`/api/articles/${ids.sporty}/vote`, { vote: 1 });
  assert.equal(status, 200);
  assert.equal(body.vote, 1);
  assert.ok(body.score > 0, 'sports preference rose after upvote');
  assert.ok('score_topics' in body && 'score_embedding' in body, 'components returned');

  const wow = await post(`/api/articles/${ids.sporty}/vote`, { vote: 2 });
  assert.ok(wow.body.score > body.score, 'a WOW vote outweighs a plain upvote');

  await post(`/api/articles/${ids.sporty}/vote`, { vote: 0 }); // restore
});

test('feed management: add, disable, stats, OPML round-trip', async () => {
  const added = await post('/api/feeds', { url: 'http://new.example/rss', title: 'New Feed' });
  assert.equal(added.status, 201);
  assert.equal(added.body.active, 1);

  const rejected = await post('/api/feeds', { url: 'ftp://nope' });
  assert.equal(rejected.status, 400);

  const disabled = await fetch(`${base}/api/feeds/${added.body.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ active: false }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  assert.equal(disabled.body.active, 0);

  const feeds = await get('/api/feeds');
  const feedOne = feeds.body.find((f) => f.title === 'Feed One');
  assert.equal(feedOne.articles, 6);
  assert.ok('ok_count' in feedOne && 'error_count' in feedOne && 'per_week' in feedOne);
  assert.ok('avg_vote' in feedOne);

  const imported = await post('/api/feeds/import', {
    opml: `<opml><body>
      <outline type="rss" text="Imported &amp; Co" xmlUrl="http://imported.example/rss" htmlUrl="http://imported.example/"/>
      <outline type="rss" text="XSS" xmlUrl="http://xss.example/rss" htmlUrl="javascript:alert(1)"/>
      <outline type="rss" xmlUrl="ftp://skip.me"/>
    </body></opml>`,
  });
  assert.deepEqual(imported.body, { found: 2 });

  const allFeeds = (await get('/api/feeds')).body;
  const feed = allFeeds.find((f) => f.url === 'http://imported.example/rss');
  assert.equal(feed.html_url, 'http://imported.example/', 'htmlUrl stored');
  const xss = allFeeds.find((f) => f.url === 'http://xss.example/rss');
  assert.equal(xss.html_url, null, 'javascript: htmlUrl dropped');

  const opml = await fetch(`${base}/api/feeds.opml`).then((r) => r.text());
  assert.match(opml, /xmlUrl="http:\/\/imported\.example\/rss"/);
  assert.match(opml, /htmlUrl="http:\/\/imported\.example\/"/);
  assert.match(opml, /Imported &amp; Co/);
  assert.ok(!opml.includes('new.example'), 'disabled feeds stay out of the export');
});

test('read toggling', async () => {
  const on = await post(`/api/articles/${ids.fresh}/read`, { read: true });
  assert.ok(on.body.read_at);
  const list = await get('/api/articles');
  assert.ok(!list.body.articles.some((a) => a.id === ids.fresh));
  const off = await post(`/api/articles/${ids.fresh}/read`, { read: false });
  assert.equal(off.body.read_at, null);
});

test('reclassify endpoint queues with priority and keeps the note sticky', async () => {
  const { status, body } = await post(`/api/articles/${ids.readOne}/reclassify`, {
    note: 'wrong category',
  });
  assert.equal(status, 200);
  assert.equal(body.status, 'pending');
  assert.equal(body.enrich_note, 'wrong category');

  // an empty note on a later request keeps the stored one
  const again = await post(`/api/articles/${ids.readOne}/reclassify`, { note: '' });
  assert.equal(again.body.enrich_note, 'wrong category');

  const row = (await get(`/api/articles/${ids.readOne}`)).body;
  assert.equal(row.status, 'pending');

  assert.equal((await post('/api/articles/99999/reclassify', {})).status, 404);
  assert.equal((await post(`/api/articles/${ids.readOne}/reclassify`, { note: 42 })).status, 400);

  // restore for the stats assertions later in the suite
  db.prepare("UPDATE articles SET status='enriched', enrich_priority=0 WHERE id = ?").run(ids.readOne);
});

test('guidelines are editable and round-trip', async () => {
  assert.deepEqual((await get('/api/guidelines')).body, { text: '' });

  const putRes = await fetch(`${base}/api/guidelines`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'prefer specific topics ' }),
  });
  assert.equal(putRes.status, 200);
  assert.deepEqual((await get('/api/guidelines')).body, { text: 'prefer specific topics' });

  const bad = await fetch(`${base}/api/guidelines`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 7 }),
  });
  assert.equal(bad.status, 400);
});

test('topics, feeds and stats endpoints', async () => {
  const topics = await get('/api/topics');
  const tech = topics.body.find((t) => t.name === 'tech');
  assert.equal(tech.up, 1);
  assert.ok(tech.pref > 0);

  const feeds = await get('/api/feeds');
  assert.equal(feeds.body[0].articles, 6);

  const stats = await get('/api/stats');
  assert.deepEqual(
    { total: stats.body.total, duplicates: stats.body.duplicates, pending: stats.body.pending },
    { total: 6, duplicates: 1, pending: 1 },
  );
});
