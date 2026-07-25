import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, testConfig, startApp } from './helpers.js';
import { createApp } from '../src/server.js';
import { compressText } from '../src/compress.js';

// Minimal line-based lookup, not a full Prometheus text-format parser —
// proportionate to what these tests need (exact metric lines), and easier
// to read than a generic parser would be for four labeled samples.
function metricValue(text, name, labels) {
  const labelStr = labels
    ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}`
    : '';
  const escaped = `${name}${labelStr}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^${escaped} (\\S+)$`, 'm'));
  return match ? Number(match[1]) : undefined;
}

test('metrics endpoint reports article, vote, feed, topic and db counts', async () => {
  const db = tempDb();
  db.prepare("INSERT INTO feeds (id, url, active) VALUES (1, 'http://a', 1)").run();
  db.prepare("INSERT INTO feeds (id, url, active) VALUES (2, 'http://b', 0)").run();
  db.prepare('UPDATE feeds SET ok_count = 10, error_count = 2 WHERE id = 1').run();
  db.prepare('UPDATE feeds SET ok_count = 3, error_count = 1 WHERE id = 2').run();

  const body = compressText('body');
  const insArt = db.prepare(`
    INSERT INTO articles (feed_id, guid, title, content, status, vote, read_at, duplicate_of)
    VALUES (1, ?, 'x', ?, ?, ?, ?, ?)
  `);
  insArt.run('g1', body, 'enriched', 1, '2026-01-01T00:00:00Z', null);
  insArt.run('g2', body, 'enriched', -1, null, null);
  insArt.run('g3', body, 'pending', 0, null, null);
  const root = Number(insArt.run('g4', body, 'enriched', 0, null, null).lastInsertRowid);
  insArt.run('g5', body, 'enriched', 2, '2026-01-01T00:00:00Z', root);

  db.prepare("INSERT INTO topics (name) VALUES ('a'), ('b')").run();

  const app = createApp(db, testConfig(), 'abc1234');
  const server = await startApp(app);
  try {
    const res = await fetch(`${server.url}/metrics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/plain/);
    const text = await res.text();

    assert.equal(metricValue(text, 'rssmart_articles_count'), 5);
    assert.equal(metricValue(text, 'rssmart_articles', { status: 'enriched' }), 4);
    assert.equal(metricValue(text, 'rssmart_articles', { status: 'pending' }), 1);
    assert.equal(metricValue(text, 'rssmart_articles', { status: 'error' }), 0);
    assert.equal(metricValue(text, 'rssmart_articles_read'), 2);
    assert.equal(metricValue(text, 'rssmart_articles_duplicates'), 1);

    assert.equal(metricValue(text, 'rssmart_votes', { value: '1' }), 1);
    assert.equal(metricValue(text, 'rssmart_votes', { value: '-1' }), 1);
    assert.equal(metricValue(text, 'rssmart_votes', { value: '2' }), 1);
    assert.equal(metricValue(text, 'rssmart_votes', { value: '-2' }), 0, 'zero-count vote values are still reported');

    assert.equal(metricValue(text, 'rssmart_feeds', { active: 'true' }), 1);
    assert.equal(metricValue(text, 'rssmart_feeds', { active: 'false' }), 1);
    assert.equal(metricValue(text, 'rssmart_feed_fetches_total', { result: 'ok' }), 13);
    assert.equal(metricValue(text, 'rssmart_feed_fetches_total', { result: 'error' }), 3);

    assert.equal(metricValue(text, 'rssmart_topics'), 2);
    assert.ok(metricValue(text, 'rssmart_db_bytes') >= 0);
    assert.equal(metricValue(text, 'rssmart_build_info', { commit: 'abc1234' }), 1);

    assert.ok(metricValue(text, 'process_start_time_seconds') > 0);
    assert.ok(metricValue(text, 'process_resident_memory_bytes') > 0);
    assert.ok(metricValue(text, 'nodejs_heap_size_used_bytes') > 0);
    assert.ok(metricValue(text, 'nodejs_heap_size_total_bytes') > 0);

    // Every metric line is preceded by its own HELP/TYPE — spot-check one.
    assert.match(text, /# HELP rssmart_votes Number of articles with a given \(non-zero\) vote value\.\n# TYPE rssmart_votes gauge/);
  } finally {
    await server.close();
  }
});

test('metrics endpoint on an empty database reports zeros, not errors', async () => {
  const db = tempDb();
  const app = createApp(db, testConfig(), null);
  const server = await startApp(app);
  try {
    const res = await fetch(`${server.url}/metrics`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(metricValue(text, 'rssmart_articles_count'), 0);
    assert.equal(metricValue(text, 'rssmart_votes', { value: '1' }), 0);
    assert.equal(metricValue(text, 'rssmart_feeds', { active: 'true' }), 0);
    assert.equal(metricValue(text, 'rssmart_build_info', { commit: 'unknown' }), 1);
  } finally {
    await server.close();
  }
});
