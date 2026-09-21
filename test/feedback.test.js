import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { testConfig } from './helpers.js';
import { createOutbox } from '../public/outbox.js';
import { memoryStorage } from './feedbackStorage.js';

function seed(path = ':memory:') {
  const db = openDb(path);
  db.exec("INSERT INTO feeds(id,url) VALUES (1,'https://example.test/feed'); INSERT INTO articles(id,feed_id,guid,title) VALUES (1,1,'a','Article'),(2,1,'b','Other');");
  return db;
}
const bodyFor = (operation, value, sequence, clientId = 'test-client') => ({ [operation]: value, mutation: { clientId, sequence } });
const send = (app, operation, value, sequence, clientId) => app.request(`/api/articles/1/${operation}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodyFor(operation, value, sequence, clientId)),
});
const state = db => db.prepare('SELECT vote, voted_at, read_at FROM articles WHERE id = 1').get();

test('vote/read share contiguous order; future read cannot skip an earlier vote', async t => {
  const db = seed(); t.after(() => db.close()); const app = createApp(db, testConfig());
  assert.equal((await send(app, 'read', false, 2)).status, 409);
  assert.equal((await send(app, 'vote', 1, 1)).status, 200);
  assert.ok(state(db).read_at);
  assert.equal((await send(app, 'read', false, 2)).status, 200);
  assert.deepEqual([state(db).vote, state(db).read_at], [1, null]);
  assert.equal((await send(app, 'vote', 1, 1)).status, 200);
  assert.deepEqual([state(db).vote, state(db).read_at], [1, null]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM feedback_receipts').get().n, 2);
});

test('lost-response replay never re-dates feedback or reschedules scoring', async t => {
  const db = seed(); t.after(() => db.close()); const app = createApp(db, testConfig());
  await send(app, 'vote', 1, 1);
  db.exec("UPDATE articles SET voted_at='2001-01-01T00:00:00Z', read_at='2001-01-01T00:00:00Z' WHERE id=1");
  const before = state(db);
  const revision = db.prepare("SELECT value FROM meta WHERE key='score_recompute_revision'").get().value;
  assert.equal((await send(app, 'vote', 1, 1)).status, 200);
  assert.deepEqual(state(db), before);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='score_recompute_revision'").get().value, revision);
  assert.equal((await send(app, 'vote', -1, 1)).status, 409);
  assert.deepEqual(state(db), before);
});

test('vote followed by retraction preserves read, followed by unread clears it', async t => {
  const db = seed(); t.after(() => db.close()); const app = createApp(db, testConfig());
  await send(app, 'vote', 1, 1); await send(app, 'vote', 0, 2);
  assert.equal(state(db).vote, 0); assert.ok(state(db).read_at);
  await send(app, 'read', false, 3); await send(app, 'vote', 0, 2);
  assert.equal(state(db).read_at, null);
  await send(app, 'vote', -2, 4); assert.ok(state(db).read_at);
});

test('receipts survive database reopen and invalid requests consume no sequence', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rssmart-feedback-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'test.db'); let db = seed(path);
  let app = createApp(db, testConfig());
  assert.equal((await send(app, 'vote', 9, 1)).status, 400);
  await send(app, 'vote', 1, 1); await send(app, 'vote', -1, 2); const before = state(db); db.close();
  db = openDb(path); t.after(() => db.close()); app = createApp(db, testConfig());
  assert.equal((await send(app, 'vote', 1, 1)).status, 200); assert.deepEqual(state(db), before);
  assert.equal((await send(app, 'read', true, 2)).status, 409);
  assert.equal((await send(app, 'read', true, 3)).status, 200);
});

test('receipt and article mutation roll back together on a write failure', async t => {
  const db = seed(); t.after(() => db.close()); const app = createApp(db, testConfig());
  db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON feedback_receipts BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
  assert.equal((await send(app, 'vote', 1, 1)).status, 500);
  assert.equal(state(db).vote, 0); assert.equal(state(db).voted_at, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM feedback_receipts').get().n, 0);
  db.exec('DROP TRIGGER reject_receipt');
  assert.equal((await send(app, 'vote', 1, 1)).status, 200);
});

test('independent clients use receipt order, without pretending to order offline intentions across devices', async t => {
  const db = seed(); t.after(() => db.close()); const app = createApp(db, testConfig());
  await send(app, 'vote', 1, 1, 'client-one'); await send(app, 'vote', -1, 1, 'client-two');
  await send(app, 'vote', 1, 1, 'client-one'); assert.equal(state(db).vote, -1);
  await send(app, 'vote', 2, 2, 'client-one'); assert.equal(state(db).vote, 2);
});

test('C13 plus response loss: queued old vote never overwrites newer intent', async t => {
  const db = seed(); t.after(() => db.close()); const app = createApp(db, testConfig());
  const disk = memoryStorage(); let time = 0; let calls = 0;
  const box = createOutbox({ storage: disk, now: () => time,
    request: async (path, options) => {
      const res = await app.request(path, options);
      if (++calls === 1) throw new Error('response lost after commit');
      return res;
    } });
  const put = vote => box.enqueue('/api/articles/1/vote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vote }) });
  await put(1); await box.flush(); assert.equal(state(db).vote, 1);
  await put(-1); time += 20_000; await box.flush();
  assert.equal(state(db).vote, -1); assert.equal(box.count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM feedback_receipts').get().n, 2);
});

test('legacy API clients remain accepted but do not acquire retry guarantees', async t => {
  const db = seed(); t.after(() => db.close()); const app = createApp(db, testConfig());
  const res = await app.request('/api/articles/1/vote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"vote":1}' });
  assert.equal(res.status, 200); assert.equal(state(db).vote, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM feedback_receipts').get().n, 0);
});

test('v21 migration preserves existing feedback and creates empty receipts', t => {
  const directory = mkdtempSync(join(tmpdir(), 'rssmart-feedback-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'test.db'); let db = seed(path);
  db.exec("UPDATE articles SET vote=-2, voted_at='2020-01-01T00:00:00Z' WHERE id=1; DROP TABLE feedback_receipts; PRAGMA user_version=21;");
  const before = state(db); db.close(); db = openDb(path); t.after(() => db.close());
  assert.deepEqual(state(db), before);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 22);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM feedback_receipts').get().n, 0);
});

test('invalid mutation identities and sequences are rejected without consuming a receipt', async t => {
  const db = seed(); t.after(() => db.close()); const app = createApp(db, testConfig());
  for (const mutation of [null, {}, { clientId: 12345678, sequence: 1 },
    { clientId: 'client-one', sequence: 0 }, { clientId: 'client-one', sequence: '1' },
    { clientId: 'client-one', sequence: Number.MAX_SAFE_INTEGER + 1 }]) {
    const res = await app.request('/api/articles/1/vote', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vote: 1, mutation }) });
    assert.equal(res.status, 400);
  }
  assert.equal(state(db).vote, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM feedback_receipts').get().n, 0);
});
