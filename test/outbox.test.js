import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutbox } from '../public/outbox.js';

function fakeStorage(initial) {
  const store = new Map(initial ? [['rssmart_outbox', JSON.stringify(initial)]] : []);
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  };
}

function fakeRequest(responses) {
  const calls = [];
  let i = 0;
  const fn = async (path, options) => {
    calls.push({ path, options });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    if (next === 'network-fail') throw new Error('network down');
    return { ok: next < 400, status: next };
  };
  fn.calls = calls;
  return fn;
}

test('enqueue persists to storage immediately, before any flush', () => {
  const storage = fakeStorage();
  const outbox = createOutbox({ storage, request: fakeRequest([200]) });
  outbox.enqueue('/api/articles/1/vote', { method: 'POST' });
  assert.equal(outbox.count, 1);
  assert.deepEqual(JSON.parse(storage.getItem('rssmart_outbox')), [
    { path: '/api/articles/1/vote', options: { method: 'POST' } },
  ]);
});

test('flush drains the queue on success, in FIFO order', async () => {
  const storage = fakeStorage();
  const request = fakeRequest([200, 200, 200]);
  const outbox = createOutbox({ storage, request });
  outbox.enqueue('/api/articles/1/vote', {});
  outbox.enqueue('/api/articles/2/vote', {});
  outbox.enqueue('/api/articles/3/read', {});
  await outbox.flush();
  assert.equal(outbox.count, 0);
  assert.deepEqual(request.calls.map((c) => c.path), [
    '/api/articles/1/vote', '/api/articles/2/vote', '/api/articles/3/read',
  ]);
  assert.deepEqual(JSON.parse(storage.getItem('rssmart_outbox')), []);
});

test('flush stops at the first network failure, leaving the rest queued', async () => {
  const storage = fakeStorage();
  const request = fakeRequest([200, 'network-fail', 200]);
  const outbox = createOutbox({ storage, request });
  outbox.enqueue('/a', {});
  outbox.enqueue('/b', {});
  outbox.enqueue('/c', {});
  await outbox.flush();
  assert.equal(outbox.count, 2, 'the first entry drained, the failing one and everything after it stayed');
  assert.equal(request.calls.length, 2, 'never even attempted the third entry');
});

test('flush stops at a 5xx (transient server issue), same as a network failure', async () => {
  const storage = fakeStorage();
  const request = fakeRequest([503]);
  const outbox = createOutbox({ storage, request });
  outbox.enqueue('/a', {});
  await outbox.flush();
  assert.equal(outbox.count, 1);
});

test('flush drops a 4xx (a real rejection, not a connectivity problem) and continues', async () => {
  const storage = fakeStorage();
  const request = fakeRequest([404, 200]);
  const outbox = createOutbox({ storage, request });
  outbox.enqueue('/gone', {});
  outbox.enqueue('/fine', {});
  await outbox.flush();
  assert.equal(outbox.count, 0, 'the 404 was dropped, not left stuck at the head of the queue forever');
  assert.equal(request.calls.length, 2);
});

test('a queue persists across separate createOutbox instances sharing storage (survives an app restart)', async () => {
  const storage = fakeStorage();
  const first = createOutbox({ storage, request: fakeRequest(['network-fail']) });
  first.enqueue('/api/articles/1/vote', { method: 'POST', body: '{"vote":1}' });
  await first.flush(); // fails, stays queued
  assert.equal(first.count, 1);

  // simulate reopening the app: a fresh outbox instance reading the same storage
  const second = createOutbox({ storage, request: fakeRequest([200]) });
  assert.equal(second.count, 1, 'picked up the entry queued by a previous session');
  await second.flush();
  assert.equal(second.count, 0);
});

test('concurrent flush() calls do not double-send', async () => {
  const storage = fakeStorage();
  const request = fakeRequest([200, 200]);
  const outbox = createOutbox({ storage, request });
  outbox.enqueue('/a', {});
  outbox.enqueue('/b', {});
  await Promise.all([outbox.flush(), outbox.flush()]);
  assert.equal(request.calls.length, 2, 'the second concurrent flush() was a no-op, not a duplicate pass');
});

test('a corrupt or missing storage value is treated as an empty queue, not a crash', () => {
  const storage = fakeStorage();
  storage.setItem('rssmart_outbox', 'not json');
  const outbox = createOutbox({ storage, request: fakeRequest([200]) });
  assert.equal(outbox.count, 0);
});
