import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, testConfig, startOllamaStub, startApp } from './helpers.js';
import { createApp } from '../src/server.js';
import { recomputeScores } from '../src/scoring.js';
import { compressText } from '../src/compress.js';

const vec = (...values) => Buffer.from(Float16Array.from(values).buffer);

let db;
let base;
let server;
let ids;
let ollamaStub;

async function seed() {
  db.prepare("INSERT INTO feeds (id, url, title) VALUES (1, 'http://f', 'Feed One')").run();
  // Positional placeholders, not named (@x) ones bound from an object:
  // better-sqlite3 and bun:sqlite disagree on the object-binding convention,
  // while positional ? params work identically on both (and match every
  // other query in this codebase).
  const insArt = db.prepare(`
    INSERT INTO articles (feed_id, guid, title, content, summary, status,
                          published_at, vote, read_at, duplicate_of)
    VALUES (1, ?, ?, ?, ?, 'enriched', ?, ?, ?, ?)
  `);
  const insTopic = db.prepare('INSERT INTO topics (name) VALUES (?) RETURNING id');
  const link = db.prepare('INSERT INTO article_topics VALUES (?, ?)');

  const tech = insTopic.get('tech').id;
  const sports = insTopic.get('sports').id;

  const insert = (overrides) => {
    const a = {
      content: 'body', summary: 'sum', vote: 0, read_at: null, duplicate_of: null,
      ...overrides,
    };
    return Number(insArt.run(
      a.guid, a.title, compressText(a.content), a.summary, a.published_at, a.vote, a.read_at, a.duplicate_of,
    ).lastInsertRowid);
  };

  const out = {};
  out.liked = insert({ guid: 'g1', title: 'Liked tech story', published_at: '2026-07-01T00:00:00Z', vote: 1 });
  link.run(out.liked, tech);
  out.fresh = insert({ guid: 'g2', title: 'Fresh tech story', published_at: '2026-07-03T00:00:00Z' });
  link.run(out.fresh, tech);
  out.sporty = insert({ guid: 'g3', title: 'Sports story', published_at: '2026-07-04T00:00:00Z' });
  link.run(out.sporty, sports);
  out.readOne = insert({ guid: 'g4', title: 'Already read', published_at: '2026-07-02T00:00:00Z', read_at: '2026-07-02T10:00:00Z' });
  out.dupe = insert({ guid: 'g5', title: 'Fresh tech story (copy)', published_at: '2026-07-03T01:00:00Z', duplicate_of: out.fresh });
  // one unclassified article, marked read so unread-view assertions stay put
  out.pending = Number(db.prepare(`
    INSERT INTO articles (feed_id, guid, title, content, status, published_at, read_at)
    VALUES (1, 'g6', 'Awaiting classification', ?, 'pending',
            '2026-06-30T00:00:00Z', '2026-06-30T10:00:00Z')
  `).run(compressText('body')).lastInsertRowid);
  await recomputeScores(db, testConfig());

  // Distinguishable text_embeddings for the semantic search tests: liked
  // and fresh are "tech"-like, sporty is orthogonal ("sports"-like), dupe
  // is a closer match than its own group's root (fresh).
  const setVec = db.prepare('UPDATE articles SET text_embedding = ? WHERE id = ?');
  setVec.run(vec(1, 0, 0, 0), out.liked);
  setVec.run(vec(0.9, 0.1, 0, 0), out.fresh);
  setVec.run(vec(1, 0, 0, 0), out.dupe);
  setVec.run(vec(0, 1, 0, 0), out.sporty);

  return out;
}

before(async () => {
  db = tempDb();
  ids = await seed();
  ollamaStub = await startOllamaStub();
  ollamaStub.embed = (input) =>
    input.includes('sports') ? [0, 1, 0, 0] : [1, 0, 0, 0];
  const config = testConfig();
  config.ollama.url = ollamaStub.url;
  const app = createApp(db, config);
  server = await startApp(app);
  base = server.url;
});

