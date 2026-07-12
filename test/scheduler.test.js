import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, rssXml, startRssServer, startOllamaStub, testConfig } from './helpers.js';
import { fetchIntervalMinutes, ingestAll, syncFeeds } from '../src/ingest.js';
import { acquireLease, releaseLease } from '../src/lease.js';
import { startScheduler } from '../src/scheduler.js';
import { compressText } from '../src/compress.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('adaptive fetch interval tracks publication rate within bounds', () => {
  const bounds = { minIntervalMin: 15, maxIntervalMin: 1440 };
  assert.equal(fetchIntervalMinutes(0, bounds), 1440, 'silent feed -> max');
  assert.equal(fetchIntervalMinutes(4, bounds), 1440, 'monthly-ish feed clamps to max');
  assert.equal(fetchIntervalMinutes(28, bounds), 1440, 'one/day -> daily');
  assert.equal(fetchIntervalMinutes(28 * 24, bounds), 60, 'hourly feed -> hourly');
  assert.equal(fetchIntervalMinutes(100000, bounds), 15, 'firehose clamps to min');
});

test('dueOnly fetches only due feeds and reschedules them', async () => {
  const db = tempDb();
  const rss = await startRssServer();
  rss.routes.set('/a.xml', rssXml({ items: [{ title: 'A1' }] }));
  rss.routes.set('/b.xml', rssXml({ items: [{ title: 'B1' }] }));

  try {
    syncFeeds(db, [{ url: `${rss.url}/a.xml` }, { url: `${rss.url}/b.xml` }]);
    // feed B was checked recently -> not due
    db.prepare(`UPDATE feeds SET next_fetch_at = strftime('%Y-%m-%dT%H:%M:%SZ','now','+30 minutes')
                WHERE url LIKE '%/b.xml'`).run();

    const r = await ingestAll(db, testConfig(), { dueOnly: true });
    assert.equal(r.feedsOk, 1, 'only the due feed was fetched');
    assert.equal(r.added, 1);

    const a = db.prepare("SELECT next_fetch_at FROM feeds WHERE url LIKE '%/a.xml'").get();
    assert.ok(a.next_fetch_at > new Date().toISOString(), 'fetched feed rescheduled');

    // manual override wins over the adaptive interval
    db.prepare("UPDATE feeds SET fetch_interval_min = 5, next_fetch_at = NULL WHERE url LIKE '%/a.xml'").run();
    await ingestAll(db, testConfig(), { dueOnly: true });
    const a2 = db.prepare("SELECT next_fetch_at FROM feeds WHERE url LIKE '%/a.xml'").get();
    const inMin = (new Date(a2.next_fetch_at) - Date.now()) / 60000;
    assert.ok(inMin > 3 && inMin <= 6, `override ~5min, got ${inMin.toFixed(1)}`);
  } finally {
    await rss.close();
  }
});

test('the enrichment lease is exclusive, stealable when stale, releasable', () => {
  const db = tempDb();
  assert.equal(acquireLease(db, 'p1'), true);
  assert.equal(acquireLease(db, 'p2'), false, 'held by a live owner');
  assert.equal(acquireLease(db, 'p1'), true, 'owner can renew');
  assert.equal(acquireLease(db, 'p2', 0), true, 'stale lease is stolen (ttl 0)');
  releaseLease(db, 'p2');
  assert.equal(acquireLease(db, 'p1'), true, 'free after release');
  releaseLease(db, 'p2'); // non-owner release is a no-op
  assert.equal(acquireLease(db, 'p3'), false, 'p1 still holds it');
});

test('startScheduler fetches due feeds and classifies pending articles', async () => {
  const db = tempDb();
  const rss = await startRssServer();
  const ollama = await startOllamaStub();
  rss.routes.set('/feed.xml', rssXml({ items: [{ title: 'Scheduled story', description: 'body' }] }));

  try {
    syncFeeds(db, [{ url: `${rss.url}/feed.xml` }]);
    const config = testConfig();
    config.ollama.url = ollama.url;

    const logs = [];
    const stop = startScheduler(db, config, {
      log: (m) => logs.push(m),
      fetchEveryMs: 40,
      enrichEveryMs: 40,
      batchMs: 5000,
    });
    try {
      for (let i = 0; i < 50; i++) {
        await sleep(100);
        const done = db.prepare("SELECT COUNT(*) c FROM articles WHERE status='enriched'").get().c;
        if (done === 1) break;
      }
    } finally {
      stop();
    }

    const art = db.prepare('SELECT status, summary, score FROM articles').get();
    assert.equal(art.status, 'enriched', 'article ingested and classified by the scheduler');
    assert.ok(art.summary);
    assert.equal(acquireLease(db, 'outsider'), true, 'lease released when idle');
    assert.ok(
      logs.some((m) => /classified 1 article \(avg \d+(\.\d+)?s each\)/.test(m)),
      `singular form + avg timing in log, got: ${JSON.stringify(logs)}`,
    );
  } finally {
    await ollama.close();
    await rss.close();
  }
});

test('classifying a new article never rescores unrelated already-scored articles', async () => {
  // The whole point of the fix this guards: an unvoted article joining an
  // existing topic doesn't change that topic's (vote-driven) preference,
  // so classifying it must never trigger a full-corpus recomputeScores()
  // sweep - which, against a real archive, is slow enough to block every
  // concurrent request (measured live: ~48s for ~6k articles) - only the
  // newly-classified article's own score should change.
  const db = tempDb();
  const rss = await startRssServer();
  const ollama = await startOllamaStub();
  rss.routes.set('/feed.xml', rssXml({ items: [{ title: 'New story', description: 'body' }] }));

  try {
    db.prepare("INSERT INTO feeds (id, url) VALUES (99, 'http://other-feed')").run();
    const untouchedScore = 0.4242;
    const { lastInsertRowid: otherId } = db.prepare(`
      INSERT INTO articles (feed_id, guid, title, content, status, vote, score, score_topics)
      VALUES (99, 'g-other', 'Unrelated already-scored article', ?, 'enriched', 1, ?, ?)
    `).run(compressText('body'), untouchedScore, untouchedScore);

    syncFeeds(db, [{ url: `${rss.url}/feed.xml` }]);
    const config = testConfig();
    config.ollama.url = ollama.url;

    const stop = startScheduler(db, config, {
      log: () => {},
      fetchEveryMs: 40,
      enrichEveryMs: 40,
      batchMs: 5000,
    });
    try {
      for (let i = 0; i < 50; i++) {
        await sleep(100);
        const done = db.prepare("SELECT COUNT(*) c FROM articles WHERE status='enriched' AND id != ?").get(otherId).c;
        if (done === 1) break;
      }
    } finally {
      stop();
    }

    const other = db.prepare('SELECT score, score_topics FROM articles WHERE id = ?').get(otherId);
    assert.equal(other.score, untouchedScore, 'unrelated article\'s score untouched by classifying a new one');
    assert.equal(other.score_topics, untouchedScore);
  } finally {
    await ollama.close();
    await rss.close();
  }
});
