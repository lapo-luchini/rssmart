import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, testConfig } from './helpers.js';
import { scheduleRecompute, recomputeIfDue, recomputeOneScore } from '../src/scoring.js';

test('a same-second zero-debounce vote survives the running sweep and updates the remaining corpus', async t => {
  const db = tempDb();
  t.after(() => db.close());
  db.function('strftime', { varargs: true }, () => '2026-09-20T10:00:00Z');
  db.prepare("INSERT INTO feeds (id,url) VALUES (1,'https://example.invalid/feed')").run();
  db.prepare("INSERT INTO topics(id,name) VALUES(1,'revision')").run();
  for (let id = 1; id <= 3; id++) {
    db.prepare("INSERT INTO articles(id,feed_id,guid,title,status,vote) VALUES(?,1,?,?,'enriched',?)")
      .run(id, String(id), 'Fixture', id === 1 ? 1 : 0);
    db.prepare('INSERT INTO article_topics(article_id,topic_id) VALUES(?,1)').run(id);
  }
  const cfg = testConfig();
  cfg.scoring.recomputeDebounceSec = 0;
  const pending = () => db.prepare("SELECT value FROM meta WHERE key='score_recompute_due_at'").get()?.value;
  const value = () => db.prepare('SELECT score FROM articles WHERE id=2').get().score;
  scheduleRecompute(db, 0);
  const firstDue = pending();
  const sweep = recomputeIfDue(db, cfg, { yieldEveryMs: 0 });
  db.prepare('UPDATE articles SET vote=-1 WHERE id=1').run();
  recomputeOneScore(db, cfg, 1);
  scheduleRecompute(db, 0);
  assert.equal(pending(), firstDue, 'timestamps deliberately collide');
  await sweep;
  assert.ok(pending(), 'the newer revision must remain pending');
  assert.ok(value() > 0, 'the first sweep used the preceding preference snapshot');
  assert.ok(await recomputeIfDue(db, cfg), 'the second revision is consumed');
  assert.ok(value() < 0, 'the second sweep propagates the negative vote');
  assert.equal(await recomputeIfDue(db, cfg), false);
});

test('legacy pending markers without a revision are still consumed', async t => {
  const db = tempDb();
  t.after(() => db.close());
  db.prepare("INSERT INTO meta(key,value) VALUES('score_recompute_due_at','2000-01-01T00:00:00Z')").run();
  assert.ok(await recomputeIfDue(db, testConfig()));
  assert.equal(await recomputeIfDue(db, testConfig()), false);
});
