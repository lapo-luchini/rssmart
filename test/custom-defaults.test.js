import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, testConfig } from './helpers.js';
import { createApp } from '../src/server.js';

test('custom defaults apply configured contributions once and reset reproduces hot ranking', async t => {
  const db = tempDb(); t.after(() => db.close());
  db.prepare("INSERT INTO feeds(id,url) VALUES(1,'https://example.invalid/feed')").run();
  const insert = db.prepare(`INSERT INTO articles(id,feed_id,guid,title,status,published_at,
    score,score_topics,score_embedding,score_depth,score_feed,score_bonus)
    VALUES(?,1,?,?,'enriched',?,?,?,?,?,?,?)`);
  insert.run(1,'a','A','2026-09-01T00:00:00Z',.18,.18,0,0,0,0);
  insert.run(2,'b','B','2026-09-01T00:00:00Z',.20,0,0,.1,.1,0);
  insert.run(3,'c','C','2026-08-01T00:00:00Z',.4,.2,.2,0,0,0);
  const config = testConfig();
  config.scoring.weights = { topics:.3, embedding:.4, depth:.1, feed:.2 };
  config.scoring.hotDecayPerDay = .01;
  const app = createApp(db, config);
  const ids = async query => {
    const response = await app.request('/api/articles?view=all&dupes=1&' + query);
    assert.equal(response.status, 200);
    return (await response.json()).articles.map(row => row.id);
  };
  const info = await (await app.request('/api/info')).json();
  assert.deepEqual(info.weightProfile, {topics:1,embedding:1,depth:1,feed:1,bonus:1,decay:.01});
  const reset = new URLSearchParams(Object.entries(info.weightProfile).map(([k,v]) => ['w_'+k,String(v)]));
  assert.deepEqual(await ids('sort=custom'), await ids('sort=hot'));
  assert.deepEqual(await ids('sort=custom&'+reset), await ids('sort=hot'));
  assert.deepEqual(await ids('sort=custom&w_decay=0'), await ids('sort=score'));
  assert.deepEqual(await ids('sort=custom&w_decay=0&w_topics=0'), [2,3,1]);
});
