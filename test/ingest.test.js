import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, rssXml, startRssServer, testConfig } from './helpers.js';
import { syncFeeds, ingestAll } from '../src/ingest.js';

test('syncFeeds seeds config feeds without touching UI-managed state', () => {
  const db = tempDb();
  syncFeeds(db, [{ url: 'http://a.example/rss', title: 'A' }, { url: 'http://b.example/rss' }]);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM feeds WHERE active = 1').get().c, 2);

  // A feed disabled in the UI stays disabled; one missing from the config
  // stays active — the DB is the source of truth.
  db.prepare("UPDATE feeds SET active = 0 WHERE url = 'http://b.example/rss'").run();
  syncFeeds(db, [{ url: 'http://b.example/rss' }]);
  const rows = db.prepare('SELECT url, active FROM feeds ORDER BY url').all();
  assert.deepEqual(rows, [
    { url: 'http://a.example/rss', active: 1 },
    { url: 'http://b.example/rss', active: 0 },
  ]);
});

test('ingestAll inserts items once and is idempotent', async () => {
  const db = tempDb();
  const rss = await startRssServer();
  rss.routes.set('/feed.xml', rssXml({
    title: 'My Feed',
    items: [
      { title: 'First post', description: '<p>Hello <script>alert(1)</script>world</p>', pubDate: 'Sat, 04 Jul 2026 10:00:00 GMT' },
      { title: 'Second post', description: 'More news' },
    ],
  }));

  try {
    syncFeeds(db, [{ url: `${rss.url}/feed.xml` }]);
    const first = await ingestAll(db, testConfig());
    assert.equal(first.added, 2);
    assert.equal(first.feedsOk, 1);

    const again = await ingestAll(db, testConfig());
    assert.equal(again.added, 0, 'second run adds nothing');

    const art = db.prepare("SELECT * FROM articles WHERE title = 'First post'").get();
    assert.equal(art.status, 'pending');
    assert.ok(art.published_at?.startsWith('2026-07-04'));
    assert.ok(!art.content.includes('<script>'), 'scripts are stripped');
    assert.ok(art.content.includes('world'));

    const feed = db.prepare('SELECT title, last_status FROM feeds').get();
    assert.equal(feed.title, 'My Feed', 'feed title backfilled from RSS');
    assert.equal(feed.last_status, 'ok');
  } finally {
    await rss.close();
  }
});

test('a failing feed is recorded and does not abort other feeds', async () => {
  const db = tempDb();
  const rss = await startRssServer();
  rss.routes.set('/good.xml', rssXml({ items: [{ title: 'Works' }] }));

  try {
    syncFeeds(db, [
      { url: `${rss.url}/good.xml` },
      { url: `${rss.url}/missing.xml` },
    ]);
    const result = await ingestAll(db, testConfig());
    assert.equal(result.feedsOk, 1);
    assert.equal(result.feedsFailed, 1);
    assert.equal(result.added, 1);

    const bad = db.prepare('SELECT last_status FROM feeds WHERE url LIKE ?').get('%missing%');
    assert.match(bad.last_status, /^error:/);
  } finally {
    await rss.close();
  }
});
