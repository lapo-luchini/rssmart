import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutbox } from '../public/outbox.js';

function storage(initial = null) {
  let value = initial;
  return { getItem: () => value, setItem: (_, next) => { value = next; } };
}
const options = (field, value) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [field]: value }) });
const enqueue = (box, value = 1, id = 1, field = 'vote') => box.enqueue(`/api/articles/${id}/${field}`, options(field, value));
const ok = id => new Response(JSON.stringify({ id: Number(id) }), { status: 200 });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function locks() {
  const tails = new Map();
  return { request(name, fn) {
    const next = (tails.get(name) ?? Promise.resolve()).then(fn);
    tails.set(name, next.catch(() => {}));
    return next;
  } };
}

test('persists before sending, including per-article sequences shared by vote and read', async () => {
  const disk = storage(); let calls = 0;
  const box = createOutbox({ storage: disk, request: async () => { calls++; return ok(1); } });
  const vote = await enqueue(box);
  const read = await enqueue(box, false, 1, 'read');
  const other = await enqueue(box, -1, 2);
  assert.equal(calls, 0);
  assert.deepEqual([vote.sequence, read.sequence, other.sequence], [1, 2, 1]);
  assert.equal(JSON.parse(disk.getItem()).entries.length, 3);
  assert.equal(JSON.parse(vote.options.body).mutation.sequence, 1);
});

test('401 suspends without dropping and resumes after authentication, even after restart', async () => {
  const disk = storage(); let calls = 0;
  const first = createOutbox({ storage: disk, request: async () => { calls++; return new Response('{}', { status: 401 }); } });
  await enqueue(first); await first.flush(); await first.flush();
  assert.equal(first.count, 1); assert.equal(first.issue.status, 401); assert.equal(calls, 1);
  const next = createOutbox({ storage: disk, request: async () => ok(1) });
  await next.flush({ retryAuth: true });
  assert.equal(next.count, 0); assert.equal(next.issue, null);
});

test('429 Retry-After is respected by automatic and explicit retries', async () => {
  let time = 100_000; let calls = 0;
  const box = createOutbox({ storage: storage(), now: () => time, request: async () => ++calls === 1
    ? new Response('{}', { status: 429, headers: { 'Retry-After': '60' } }) : ok(1) });
  await enqueue(box); await box.flush();
  time += 59_000; await box.flush({ retryErrors: true });
  assert.equal(calls, 1); assert.equal(box.count, 1);
  time += 1000; await box.flush(); assert.equal(calls, 2); assert.equal(box.count, 0);
});

test('Retry-After HTTP dates survive a reload', async () => {
  let time = Date.parse('2026-09-20T00:00:00Z'); const disk = storage();
  const first = createOutbox({ storage: disk, now: () => time, request: async () => new Response('{}', {
    status: 429, headers: { 'Retry-After': 'Sun, 20 Sep 2026 00:01:00 GMT' },
  }) });
  await enqueue(first); await first.flush();
  let calls = 0;
  const next = createOutbox({ storage: disk, now: () => time, request: async () => { calls++; return ok(1); } });
  await next.flush(); assert.equal(calls, 0);
  time += 60_000; await next.flush(); assert.equal(next.count, 0);
});

for (const status of ['network', 408, 425, 503]) {
  test(`${status} keeps all intents, backs off and resumes in FIFO order`, async () => {
    let time = 0; const calls = [];
    const box = createOutbox({ storage: storage(), now: () => time, request: async (path, opts) => {
      calls.push(JSON.parse(opts.body));
      if (calls.length === 1) {
        if (status === 'network') throw new Error('offline');
        return new Response('{}', { status });
      }
      return ok(1);
    } });
    await enqueue(box, 1); await box.flush();
    await enqueue(box, -1); await box.flush();
    assert.equal(box.count, 2); assert.equal(calls.length, 1);
    time += 20_000; await box.flush();
    assert.deepEqual(calls.map(body => body.vote), [1, 1, -1]);
    assert.equal(box.count, 0);
  });
}

for (const status of [400, 404, 409]) {
  test(`${status} is retained visibly, never silently dropped or automatically renumbered`, async () => {
    const calls = [];
    const box = createOutbox({ storage: storage(), request: async (_, opts) => {
      calls.push(opts.body); return new Response(JSON.stringify({ error: 'rejected' }), { status });
    } });
    await enqueue(box); await box.flush(); await box.flush();
    assert.equal(box.count, 1); assert.equal(box.issue.permanent, true); assert.equal(calls.length, 1);
    await box.flush({ retryErrors: true });
    assert.equal(calls[1], calls[0]); assert.equal(box.count, 1);
  });
}

test('an enqueue during an in-flight request is not removed with its predecessor', async () => {
  const started = deferred(); const release = deferred(); const calls = [];
  const box = createOutbox({ storage: storage(), request: async (_, opts) => {
    calls.push(JSON.parse(opts.body));
    if (calls.length === 1) { started.resolve(); await release.promise; }
    return ok(1);
  } });
  await enqueue(box, 1); const flush = box.flush(); await started.promise;
  await enqueue(box, -1); const concurrent = box.flush();
  assert.equal(box.count, 2); release.resolve(); await Promise.all([flush, concurrent]);
  assert.deepEqual(calls.map(body => body.vote), [1, -1]); assert.equal(box.count, 0);
});

