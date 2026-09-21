import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDb, testConfig } from './helpers.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';

function seed(db) {
  db.prepare("INSERT INTO feeds(id,url,title) VALUES(1,'https://example.invalid/feed','Original')").run();
  db.prepare(`INSERT INTO articles(id,feed_id,guid,title,status,vote,published_at)
    VALUES(1,1,'a','A','enriched',1,'2026-08-23T00:00:00Z')`).run();
}
const feeds = async app => {
  const response = await app.request('/api/feeds');
  assert.equal(response.status, 200);
  return response.json();
};

test('feed cache refreshes on equal-count vote changes and metadata edits', async t => {
  const db = tempDb(); t.after(() => db.close()); seed(db);
  const app = createApp(db, testConfig());
  assert.equal((await feeds(app))[0].avg_vote, 1);
  db.prepare('UPDATE articles SET vote = -1 WHERE id = 1').run();
  assert.equal((await feeds(app))[0].avg_vote, -1);
  db.prepare("UPDATE feeds SET title = 'Changed', last_status = 'failed' WHERE id = 1").run();
  const [row] = await feeds(app);
  assert.equal(row.title, 'Changed');
  assert.equal(row.last_status, 'failed');
});

test('feed cache notices commits on another connection', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rssmart-feed-cache-'));
  const db = openDb(join(dir, 'test.db')), other = openDb(join(dir, 'test.db'));
  t.after(() => { other.close(); db.close(); rmSync(dir, {recursive:true,force:true}); });
  seed(db);
  const app = createApp(db, testConfig());
  assert.equal((await feeds(app))[0].avg_vote, 1);
  other.prepare('UPDATE articles SET vote = 2 WHERE id = 1').run();
  assert.equal((await feeds(app))[0].avg_vote, 2);
});

test('weekly rate expires at the 28-day boundary without any database writes', async t => {
  const db = tempDb(); t.after(() => db.close()); seed(db);
  let now = Date.parse('2026-09-20T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const app = createApp(db, testConfig());
  assert.equal((await feeds(app))[0].per_week, 0.3);
  now += 1000;
  assert.equal((await feeds(app))[0].per_week, 0);
});
