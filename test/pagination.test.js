import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, testConfig } from './helpers.js';
import { createApp } from '../src/server.js';

const DATE = '2026-09-01T12:34:56.789Z';

function fixture(t, articles) {
  const db = tempDb();
  t.after(() => db.close());
  db.prepare("INSERT INTO feeds (id, url, title) VALUES (1, 'https://one.invalid', 'One'), (2, 'https://two.invalid', 'Two')").run();
  const insert = db.prepare(`
    INSERT INTO articles (id, feed_id, guid, title, status, published_at, created_at,
      score, score_novelty, score_topics, score_embedding, score_depth, score_feed,
      score_bonus, duplicate_of)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    const id = a.id ?? i + 1;
    insert.run(id, a.feed_id ?? 1, `cursor-${id}`, a.title ?? `Story ${id}`,
      a.status ?? 'enriched', a.published_at === undefined ? DATE : a.published_at,
      a.created_at ?? DATE, a.score ?? 0, a.novelty ?? null,
      a.topics ?? 0, a.embedding ?? 0, a.depth ?? 0, a.feed ?? 0,
      a.bonus ?? 0, a.duplicate_of ?? null);
  }
  const config = testConfig();
  config.scoring.hotDecayPerDay = 0.05;
  const app = createApp(db, config);
  const page = async (params = {}) => {
    const response = await app.request('/api/articles?' + new URLSearchParams({
      view: 'all', dupes: '1', limit: '1', ...params,
    }));
    return { status: response.status, body: await response.json() };
  };
  return { db, config, page };
}

async function walk(page, params, maxPages = 20) {
  const ids = [];
  let cursor;
  for (let i = 0; i < maxPages; i++) {
    const { status, body } = await page({ ...params, ...(cursor ? { cursor } : {}) });
    assert.equal(status, 200, JSON.stringify(body));
    assert.ok(body.articles.every((a) => !Object.keys(a).some((k) => k.startsWith('_cursor'))),
      'SQL cursor columns are not part of the article response');
    if (!body.articles.length) return ids;
    ids.push(...body.articles.map((a) => a.id));
    cursor = body.nextCursor;
    assert.ok(cursor, 'a nonempty keyset page carries a cursor');
  }
  assert.fail('cursor walk did not terminate');
}

test('novelty cursor crosses from finite scores to NULL and walks the entire NULL shelf', async (t) => {
  const { page } = fixture(t, [{ novelty: 0.8 }, { novelty: 0.4 }, {}, {}]);
  assert.deepEqual(await walk(page, { sort: 'novelty' }), [1, 2, 4, 3]);
});

test('all-NULL novelty uses the date and id tiebreaks, including created_at fallback', async (t) => {
  const { page } = fixture(t, [
    { published_at: null, created_at: '2026-09-02T00:00:00Z' }, {}, {},
  ]);
  assert.deepEqual(await walk(page, { sort: 'novelty' }), [1, 3, 2]);
});

test('score and novelty preserve negative values, zeroes and tied ids across pages', async (t) => {
  const { page } = fixture(t, [
    { score: -0.7, novelty: -0.7 }, { score: -0.1, novelty: -0.1 },
    { score: 0, novelty: 0 }, { score: 0, novelty: 0 },
  ]);
  for (const sort of ['score', 'novelty']) {
    assert.deepEqual(await walk(page, { sort }), [4, 3, 2, 1]);
  }
});

test('grouped novelty applies the cursor after choosing one representative per group', async (t) => {
  const { page } = fixture(t, [
    { score: 0.5, novelty: 0.9 }, { score: 0.1, novelty: 1, duplicate_of: 1 },
    { score: 0.3, novelty: 0.2 }, {}, { duplicate_of: 4 },
  ]);
  assert.deepEqual(await walk(page, { sort: 'novelty', dupes: '0' }), [1, 3, 4]);
});

test('date, score, hot, custom and novelty cursors survive read churn', async (t) => {
  for (const sort of ['date', 'score', 'hot', 'custom', 'novelty']) {
    const { page, db } = fixture(t, Array.from({ length: 6 }, () => ({ score: 0.5, novelty: 0.3 })));
    const params = { view: 'unread', sort, limit: '2' };
    const first = await page(params);
    assert.deepEqual(first.body.articles.map((a) => a.id), [6, 5]);
    db.prepare('UPDATE articles SET read_at = ? WHERE id IN (5, 6)').run(DATE);
    const second = await page({ ...params, cursor: first.body.nextCursor });
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.articles.map((a) => a.id), [4, 3], sort);
  }
});

test('hot and custom cursors retain their exact SQL key when the clock changes', async (t) => {
  const { db, page } = fixture(t, [{ score: 0.7, topics: 0.7 }, { score: 0.7, topics: 0.7 }, { score: 0.7, topics: 0.7 }]);
  // Change SQLite's query-time clock without sleeps or global Date mocks.
  // The old ORDER BY depended on this term, and reconstructed its cursor
  // using a separate JavaScript clock. A correct key depends on neither.
  const prepare = db.prepare.bind(db);
  let now = '2026-09-20T00:00:00Z';
  db.prepare = (sql) => prepare(sql.replaceAll("julianday('now')", `julianday('${now}')`));
  for (const sort of ['hot', 'custom']) {
    const params = { sort, w_topics: '1', w_embedding: '0', w_depth: '0', w_feed: '0', w_bonus: '0', w_decay: '0.05' };
    const first = await page(params);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.articles.map((a) => a.id), [3]);
    now = '2026-09-25T00:00:00Z';
    const replay = await page(params);
    assert.equal(replay.body.nextCursor, first.body.nextCursor,
      'an unchanged row has the same cursor on a different day');
    const second = await page({ ...params, cursor: first.body.nextCursor });
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.articles.map((a) => a.id), [2], sort);
    const third = await page({ ...params, cursor: second.body.nextCursor });
    assert.deepEqual(third.body.articles.map((a) => a.id), [1], sort);
    now = '2026-09-20T00:00:00Z';
  }
});

test('hot/custom keep missing temporal keys last and can traverse them', async (t) => {
  const { page } = fixture(t, [
    { score: 0.7, topics: 0.7 },
    { score: 9, topics: 9, published_at: 'invalid-date' },
    { score: 9, topics: 9, published_at: 'invalid-date' },
  ]);
  for (const sort of ['hot', 'custom']) {
    assert.deepEqual(await walk(page, { sort }), [1, 3, 2]);
  }
});

test('hot/custom retain the interest versus freshness tradeoff through a full walk', async (t) => {
  const { page } = fixture(t, [
    { score: 0.9, topics: 0.9, published_at: '2026-09-01T00:00:00Z' },
    { score: 0.89, topics: 0.89, published_at: '2026-09-02T00:00:00Z' },
    { score: 1.1, topics: 1.1, published_at: '2026-08-31T00:00:00Z' },
  ]);
  assert.deepEqual(await walk(page, { sort: 'hot' }), [3, 2, 1]);
  assert.deepEqual(await walk(page, {
    sort: 'custom', w_topics: '1', w_embedding: '0', w_depth: '0', w_feed: '0',
    w_bonus: '0', w_decay: '0.05',
  }), [3, 2, 1]);
});

test('grouped custom cursor ranks the selected representatives with the same key', async (t) => {
  const { page } = fixture(t, [
    { score: 2, topics: 0.1 }, { score: 0, topics: 0.7, duplicate_of: 1 },
    { topics: 0.4 }, {}, { topics: 0.3, duplicate_of: 4 },
  ]);
  assert.deepEqual(await walk(page, {
    sort: 'custom', dupes: '0', w_topics: '1', w_embedding: '0', w_depth: '0',
    w_feed: '0', w_bonus: '0', w_decay: '0.05',
  }), [2, 3, 5]);
});

test('cursor scope rejects changes to ordering, filters and grouping', async (t) => {
  const { page } = fixture(t, [{ score: 0.7 }, { score: 0.7 }]);
  const first = await page({ sort: 'hot' });
  const cursor = first.body.nextCursor;
  for (const change of [
    { sort: 'score' }, { sort: 'novelty' }, { view: 'unread' }, { status: 'enriched' },
    { feed_id: '1' }, { topic: 'tech' }, { q: 'Story' }, { dupes: '0' },
  ]) {
    const response = await page({ sort: 'hot', cursor, ...change });
    assert.equal(response.status, 400, JSON.stringify(change));
    assert.match(response.body.error, /cursor.*restart/i);
  }
  const resized = await page({ sort: 'hot', cursor, limit: '20' });
  assert.equal(resized.status, 200, 'page size is not part of the ranking/filter contract');
  assert.deepEqual(resized.body.articles.map((a) => a.id), [1]);
});

test('cursor scope uses effective custom weights and hot decay configuration', async (t) => {
  const { page, config } = fixture(t, [{ score: 0.7, topics: 0.7 }, { score: 0.7, topics: 0.7 }]);
  const params = { sort: 'custom', w_topics: '1', w_decay: '0.05' };
  const first = await page(params);
  for (const name of ['w_topics', 'w_embedding', 'w_depth', 'w_feed', 'w_bonus', 'w_decay']) {
    const changed = await page({ ...params, cursor: first.body.nextCursor, [name]: '0.9' });
    assert.equal(changed.status, 400, name);
  }
  const same = await page({ ...params, w_topics: '1.0', cursor: first.body.nextCursor });
  assert.equal(same.status, 200, 'numeric spelling does not alter the effective weights');
  assert.deepEqual(same.body.articles.map((a) => a.id), [1]);
  const hot = await page({ sort: 'hot' });
  config.scoring.hotDecayPerDay = 0.1;
  assert.equal((await page({ sort: 'hot', cursor: hot.body.nextCursor })).status, 400);
});

test('OFFSET-only modes return no keyset cursor and reject a cursor from another mode', async (t) => {
  const { page } = fixture(t, [{}, {}, {}]);
  const first = await page({ sort: 'date-rr' });
  assert.equal(first.status, 200);
  assert.equal(first.body.nextCursor, null);
  const second = await page({ sort: 'date-rr', offset: '1' });
  assert.equal(second.status, 200);
  assert.notEqual(second.body.articles[0].id, first.body.articles[0].id);
  const cursor = (await page({ sort: 'date' })).body.nextCursor;
  for (const params of [{ sort: 'date-rr' }, { sort: 'date', semantic: '1', q: 'Story' }]) {
    const response = await page({ ...params, cursor });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /cursor.*restart/i);
  }
});

test('legacy and malformed cursor payloads fail with a restart instruction', async (t) => {
  const { page } = fixture(t, [{ novelty: 0.7 }, { novelty: 0.7 }]);
  const first = await page({ sort: 'novelty' });
  const valid = JSON.parse(Buffer.from(first.body.nextCursor, 'base64url').toString());
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const invalid = [
    '!', 'a'.repeat(4096), encode([0.7, DATE, 2]), encode(null), encode({}),
    encode({ ...valid, v: 999 }), encode({ ...valid, scope: 'wrong' }),
    encode({ ...valid, key: [1, 0.7, DATE] }),
    encode({ ...valid, key: [1, 0.7, DATE, 1.5] }),
    encode({ ...valid, key: [1, 0.7, DATE, 0] }),
    encode({ ...valid, key: [1, 0.7, DATE, Number.MAX_SAFE_INTEGER + 1] }),
    encode({ ...valid, key: [2, 0.7, DATE, 2] }),
    encode({ ...valid, key: [1, '0.7', DATE, 2] }),
    encode({ ...valid, key: [1, null, DATE, 2] }),
    encode({ ...valid, key: [1, 0.7, null, 2] }),
  ];
  for (const cursor of invalid) {
    const response = await page({ sort: 'novelty', cursor });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /cursor.*restart/i);
  }
});