test('a permanent rejection blocks that article without blocking unrelated feedback', async () => {
  const calls = [];
  const box = createOutbox({ storage: storage(), request: async (path, opts) => {
    calls.push(JSON.parse(opts.body));
    return path.includes('/1/') ? new Response('{}', { status: 404 }) : ok(2);
  } });
  await enqueue(box, 1, 1); await enqueue(box, -1, 1); await enqueue(box, 1, 2);
  await box.flush();
  assert.equal(box.count, 2); assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(body => body.mutation.sequence), [1, 1]);
});

test('two tabs using Web Locks share storage and send each operation once', async () => {
  const disk = storage(); const sharedLocks = locks(); const calls = [];
  const request = async (_, opts) => { calls.push(JSON.parse(opts.body)); return ok(1); };
  const a = createOutbox({ storage: disk, locks: sharedLocks, request });
  const b = createOutbox({ storage: disk, locks: sharedLocks, request });
  await Promise.all([enqueue(a, 1), enqueue(b, -1)]);
  await Promise.all([a.flush(), b.flush()]);
  assert.deepEqual(calls.map(body => body.mutation.sequence), [1, 2]);
  assert.equal(calls[0].mutation.clientId, calls[1].mutation.clientId);
  assert.equal(a.count, 0); assert.equal(b.count, 0);
});

test('legacy queues get durable identities while preserving vote/read side effects', async () => {
  const disk = storage(JSON.stringify([
    { path: '/api/articles/1/vote', options: options('vote', 1) },
    { path: '/api/articles/1/vote', options: options('vote', 0) },
    { path: '/api/articles/1/read', options: options('read', false) },
  ]));
  const bodies = [];
  const box = createOutbox({ storage: disk, request: async (_, opts) => {
    bodies.push(JSON.parse(opts.body)); return ok(1);
  } });
  assert.deepEqual(box.project({ id: 1, vote: 0, read_at: null }), { id: 1, vote: 0, read_at: null });
  await box.flush();
  assert.deepEqual(bodies.map(body => body.mutation.sequence), [1, 2, 3]);
  assert.deepEqual(bodies.map(body => body.vote ?? body.read), [1, 0, false]);
  const reopened = createOutbox({ storage: disk });
  assert.equal((await enqueue(reopened)).sequence, 4);
});

test('unreadable acknowledgements retain the exact mutation for safe replay', async () => {
  const box = createOutbox({ storage: storage(), request: async () => new Response('not json') });
  const entry = await enqueue(box); await box.flush();
  assert.equal(box.count, 1); assert.equal(box.project({ id: 1, vote: 0 }).vote, 1);
  assert.equal(JSON.parse(entry.options.body).mutation.sequence, 1);
});

test('storage errors do not report successful persistence or erase corrupt data', async () => {
  const disk = storage('corrupt'); const box = createOutbox({ storage: disk });
  await assert.rejects(enqueue(box)); await box.flush();
  assert.equal(disk.getItem(), 'corrupt'); assert.match(box.issue.message, /Cannot access/);
  const full = createOutbox({ storage: { getItem: () => null, setItem: () => { throw new Error('quota'); } } });
  await assert.rejects(enqueue(full), /quota/);
});

test('shared acknowledgements retain each field revision across tabs and reloads', async () => {
  const disk = storage(); const sharedLocks = locks();
  const writer = createOutbox({ storage: disk, locks: sharedLocks, request: async (path) => new Response(JSON.stringify(
    path.endsWith('/vote') ? { id: 1, vote: 1, read_at: 'first', voted_at: 'voted', score: .2, unexpectedContent: 'not persisted' }
      : { id: 1, read_at: null },
  )) });
  await enqueue(writer, 1); await writer.flush();
  const since = writer.revision;
  await enqueue(writer, false, 1, 'read'); await writer.flush();
  const reader = createOutbox({ storage: disk, locks: sharedLocks });
  assert.equal(reader.revision, 2); assert.equal(reader.count, 0);
  // The read ack is newer than this GET; the old vote ack is not.
  const response = { id: 1, vote: -2, read_at: 'stale', score: .9 };
  assert.deepEqual(reader.project(response, since), { ...response, read_at: null });
  const beforeBoth = reader.project(response, 0);
  assert.equal(beforeBoth.vote, 1); assert.equal(beforeBoth.read_at, null); assert.equal(beforeBoth.score, .2);
  // A fresh GET can observe another device; historical local acks do not
  // pin the UI forever to this browser's last vote.
  assert.deepEqual(reader.project(response, reader.revision), response);
  const saved = JSON.parse(disk.getItem());
  assert.equal(saved.acknowledged['1'].vote.revision, 1);
  assert.equal(saved.acknowledged['1'].read_at.revision, 2);
  assert.equal(saved.acknowledged['1'].unexpectedContent, undefined);
});

test('version 2 upgrades keep exact queued bodies, identities and next sequences', async () => {
  const disk = storage();
  const old = createOutbox({ storage: disk, locks: locks(), newId: () => 'legacy-client' });
  const first = await enqueue(old, 1); await enqueue(old, false, 1, 'read');
  const version2 = JSON.parse(disk.getItem());
  version2.version = 2; delete version2.revision; delete version2.acknowledged;
  disk.setItem(null, JSON.stringify(version2));
  const bodies = [];
  const next = createOutbox({ storage: disk, locks: locks(), request: async (_, opts) => {
    bodies.push(opts.body); return ok(1);
  } });
  const added = await enqueue(next, -1);
  assert.equal(added.sequence, 3);
  assert.equal(JSON.parse(disk.getItem()).entries[0].id, first.id);
  await next.flush();
  assert.deepEqual(bodies.slice(0, 2), version2.entries.map(entry => entry.options.body));
  assert.equal(JSON.parse(disk.getItem()).version, 3); assert.equal(next.revision, 3);
});
