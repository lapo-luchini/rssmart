import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mastodon, normalize } from '../src/mastodon.js';
import { ingestMastodonFeed } from '../src/ingest.js';
import { tempDb } from './helpers.js';

test('normalize keeps a space between a toot\'s separately-<p>-wrapped paragraphs', () => {
  // The real shape reported live: a Fediverse post whose title came out
  // "...or sadfMRI scans..." because stripping tags to nothing (rather than
  // to a space) glued two adjacent <p> paragraphs together.
  const status = {
    id: '7491435',
    created_at: '2026-08-10T15:05:28.000Z',
    content: "<p>Dogs can tell if you're scared or sad</p><p>fMRI scans show happiness, fear, anger, and sadness have distinct brain activity patterns.</p>",
    account: { acct: 'someone@example.social', display_name: 'Someone' },
  };
  const out = normalize(status, 'https://example.social');
  const joined = "Dogs can tell if you're scared or sad fMRI scans show happiness, fear, anger, and sadness have distinct brain activity patterns.";
  assert.equal(out.title, joined.slice(0, 120));
  assert.ok(!out.title.includes('sadfMRI'), 'paragraphs must not run together');
});

test('normalize unwraps a boost to the original post', () => {
  const status = {
    id: 'wrapper-1',
    content: '',
    account: { acct: 'booster' },
    reblog: {
      content: '<p>Original toot</p>',
      url: 'https://example.social/@author/1',
      account: { acct: 'author', display_name: 'Author' },
      created_at: '2026-08-10T00:00:00.000Z',
    },
  };
  const out = normalize(status, 'https://example.social');
  assert.equal(out.title, 'Original toot');
  assert.equal(out.author, 'Author');
  assert.equal(out.url, 'https://example.social/@author/1');
});

test('normalize synthesizes a title/content for a media-only post', () => {
  const status = {
    id: 'media-1',
    content: '',
    account: { acct: 'photographer' },
    media_attachments: [{ type: 'image', description: 'a sunset over the sea' }],
  };
  const out = normalize(status, 'https://example.social');
  assert.equal(out.title, '[a sunset over the sea]');
  assert.equal(out.content, '[a sunset over the sea]');
});

test('normalize falls back to a placeholder for a truly empty post', () => {
  const status = { id: 'empty-1', content: '', account: { acct: 'nobody' } };
  const out = normalize(status, 'https://example.social');
  assert.equal(out.title, '(no content)');
});

const rawPost = (id) => ({
  id, content: `<p>Post ${id}</p>`, created_at: '2026-09-01T00:00:00Z',
  account: { acct: 'author' },
});

// The fixture models server order by array position, not by sorting IDs.
function timeline(t, ids, { pageSize = 40 } = {}) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (target) => {
    const url = new URL(target);
    requests.push(url);
    const minId = url.searchParams.get('min_id');
    assert.equal(url.searchParams.get('since_id'), null);
    assert.equal(url.searchParams.get('limit'), '40');
    if (minId != null) assert.ok(ids.includes(minId), 'cursor is an exact remote ID');
    const batch = minId == null
      ? ids.slice(-pageSize)
      : ids.slice(ids.indexOf(minId) + 1, ids.indexOf(minId) + 1 + pageSize);
    return Response.json(batch.toReversed().map(rawPost));
  });
  return { client: new Mastodon({ url: 'https://example.invalid', token: 'test' }), requests };
}

function feedDb(t, initialId) {
  const db = tempDb();
  t.after(() => db.close());
  db.prepare("INSERT INTO feeds (id, url, type) VALUES (1, 'https://example.invalid', 'mastodon')").run();
  if (initialId != null) db.prepare(`
    INSERT INTO articles (feed_id, guid, title) VALUES (1, ?, 'Already ingested')
  `).run(`mastodon:${initialId}`);
  return db;
}

const watermark = (db) => db.prepare("SELECT value FROM meta WHERE key = 'mastodon_watermark:1'").get()?.value;
const storedIds = (db) => db.prepare('SELECT guid FROM articles ORDER BY id').all().map((r) => r.guid.slice(9));

test('forward pagination preserves large string IDs, oldest-first order and bounded resume', async (t) => {
  const ids = Array.from({ length: 101 }, (_, i) => String(115000000000000001n + BigInt(i)));
  const { client, requests } = timeline(t, ids);
  const first = await client.homeTimeline(ids[0], { maxPages: 2 });
  assert.deepEqual(first.map((p) => p.id), ids.slice(1, 81));
  assert.deepEqual(requests.map((r) => r.searchParams.get('min_id')), [ids[0], ids[40]]);
  const second = await client.homeTimeline(first.at(-1).id, { maxPages: 2 });
  assert.deepEqual(second.map((p) => p.id), ids.slice(81));
  assert.deepEqual([...first, ...second].map((p) => p.id), ids.slice(1));
  assert.deepEqual(await client.homeTimeline(second.at(-1).id), []);
});

