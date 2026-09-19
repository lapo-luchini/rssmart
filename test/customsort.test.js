import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, testConfig, startApp } from './helpers.js';
import { createApp } from '../src/server.js';

function titlesOf(meta, body) {
  return body.articles.map((a) => a.title);
}

test('custom sort reorders by clamped user weights over the stored per-signal components', async () => {
  const db = tempDb();
  db.prepare("INSERT INTO feeds (id, url) VALUES (1, 'http://f')").run();
  const ins = db.prepare(`
    INSERT INTO articles (feed_id, guid, title, content, summary, status, score_topics, score_embedding, score_depth, score_feed)
    VALUES (1, ?, ?, 'body', 'sum', 'enriched', ?, ?, ?, ?)
  `);
  ins.run('c1', 'Available: topics heavy', 1.0, 0.0, 0.0, 0.0);
  ins.run('c2', 'Available: embedding heavy', 0.0, 1.0, 0.0, 0.0);

  const app = createApp(db, testConfig());
  const server = await startApp(app);
  try {
    const titles = async (qs) =>
      (await (await fetch(`${server.url}/api/articles?${qs}`)).json()).articles.map((a) => a.title);

    // topics-only weighting puts the topics-heavy article first
    assert.deepEqual(
      await titles('view=all&sort=custom&w_topics=1&w_embedding=0&w_depth=0&w_feed=0&w_bonus=0&w_decay=0'),
      ['Available: topics heavy', 'Available: embedding heavy'],
    );

    // flipped weights invert the order — each slider axis participates on its own
    assert.deepEqual(
      await titles('view=all&sort=custom&w_topics=0&w_embedding=1&w_depth=0&w_feed=0&w_bonus=0&w_decay=0'),
      ['Available: embedding heavy', 'Available: topics heavy'],
    );

    // missing weights fall back to the configured scoring profile
    const fallback = await fetch(`${server.url}/api/articles?view=all&sort=custom`);
    assert.equal(fallback.status, 200);

    // malformed / out-of-range weights are clamped, not poisoned
    const clamped = await fetch(
      `${server.url}/api/articles?view=all&sort=custom&w_topics=1e19&w_embedding=notanumber&w_decay=-5`,
    );
    assert.equal(clamped.status, 200);
  } finally {
    await server.close();
  }
});