after(async () => {
  await server.close();
  await ollamaStub.close();
});

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
const patch = async (path, payload) => {
  const res = await fetch(base + path, {
    method: 'PATCH',
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

test('grouped article listing ranks/limits via a narrow CTE before fetching wide columns', () => {
  // Regression: the grouped (dupes-bundling) query used to select a.* —
  // every BLOB column — inside the ROW_NUMBER() ranking subquery, for
  // every row matching the filter, before LIMIT ever applied. Live
  // measurement against ~11k unread articles: ~2.5s -> ~200-250ms once
  // restructured to rank/limit on a handful of narrow columns first and
  // only join back to the full row for the already-limited winners.
  // Asserting the query plan (not just correctness, already covered by
  // every other test in this file) is the actual regression to guard.
  const orderBy = "a.score - ? * (julianday('now') - julianday(COALESCE(a.published_at, a.created_at))) DESC, COALESCE(a.published_at, a.created_at) DESC";
  const sql = `
    EXPLAIN QUERY PLAN
    WITH winners AS (
      WITH ranked AS (
        SELECT a.id, a.score, a.published_at, a.created_at, a.feed_id,
               ROW_NUMBER() OVER (
                 PARTITION BY COALESCE(a.duplicate_of, a.id)
                 ORDER BY a.score DESC, COALESCE(a.published_at, a.created_at) DESC, a.id DESC
               ) AS rn
        FROM articles a WHERE a.read_at IS NULL
      )
      SELECT id FROM ranked a WHERE a.rn = 1
      ORDER BY ${orderBy} LIMIT ? OFFSET ?
    )
    SELECT a.id FROM winners JOIN articles a ON a.id = winners.id
    ORDER BY ${orderBy}
  `;
  const plan = db.prepare(sql).all(0.05, 50, 0, 0.05);
  assert.ok(
    plan.some((row) => row.detail === 'CO-ROUTINE winners'),
    `expected the winners CTE to materialize as its own co-routine, got: ${JSON.stringify(plan)}`,
  );
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

test('unlink detaches a false duplicate; the group shrinks, the copy becomes its own root', async () => {
  // sanity: the seeded dupe is inside fresh's group, and the group's
  // version counts reflect it
  const before = await get('/api/articles?view=all');
  const freshBefore = before.body.articles.find((a) => a.id === ids.fresh);
  assert.equal(freshBefore.versions, 2);

  // a detached copy keeps its OWN score — detaching must never copy the
  // root's (or anyone's) score onto it
  db.prepare('UPDATE articles SET score = 0.39 WHERE id = ?').run(ids.dupe);
  const freshScoreBefore = before.body.articles.find((a) => a.id === ids.fresh).score;

  // un-linking the copy: 200 + the un-grouped article back
  const res = await post(`/api/articles/${ids.dupe}/unlink`);
  assert.equal(res.status, 200);
  assert.equal(res.body.duplicate_of, null);
  assert.equal(res.body.score, 0.39, 'own score preserved through unlink');

  // both members now standalone: no versions on either side
  const after = await get('/api/articles?view=all');
  assert.equal(after.body.articles.find((a) => a.id === ids.fresh).versions, 1);
  assert.equal(after.body.articles.find((a) => a.id === ids.dupe).versions, 1);
  assert.equal(after.body.articles.find((a) => a.id === ids.fresh).score, freshScoreBefore);
  const versions = await get(`/api/articles/${ids.fresh}/versions`);
  assert.deepEqual(versions.body, []);

  // re-unlink (already standalone) and un-linking a root both 404
  assert.equal((await post(`/api/articles/${ids.dupe}/unlink`)).status, 404);
  assert.equal((await post(`/api/articles/${ids.fresh}/unlink`)).status, 404);
  assert.equal((await post('/api/articles/99999/unlink')).status, 404);

  // restore the link so other tests keep seeing the seeded group
  db.prepare('UPDATE articles SET duplicate_of = ? WHERE id = ?').run(ids.fresh, ids.dupe);
});

test('rededup re-attaches a mistakenly un-linked copy; no match stays standalone', async () => {
  // give both group members the same summary embedding (what dedup compares)
  const setEmb = db.prepare('UPDATE articles SET embedding = ? WHERE id = ?');
  setEmb.run(vec(1, 0, 0, 0), ids.fresh);
  setEmb.run(vec(1, 0, 0, 0), ids.dupe);

  // detach again, then re-check: dedup must find fresh and re-attach
  await post(`/api/articles/${ids.dupe}/unlink`);
  assert.equal((await get('/api/articles?view=all&dupes=1')).body.articles.find((a) => a.id === ids.fresh).versions, 1);
  const res = await post(`/api/articles/${ids.dupe}/rededup`);
  assert.equal(res.status, 200);
  assert.equal(res.body.duplicateOf, ids.fresh);
  assert.match(res.body.title, /Fresh tech story/);
  assert.equal((await get('/api/articles?view=all&dupes=1')).body.articles.find((a) => a.id === ids.fresh).versions, 2);

  // an orthogonal summary embedding matches nothing in the window
  const lone = db.prepare(`
    INSERT INTO articles (feed_id, guid, title, content, summary, status, embedding, published_at)
    VALUES (1, 'g-rededup-lone', 'Unrelated rededup story', ?, 'sum', 'enriched', ?, '2026-07-05T00:00:00Z')
  `).run(compressText('body'), vec(0, 1, 0, 0)).lastInsertRowid;
  const res2 = await post(`/api/articles/${Number(lone)}/rededup`);
  assert.equal(res2.status, 200);
  assert.equal(res2.body.duplicateOf, null);
  assert.equal(res2.body.alreadyGrouped, undefined);

  // already-grouped articles are a no-op
  const res3 = await post(`/api/articles/${ids.dupe}/rededup`);
  assert.equal(res3.body.alreadyGrouped, true);
  assert.equal(res3.body.duplicateOf, ids.fresh);

  // leave the shared seeded DB exactly as the seed built it: count-based
  // tests downstream must not see the helper article or the embeddings
  db.prepare('DELETE FROM article_topics WHERE article_id = ?').run(Number(lone));
  db.prepare('DELETE FROM articles WHERE id = ?').run(Number(lone));
  setEmb.run(null, ids.fresh);
  setEmb.run(null, ids.dupe);
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

test('semantic search ranks by meaning, bundles duplicates, excludes unembedded articles', async () => {
  const sports = await get(`/api/articles?view=all&semantic=1&q=${encodeURIComponent('sports team wins')}`);
  assert.equal(sports.status, 200);
  assert.equal(sports.body.articles[0].id, ids.sporty, 'closest embedding ranked first');
  assert.ok(sports.body.articles[0].similarity > 0.9);
  assert.ok(
    !sports.body.articles.some((a) => a.title === 'Awaiting classification'),
    'articles without an embedding are never candidates',
  );

  const tech = await get(`/api/articles?view=all&semantic=1&q=${encodeURIComponent('tech news')}`);
  const techIds = tech.body.articles.map((a) => a.id);
  assert.ok(techIds.includes(ids.liked));
  assert.ok(
    !techIds.includes(ids.fresh) || !techIds.includes(ids.dupe),
    'fresh/dupe stay one bundled group even in semantic mode',
  );
  assert.ok(techIds.includes(ids.dupe) || techIds.includes(ids.fresh));

  // semantic=1 without a query just behaves like a normal (non-semantic) list
  const noQuery = await get('/api/articles?view=all&semantic=1');
  assert.ok(!('similarity' in (noQuery.body.articles[0] ?? {})));
});

test('semantic search reports a clear error when Ollama is unreachable', async () => {
  const cfg = testConfig();
  cfg.ollama.url = 'http://127.0.0.1:1';
  const app = createApp(db, cfg);
  const tempServer = await startApp(app);
  try {
    const res = await fetch(`${tempServer.url}/api/articles?view=all&semantic=1&q=x`);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.error, /semantic search unavailable/);
  } finally {
    await tempServer.close();
  }
});

test('hot sort blends score with freshness, reordering vs plain score sort', async () => {
  // liked: score 1/3, published 2026-07-01 (oldest of the two).
  // sporty: score 0, published 2026-07-04 (3 days fresher).
  // Comparing the two, only their 3-day *relative* gap matters (the decay
  // term is additive/linear), so this holds regardless of what "today"
  // actually is when the test runs: at decay=0.15/day, 3 days is worth
  // 0.45 — enough to flip sporty (0 - 0) above liked (0.333 - 0.45·gap)
  // even though liked clearly wins on score alone.
  const cfg = testConfig();
  cfg.scoring.hotDecayPerDay = 0.15;
  const app = createApp(db, cfg);
  const tempServer = await startApp(app);
  const base2 = tempServer.url;
  try {
    const plain = await fetch(`${base2}/api/articles?view=all&sort=score`).then((r) => r.json());
    const plainIdx = (id) => plain.articles.findIndex((a) => a.id === id);
    assert.ok(plainIdx(ids.liked) < plainIdx(ids.sporty), 'plain score sort: liked (higher score) wins');

    const hot = await fetch(`${base2}/api/articles?view=all&sort=hot`).then((r) => r.json());
    const hotIdx = (id) => hot.articles.findIndex((a) => a.id === id);
    assert.ok(hotIdx(ids.sporty) < hotIdx(ids.liked), 'hot sort: the fresher article overtakes the older, higher-scored one');

    const bad = await fetch(`${base2}/api/articles?sort=bogus`);
    assert.equal(bad.status, 400);
  } finally {
    await tempServer.close();
  }
});

test('date-rr sort round-robins across active feeds, leaving stale feeds out of the round-robin', async () => {
  const day = 24 * 60 * 60 * 1000;
  const iso = (offsetDays) => new Date(Date.now() - offsetDays * day).toISOString();

  db.prepare("INSERT INTO feeds (id, url, title) VALUES (10, 'http://rr-a', 'Feed Active A')").run();
  db.prepare("INSERT INTO feeds (id, url, title) VALUES (11, 'http://rr-b', 'Feed Active B')").run();
  db.prepare("INSERT INTO feeds (id, url, title) VALUES (12, 'http://rr-c', 'Feed Stale C')").run();

  const insArt = db.prepare(`
    INSERT INTO articles (feed_id, guid, title, content, status, published_at)
    VALUES (?, ?, ?, ?, 'enriched', ?)
  `);
  const insert = (feedId, guid, title, daysAgo) =>
    Number(insArt.run(feedId, guid, title, compressText('body'), iso(daysAgo)).lastInsertRowid);

  // Feed A is active (posted today) and also has an older backlog article;
  // being active pulls its WHOLE backlog into round-robin ranking.
  const a1 = insert(10, 'rr-a1', 'A rank1 (today)', 0);
  const a2 = insert(10, 'rr-a2', 'A rank2 (20d ago)', 20);
  // Feed B is active (posted yesterday), one article.
  const b1 = insert(11, 'rr-b1', 'B rank1 (yesterday)', 1);
  // Feed C is stale: its only article is 18 days old, so the feed's own
  // most recent publish is outside the round-robin window. Deliberately
  // newer (18d) than A's rank2 (20d) — a plain date sort would place C
  // BEFORE a2; round-robin with staleness suppression must not.
  const c1 = insert(12, 'rr-c1', 'C stale (18d ago)', 18);

  try {
    const { body } = await get('/api/articles?view=all&status=enriched&sort=date-rr');
    const tracked = new Set([a1, a2, b1, c1]);
    const order = body.articles.filter((a) => tracked.has(a.id)).map((a) => a.id);

    assert.deepEqual(
      order, [a1, b1, a2, c1],
      'round 1 (a1, b1 by date) precedes round 2 (a2); stale C sorts last despite being newer than a2',
    );
  } finally {
    // Later tests in this shared-db file assert exact article/feed counts —
    // clean up so this test's fixtures don't leak into them.
    db.prepare(`DELETE FROM articles WHERE id IN (?, ?, ?, ?)`).run(a1, a2, b1, c1);
    db.prepare('DELETE FROM feeds WHERE id IN (10, 11, 12)').run();
  }
});

test('date-rr sort computes each feed\'s latest post once, not once per article', () => {
  // Regression: dateRoundRobinSql used to run a correlated MAX subquery
  // once per candidate article (each its own index seek, but there were
  // thousands of them — measured live at ~7-8s against a ~13k-article
  // corpus). Replaced with a single per-feed aggregate (GROUP BY feed_id,
  // far fewer feeds than articles), joined in. A materialized subquery
  // (not a correlated one re-run per row) is the actual regression to
  // guard — assert the plan shows it, not just that results are still
  // correct (already covered by the test above).
  const windowDays = 3;
  const orderBy = `
    CASE
      WHEN fl.latest >= datetime('now', '-${windowDays} days')
      THEN ROW_NUMBER() OVER (PARTITION BY a.feed_id ORDER BY COALESCE(a.published_at, a.created_at) DESC)
      ELSE 1000000
    END,
    COALESCE(a.published_at, a.created_at) DESC
  `;
  const feedLatestJoin = `
    LEFT JOIN (
      SELECT feed_id, MAX(COALESCE(published_at, created_at)) AS latest
      FROM articles GROUP BY feed_id
    ) fl ON fl.feed_id = a.feed_id
  `;
  const sql = `
    EXPLAIN QUERY PLAN
    SELECT a.id FROM articles a ${feedLatestJoin} WHERE a.status = 'enriched'
    ORDER BY ${orderBy} LIMIT ? OFFSET ?
  `;
  const plan = db.prepare(sql).all(50, 0);
  assert.ok(
    plan.some((row) => row.detail === 'MATERIALIZE fl'),
    `expected the per-feed aggregate to materialize once, got: ${JSON.stringify(plan)}`,
  );
  assert.ok(
    !plan.some((row) => /CORRELATED SCALAR SUBQUERY/.test(row.detail)),
    `expected no per-row correlated subquery left over, got: ${JSON.stringify(plan)}`,
  );
});

// Both novelty tests below call recomputeScores, which would clobber the
// shared file-level db's score/score_bonus columns for every other test
// still to run (they rely on the ONE recompute seed() does, before
// embeddings even exist — see its own comment) -- so, like "hot sort"
// and the semantic-error test above, these get their own isolated
// db/app instead of touching the shared one.
test('novelty sort ranks by distance from voted embeddings, unembedded articles last', async () => {
  const nDb = tempDb();
  nDb.prepare("INSERT INTO feeds (id, url, title) VALUES (1, 'http://nv', 'Novelty Feed')").run();
  const insArt = nDb.prepare(`
    INSERT INTO articles (feed_id, guid, title, content, status)
    VALUES (1, ?, ?, ?, 'enriched')
  `);
  const insert = (guid, title) =>
    Number(insArt.run(guid, title, compressText('body')).lastInsertRowid);

  const votedAnchor = insert('nv-voted', 'Voted anchor');
  const same = insert('nv-same', 'Same embedding as the voted anchor');
  const far = insert('nv-far', 'Orthogonal to the voted anchor');
  const unembedded = insert('nv-none', 'Not embedded yet');
  nDb.prepare('UPDATE articles SET vote = 1 WHERE id = ?').run(votedAnchor);
  nDb.prepare('UPDATE articles SET text_embedding = ? WHERE id = ?').run(vec(1, 0, 0, 0), votedAnchor);
  nDb.prepare('UPDATE articles SET text_embedding = ? WHERE id = ?').run(vec(1, 0, 0, 0), same);
  nDb.prepare('UPDATE articles SET text_embedding = ? WHERE id = ?').run(vec(0, 1, 0, 0), far);
  await recomputeScores(nDb, testConfig());

  const nServer = await startApp(createApp(nDb, testConfig()));
  try {
    const res = await fetch(`${nServer.url}/api/articles?view=all&status=enriched&dupes=1&sort=novelty`);
    const body = await res.json();
    const tracked = new Set([same, far, unembedded]);
    const order = body.articles.filter((a) => tracked.has(a.id)).map((a) => a.id);
    assert.deepEqual(
      order, [far, same, unembedded],
      'furthest from the voted anchor first, an unembedded article last regardless of the rest',
    );
  } finally {
    await nServer.close();
  }
});

test('novelty sort composes with grouped (duplicate-bundling) mode', async () => {
  // Regression: the narrow "winners" CTE only ever selected the columns
  // orderBy's SQL text references (score, published_at, created_at,
  // feed_id) -- adding a sort that references a.score_novelty without
  // also adding it to that CTE's SELECT list would throw "no such
  // column" as soon as grouping (the default, dupes != '1') was active.
  const nDb = tempDb();
  nDb.prepare("INSERT INTO feeds (id, url, title) VALUES (1, 'http://nvg', 'Novelty Grouped Feed')").run();
  const insArt = nDb.prepare(`
    INSERT INTO articles (feed_id, guid, title, content, status, duplicate_of)
    VALUES (1, ?, ?, ?, 'enriched', ?)
  `);
  const insert = (guid, title, duplicateOf) =>
    Number(insArt.run(guid, title, compressText('body'), duplicateOf ?? null).lastInsertRowid);

  const votedAnchor = insert('nvg-voted', 'Voted anchor', null);
  const root = insert('nvg-root', 'Group root (less novel)', null);
  const repeat = insert('nvg-repeat', 'Group repeat', root);
  const other = insert('nvg-other', 'Different group (more novel)', null);
  nDb.prepare('UPDATE articles SET vote = 1 WHERE id = ?').run(votedAnchor);
  nDb.prepare('UPDATE articles SET text_embedding = ? WHERE id = ?').run(vec(1, 0, 0, 0), votedAnchor);
  nDb.prepare('UPDATE articles SET text_embedding = ? WHERE id = ?').run(vec(1, 0, 0, 0), root);
  nDb.prepare('UPDATE articles SET text_embedding = ? WHERE id = ?').run(vec(1, 0, 0, 0), repeat);
  nDb.prepare('UPDATE articles SET text_embedding = ? WHERE id = ?').run(vec(0, 1, 0, 0), other);
  await recomputeScores(nDb, testConfig());

  const nServer = await startApp(createApp(nDb, testConfig()));
  try {
    const res = await fetch(`${nServer.url}/api/articles?view=all&status=enriched&sort=novelty`);
    const body = await res.json();
    // root and repeat tie on novelty (identical embeddings) -- which one
    // wins the group (ROW_NUMBER's own score/date/id tiebreak) isn't what
    // this test is about, only that grouping and novelty compose at all.
    const tracked = new Set([root, repeat, other]);
    const order = body.articles.filter((a) => tracked.has(a.id)).map((a) => a.id);
    assert.equal(order.length, 2, 'one representative per duplicate group, not two');
    assert.equal(order[0], other, 'the more novel group ranks first');
    assert.ok(order[1] === root || order[1] === repeat, 'the less novel group is represented by one of its members');
  } finally {
    await nServer.close();
  }
});

test('article detail includes content; unknown id -> 404', async () => {
  const ok = await get(`/api/articles/${ids.fresh}`);
  assert.equal(ok.body.content, 'body');
  const missing = await get('/api/articles/99999');
  assert.equal(missing.status, 404);
});

test('reader endpoint: no URL falls back to feed content; unknown id -> 404', async () => {
  const ok = await get(`/api/articles/${ids.fresh}/reader`);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { html: 'body', source: 'feed' });

  const missing = await get('/api/articles/99999/reader');
  assert.equal(missing.status, 404);
});

test('voting validates input, persists and recomputes scores', async () => {
  for (const vote of [5, -3, 1.5, '1']) {
    const bad = await post(`/api/articles/${ids.sporty}/vote`, { vote });
    assert.equal(bad.status, 400, `vote ${vote} rejected`);
  }

  const articleBefore = (await get(`/api/articles/${ids.sporty}`)).body;
  assert.equal(articleBefore.score, 0);
  assert.equal(articleBefore.read_at, null, 'sporty starts unread');

  const { status, body } = await post(`/api/articles/${ids.sporty}/vote`, { vote: 1 });
  assert.equal(status, 200);
  assert.equal(body.vote, 1);
  assert.ok(body.score > 0, 'sports preference rose after upvote');
  assert.ok('score_topics' in body && 'score_embedding' in body, 'components returned');
  assert.ok(body.read_at, 'casting a real vote marks the article read — you can\'t rate what you never read');

  const wow = await post(`/api/articles/${ids.sporty}/vote`, { vote: 2 });
  assert.ok(wow.body.score > body.score, 'a WOW vote outweighs a plain upvote');
  assert.equal(wow.body.read_at, body.read_at, 'an already-read article keeps its original read_at');

  const retracted = await post(`/api/articles/${ids.sporty}/vote`, { vote: 0 }); // restore
  assert.equal(retracted.body.read_at, body.read_at, 'retracting a vote does not un-read the article');
});

test('feed management: add, disable, stats, OPML round-trip', async () => {
  const added = await post('/api/feeds', { url: 'http://new.example/rss', title: 'New Feed' });
  assert.equal(added.status, 201);
  assert.equal(added.body.active, 1);

  const rejected = await post('/api/feeds', { url: 'ftp://nope' });
  assert.equal(rejected.status, 400);

  const disabled = await patch(`/api/feeds/${added.body.id}`, { active: false });
  assert.equal(disabled.body.active, 0);

  const renamed = await patch(`/api/feeds/${added.body.id}`, { title: '  My Custom Name  ' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.title, 'My Custom Name', 'trimmed');

  const clearedTitle = await patch(`/api/feeds/${added.body.id}`, { title: '   ' });
  assert.equal(clearedTitle.body.title, null, 'blank clears the override back to auto-detected');

  const badTitle = await patch(`/api/feeds/${added.body.id}`, { title: 42 });
  assert.equal(badTitle.status, 400);

  const nothingToUpdate = await patch(`/api/feeds/${added.body.id}`, {});
  assert.equal(nothingToUpdate.status, 400);

  const notFound = await patch('/api/feeds/999999', { title: 'x' });
  assert.equal(notFound.status, 404);

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

test('renaming a feed is visible on the very next GET /api/feeds', async () => {
  // Regression: feedList()'s cache key is derived from row counts (feed
  // count, vote count, active sum, etc.) -- a title-only edit changes
  // none of those, so a stale cached list would keep serving the old
  // title forever after a rename, only refreshing once some unrelated
  // count-changing action happened to bust the cache.
  const added = await post('/api/feeds', { url: 'http://rename-me.example/rss', title: 'Original Name' });
  await patch(`/api/feeds/${added.body.id}`, { title: 'Renamed' });
  const feeds = (await get('/api/feeds')).body;
  const feed = feeds.find((f) => f.id === added.body.id);
  assert.equal(feed.title, 'Renamed', 'GET reflects the rename immediately, not a stale cached list');
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
  assert.equal(feeds.body.find((f) => f.id === 1).articles, 6);

  const stats = await get('/api/stats');
  assert.deepEqual(
    { total: stats.body.total, duplicates: stats.body.duplicates, pending: stats.body.pending },
    { total: 6, duplicates: 1, pending: 1 },
  );
});

test('a feed with zero ever-ingested articles reports 0 unread, not a phantom-row miscount', async () => {
  // Regression: COALESCE(SUM(a.read_at IS NULL), 0) miscounted 1 unread for
  // a feed with NO articles at all, because the LEFT JOIN's single
  // all-NULL placeholder row has a.read_at IS NULL true (that operator is
  // true-for-actual-NULL, unlike most others) even though there's no
  // article. A dead/404 feed (0 successful fetches ever) hits this every
  // time - reported live as "unread 1/0" in the Feeds tab.
  db.prepare("INSERT INTO feeds (id, url, title, ok_count, error_count) VALUES (99, 'http://dead.example/rss', 'Dead Feed', 0, 77)").run();
  const feeds = await get('/api/feeds');
  const dead = feeds.body.find((f) => f.id === 99);
  assert.deepEqual({ articles: dead.articles, unread: dead.unread }, { articles: 0, unread: 0 });
});

test('propose-merges returns the LLM\'s filtered proposals, nothing applied', async () => {
  ollamaStub.chat = () => ({
    merges: [
      { from: 'sports', to: 'tech', reason: 'test proposal' },
      { from: 'not-a-real-topic', to: 'tech', reason: 'unknown from, dropped' },
    ],
  });
  const res = await post('/api/topics/propose-merges');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.merges, [{ from: 'sports', to: 'tech', reason: 'test proposal', lowConfidence: false }]);

  // propose-only: both topics must still exist, untouched
  const names = (await get('/api/topics')).body.map((t) => t.name).sort();
  assert.ok(names.includes('sports') && names.includes('tech'));
});

test('merge applies immediately and rejects bad input', async () => {
  const bad = await post('/api/topics/merge', { from: '', to: 'tech' });
  assert.equal(bad.status, 400);

  const unknown = await post('/api/topics/merge', { from: 'ghost', to: 'tech' });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /unknown topic "ghost"/);

  const ok = await post('/api/topics/merge', { from: 'sports', to: 'tech' });
  assert.equal(ok.status, 200);
  const names = ok.body.map((t) => t.name);
  assert.ok(!names.includes('sports'), 'the merged-away topic is gone');
  assert.ok(names.includes('tech'));

  const sportyTopics = db.prepare(`
    SELECT t.name FROM article_topics at JOIN topics t ON t.id = at.topic_id WHERE at.article_id = ?
  `).all(ids.sporty).map((r) => r.name);
  assert.deepEqual(sportyTopics, ['tech'], 'the affected article was retagged');
});
