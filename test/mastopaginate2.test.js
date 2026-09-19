import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mastodon } from '../src/mastodon.js';
import { ingestMastodonFeed, syncMastodonFeed } from '../src/ingest.js';
import { tempDb, testConfig } from './helpers.js';
import http from "node:http";
import { compressText } from '../src/compress.js';

const PAGE = 40;
const timeline = [];
const BASE_ID = 9000;
for (let i = 1; i <= 100; i++) {
  timeline.push({
    id: String(BASE_ID + i),
    created_at: new Date(BASE_ID + i),
    content: `<p>Toot number ${i}</p>`,
    account: { acct: 'tester', display_name: 'Tester' },
    url: `https://mastodon.example/@tester/${BASE_ID + i}`,
  });
}

const startFakeServer = () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const limit = Number(url.searchParams.get('limit') ?? PAGE);
    const minId = url.searchParams.get('min_id');
    const sinceId = url.searchParams.get('since_id');

    let slice;
    if (minId) {
      const newer = timeline
        .filter((s) => Number(s.id) > Number(minId))
        .sort((l, r) => Number(l.id) - Number(r.id))
        .slice(0, limit);
      slice = newer.reverse(); // wire order: newest first
    } else if (sinceId) {
      const newer = timeline.filter((s) => Number(s.id) > Number(sinceId));
      slice = newer.slice(-limit).reverse();
    } else {
      slice = timeline.slice(-limit).reverse();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(slice));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
};

test('ingest consumes >40 mastodon posts per window without permanent loss', async () => {
  const fake = await startFakeServer();
  try {
    const client = new Mastodon({ url: fake.url, token: 't' });
    const db = tempDb();
    db.prepare("INSERT INTO feeds (id, url, type) VALUES (1, 'https://mastodon.example', 'mastodon')").run();
    const feed = { id: 1 };

    // run 1: a fresh feed imports the newest 40 (no watermark exists yet)
    const first = await ingestMastodonFeed(db, feed, client);
    assert.equal(first.added, PAGE, 'a fresh feed imports the newest page');

    // >40 posts generated in a single window between runs: without
    // pagination these would be dropped permanently (since_id would skip
    // the oldest of each 40-post page). All of them must be picked up.
    for (let i = 101; i <= 160; i++) {
      timeline.push({
        id: String(BASE_ID + i),
        created_at: new Date(BASE_ID + i),
        content: `<p>Late toot ${i}</p>`,
        account: { acct: 'tester', display_name: 'Tester' },
        url: `https://mastodon.example/@tester/${BASE_ID + i}`,
      });
    }

    // run 2: paginated min_id walk covers all 60 new posts
    const second = await ingestMastodonFeed(db, feed, client);
    assert.equal(second.added, 60, 'the min_id walk paginates through the whole gap');

    const stored = db.prepare('SELECT COUNT(*) c FROM articles WHERE feed_id = 1').get().c;
    assert.equal(stored, 100, 'every post exists');
  } finally {
    await fake.close();
  }
});
