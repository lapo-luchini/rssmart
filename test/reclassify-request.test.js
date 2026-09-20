import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, testConfig } from './helpers.js';
import { createApp } from '../src/server.js';

test('reclassification endpoint versions consecutive requests and preserves validation', async t => {
  const db = tempDb(); t.after(() => db.close());
  db.prepare("INSERT INTO feeds(id,url) VALUES(1,'https://example.invalid/feed')").run();
  db.prepare("INSERT INTO articles(id,feed_id,guid,title,status) VALUES(1,1,'a','A','enriched')").run();
  const app = createApp(db, testConfig());
  const request = (id, note) => app.request(`/api/articles/${id}/reclassify`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({note}),
  });
  for (const [i, note] of ['First', 'Second'].entries()) {
    const response = await request(1, note);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {id:1,status:'pending',enrich_note:note});
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'enrich_request:1'").get().value, String(i+1));
  }
  assert.equal((await request(1, 42)).status, 400);
  assert.equal((await request(404, '')).status, 404);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'enrich_request:1'").get().value, '2');
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'enrich_request:404'").get(), undefined);
});