test('opaque IDs follow wire order, and short pages do not truncate forward scans', async (t) => {
  const ids = ['z-initial', 'a-old', 'https://example.invalid/status/opaque', '10', '2', 'b-new'];
  const { client, requests } = timeline(t, ids, { pageSize: 2 });
  const posts = await client.homeTimeline(ids[0]);
  assert.deepEqual(posts.map((p) => p.id), ids.slice(1));
  assert.deepEqual(requests.map((r) => r.searchParams.get('min_id')), [ids[0], ids[2], ids[4], ids[5]]);
});

test('initial sync seeds exactly the latest page, without historical backfill', async (t) => {
  const ids = Array.from({ length: 80 }, (_, i) => `opaque-${i}`);
  const { client, requests } = timeline(t, ids);
  assert.deepEqual((await client.homeTimeline(null)).map((p) => p.id), ids.slice(-40));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].searchParams.get('min_id'), null);
});

test('overlapping pages are deduplicated while preserving oldest-first order', async () => {
  const client = new Mastodon();
  const pages = [['two', 'one', 'two'], ['three', 'two'], []];
  client.homeTimelinePage = async () => pages.shift().map(rawPost);
  assert.deepEqual((await client.homeTimeline('initial')).map((p) => p.id), ['one', 'two', 'three']);
});

test('a repeated or non-advancing page fails without spending the remaining page budget', async () => {
  const client = new Mastodon();
  let calls = 0;
  client.homeTimelinePage = async () => { calls++; return ['newer', 'older'].map(rawPost); };
  await assert.rejects(client.homeTimeline('initial'), /did not advance/);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(client.homeTimeline('newer'), /did not advance/);
  assert.equal(calls, 1);
});

test('invalid page budgets, cursors and numeric wire IDs fail explicitly', async () => {
  const client = new Mastodon();
  for (const maxPages of [0, -1, 1.5, Infinity]) {
    await assert.rejects(client.homeTimeline('cursor', { maxPages }), /positive integer/);
  }
  await assert.rejects(client.homeTimeline(115000000000000001), /non-empty string/);
  await assert.rejects(client.homeTimeline(''), /non-empty string/);
  for (const page of [[{ id: 123 }], [{ id: '' }], [{ id: null }], { error: 'bad response' }]) {
    client.homeTimelinePage = async () => page;
    await assert.rejects(client.homeTimeline('cursor'), /string status IDs/);
  }
});

test('repeated bounded ingestion stores every large-ID post once and persists its exact cursor', async (t) => {
  const ids = Array.from({ length: 101 }, (_, i) => String(115000000000000001n + BigInt(i)));
  const { client } = timeline(t, ids);
  const db = feedDb(t, ids[0]);
  const bounded = { homeTimeline: (sinceId) => client.homeTimeline(sinceId, { maxPages: 1 }) };
  const additions = [];
  for (let i = 0; i < 4; i++) additions.push((await ingestMastodonFeed(db, { id: 1 }, bounded)).added);
  assert.deepEqual(additions, [40, 40, 20, 0]);
  assert.deepEqual(storedIds(db), ids);
  assert.equal(watermark(db), ids.at(-1));
  assert.equal(db.prepare('SELECT ok_count FROM feeds WHERE id = 1').get().ok_count, 4);
});

test('the explicit cursor survives removal of the most recently inserted article', async (t) => {
  const ids = ['initial', 'one', 'two'];
  const { client, requests } = timeline(t, ids);
  const db = feedDb(t, ids[0]);
  await ingestMastodonFeed(db, { id: 1 }, client);
  db.prepare("DELETE FROM articles WHERE guid = 'mastodon:two'").run();
  ids.push('three');
  const before = requests.length;
  assert.equal((await ingestMastodonFeed(db, { id: 1 }, client)).added, 1);
  assert.equal(requests[before].searchParams.get('min_id'), 'two');
  assert.equal(watermark(db), 'three');
});

test('initial ingestion persists the newest seed cursor and resumes from it', async (t) => {
  const ids = Array.from({ length: 80 }, (_, i) => `opaque-${i}`);
  const { client } = timeline(t, ids);
  const db = feedDb(t);
  assert.equal((await ingestMastodonFeed(db, { id: 1 }, client)).added, 40);
  assert.deepEqual(storedIds(db), ids.slice(-40));
  assert.equal(watermark(db), ids.at(-1));
  ids.push('latest');
  assert.equal((await ingestMastodonFeed(db, { id: 1 }, client)).added, 1);
  assert.equal(watermark(db), 'latest');
});

test('a later network failure leaves articles and watermark unchanged; retry loses nothing', async (t) => {
  const db = feedDb(t, 'initial');
  const client = new Mastodon();
  let fail = true;
  client.homeTimelinePage = async (_, minId) => {
    if (minId === 'initial') return ['two', 'one'].map(rawPost);
    if (fail) throw new Error('network unavailable');
    return [];
  };
  await assert.rejects(ingestMastodonFeed(db, { id: 1 }, client), /network unavailable/);
  assert.deepEqual(storedIds(db), ['initial']);
  assert.equal(watermark(db), undefined);
  fail = false;
  assert.equal((await ingestMastodonFeed(db, { id: 1 }, client)).added, 2);
  assert.deepEqual(storedIds(db), ['initial', 'one', 'two']);
  assert.equal(watermark(db), 'two');
});

test('an article insert failure rolls back the complete batch and watermark before retry', async (t) => {
  const { client } = timeline(t, ['initial', 'one', 'two']);
  const db = feedDb(t, 'initial');
  db.exec(`CREATE TRIGGER reject_fixture BEFORE INSERT ON articles
    WHEN NEW.guid = 'mastodon:two' BEGIN SELECT RAISE(ABORT, 'fixture rejected'); END`);
  await assert.rejects(ingestMastodonFeed(db, { id: 1 }, client), /fixture rejected/);
  assert.deepEqual(storedIds(db), ['initial']);
  assert.equal(watermark(db), undefined);
  assert.equal(db.prepare('SELECT ok_count FROM feeds').get().ok_count, 0);
  db.exec('DROP TRIGGER reject_fixture');
  assert.equal((await ingestMastodonFeed(db, { id: 1 }, client)).added, 2);
  assert.deepEqual(storedIds(db), ['initial', 'one', 'two']);
  assert.equal(watermark(db), 'two');
});

test('a watermark write failure rolls back inserted articles', async (t) => {
  const { client } = timeline(t, ['initial', 'one']);
  const db = feedDb(t, 'initial');
  db.exec(`CREATE TRIGGER reject_cursor BEFORE INSERT ON meta
    WHEN NEW.key = 'mastodon_watermark:1' BEGIN SELECT RAISE(ABORT, 'cursor rejected'); END`);
  await assert.rejects(ingestMastodonFeed(db, { id: 1 }, client), /cursor rejected/);
  assert.deepEqual(storedIds(db), ['initial']);
  assert.equal(watermark(db), undefined);
});

test('a slower concurrent fetch cannot overwrite a committed cursor', async (t) => {
  const { client } = timeline(t, ['initial', 'one', 'two']);
  const db = feedDb(t, 'initial');
  let release;
  const pendingPosts = new Promise((resolve) => { release = resolve; });
  const slow = ingestMastodonFeed(db, { id: 1 }, { homeTimeline: () => pendingPosts });
  assert.equal((await ingestMastodonFeed(db, { id: 1 }, client)).added, 2);
  release([normalize(rawPost('one'), 'https://example.invalid')]);
  await assert.rejects(slow, /watermark changed during fetch/);
  assert.deepEqual(storedIds(db), ['initial', 'one', 'two']);
  assert.equal(watermark(db), 'two');
  assert.equal(db.prepare('SELECT ok_count FROM feeds').get().ok_count, 1);
});

test('empty initial sync establishes no cursor and can seed a later nonempty timeline', async (t) => {
  const ids = [];
  const { client } = timeline(t, ids);
  const db = feedDb(t);
  assert.equal((await ingestMastodonFeed(db, { id: 1 }, client)).added, 0);
  assert.equal(watermark(db), undefined);
  ids.push('first');
  assert.equal((await ingestMastodonFeed(db, { id: 1 }, client)).added, 1);
  assert.equal(watermark(db), 'first');
});

test('legacy newest-first inserts replay safely and establish a cursor even when every post exists', async (t) => {
  const ids = ['initial', 'one', 'two', 'three'];
  const { client } = timeline(t, ids);
  const db = feedDb(t, 'initial');
  for (const id of ids.slice(1).toReversed()) {
    db.prepare("INSERT INTO articles (feed_id, guid, title) VALUES (1, ?, 'Existing')").run(`mastodon:${id}`);
  }
  assert.equal((await ingestMastodonFeed(db, { id: 1 }, client)).added, 0);
  assert.equal(watermark(db), 'three');
  ids.push('four');
  assert.equal((await ingestMastodonFeed(db, { id: 1 }, client)).added, 1);
  assert.equal(watermark(db), 'four');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM articles').get().n, 5);
});

test('a server repeating pages cannot commit a partial batch or advance the watermark', async (t) => {
  const db = feedDb(t, 'initial');
  const client = new Mastodon();
  client.homeTimelinePage = async () => ['two', 'one'].map(rawPost);
  await assert.rejects(ingestMastodonFeed(db, { id: 1 }, client), /did not advance/);
  assert.deepEqual(storedIds(db), ['initial']);
  assert.equal(watermark(db), undefined);
  assert.equal(db.prepare('SELECT ok_count FROM feeds').get().ok_count, 0);
});
