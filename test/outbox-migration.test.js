import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutbox } from '../public/outbox.js';
import { memoryStorage } from './feedbackStorage.js';

const LEGACY = 'rssmart_outbox', CURRENT = 'rssmart_outbox_v3';
const options = vote => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vote }) });
const entry = (id = 1, vote = 1) => ({ path: `/api/articles/${id}/vote`, options: options(vote) });
const put = (box, vote = 1) => box.enqueue('/api/articles/1/vote', options(vote));
const ok = () => Response.json({ id: 1, vote: 1, read_at: 'saved' });
const saved = disk => JSON.parse(disk.getItem(CURRENT));
function locks() {
  const tails = new Map();
  return { request(name, fn) {
    const next = (tails.get(name) ?? Promise.resolve()).then(fn);
    tails.set(name, next.catch(() => {}));
    return next;
  } };
}
// The load/enqueue behavior of upstream edb935a: unknown objects are read
// as an empty array and the next local write replaces the entire old key.
function upstreamTab(disk) {
  const parsed = JSON.parse(disk.getItem(LEGACY));
  const entries = Array.isArray(parsed) ? parsed : [];
  return { enqueue(item) { entries.push(item); disk.setItem(LEGACY, JSON.stringify(entries)); } };
}

test('an upstream tab cannot overwrite the new queue; its later changes pause sync and remain preserved', async () => {
  const baseline = JSON.stringify([entry()]);
  const disk = memoryStorage({ [LEGACY]: baseline }), old = upstreamTab(disk);
  let calls = 0;
  const box = createOutbox({ storage: disk, request: async () => { calls++; return ok(); } });
  const newer = await put(box, -1), isolated = disk.getItem(CURRENT);
  old.enqueue(entry(2, -2));
  const conflicting = disk.getItem(LEGACY);
  assert.equal(disk.getItem(CURRENT), isolated);
  assert.equal(box.count, 2); assert.equal(box.issue.legacyConflict, true);
  await box.flush({ retryErrors: true });
  assert.equal(calls, 0); assert.equal(disk.getItem(LEGACY), conflicting);
  assert.equal(saved(disk).entries[1].id, newer.id);
  assert.equal(saved(disk).legacySnapshot, baseline);
  assert.equal(saved(disk).legacyConflict.snapshot, conflicting);
  // Once recorded, returning to the old baseline is not reconciliation.
  disk.setItem(LEGACY, baseline);
  const restarted = createOutbox({ storage: disk, request: async () => { calls++; return ok(); } });
  await restarted.flush({ retryErrors: true });
  assert.equal(calls, 0); assert.equal(restarted.issue.legacyConflict, true);
});

test('legacy arrays migrate durably before sending and are not reimported after restart', async () => {
  const baseline = JSON.stringify([entry()]);
  const disk = memoryStorage({ [LEGACY]: baseline }); let calls = 0, firstId;
  const box = createOutbox({ storage: disk, request: async (_, opts) => {
    calls++; const current = saved(disk); firstId = current.entries[0].id;
    assert.equal(current.legacySnapshot, baseline);
    assert.equal(JSON.parse(opts.body).mutation.sequence, 1);
    return ok();
  } });
  await box.flush(); assert.equal(calls, 1); assert.equal(box.count, 0); assert.ok(firstId);
  assert.equal(disk.getItem(LEGACY), baseline);
  const restarted = createOutbox({ storage: disk, newId: () => { throw new Error('must not reimport'); }, request: async () => { calls++; return ok(); } });
  await restarted.flush(); assert.equal(calls, 1); assert.equal(restarted.count, 0);
  assert.equal((await put(restarted, -1)).sequence, 2);
});

for (const version of [2, 3]) test(`legacy v${version} migration preserves exact identities, sequences, bodies and available acknowledgements`, async () => {
  const body = JSON.stringify({ vote: -2, mutation: { clientId: 'legacy-client', sequence: 7 } });
  const legacy = {
    version, clientId: 'legacy-client', sequences: { 1: 7 },
    entries: [{ id: 'legacy-client:1:7', articleId: '1', field: 'vote', sequence: 7,
      createdAt: '2026-09-20T00:00:00Z', path: '/api/articles/1/vote', options: { ...options(-2), body } }],
    ...(version === 3 ? { revision: 5, acknowledged: { 1: { read_at: { revision: 5, value: 'saved' } } } } : {}),
  };
  const baseline = JSON.stringify(legacy), disk = memoryStorage({ [LEGACY]: baseline });
  const box = createOutbox({ storage: disk, newId: () => { throw new Error('identity must survive'); } });
  const added = await put(box, 1), current = saved(disk);
  assert.equal(added.sequence, 8); assert.equal(current.clientId, legacy.clientId);
  assert.deepEqual(current.entries[0], legacy.entries[0]);
  assert.equal(current.entries[0].options.body, body);
  assert.equal(current.revision, legacy.revision ?? 0);
  assert.deepEqual(current.acknowledged, legacy.acknowledged ?? {});
  assert.equal(disk.getItem(LEGACY), baseline);
});

test('quota before migration commit preserves the legacy record and sends nothing', async () => {
  const baseline = JSON.stringify([entry()]), disk = memoryStorage({ [LEGACY]: baseline });
  const store = disk.setItem.bind(disk); let calls = 0;
  disk.setItem = () => { throw new Error('quota'); };
  const box = createOutbox({ storage: disk, request: async () => { calls++; return ok(); } });
  await box.flush(); await assert.rejects(put(box), /quota/);
  assert.equal(calls, 0); assert.equal(disk.getItem(CURRENT), null); assert.equal(disk.getItem(LEGACY), baseline);
  disk.setItem = store;
  const restarted = createOutbox({ storage: disk, request: async () => { calls++; return ok(); } });
  await restarted.flush(); assert.equal(calls, 1); assert.equal(restarted.count, 0);
});

test('a crash cut after migration commit resumes the same identity instead of reimporting legacy', async () => {
  const baseline = JSON.stringify([entry()]), disk = memoryStorage({ [LEGACY]: baseline });
  const store = disk.setItem.bind(disk); let calls = 0;
  disk.setItem = (key, value) => { store(key, value); throw new Error('crash cut after atomic store'); };
  const box = createOutbox({ storage: disk, request: async () => { calls++; return ok(); } });
  await box.flush(); const id = saved(disk).entries[0].id;
  assert.equal(calls, 0); assert.equal(disk.getItem(LEGACY), baseline);
  disk.setItem = store;
  const restarted = createOutbox({ storage: disk, newId: () => { throw new Error('must not reimport'); }, request: async (_, opts) => {
    calls++; assert.equal(saved(disk).entries[0].id, id); assert.equal(JSON.parse(opts.body).mutation.sequence, 1); return ok();
  } });
  await restarted.flush(); assert.equal(calls, 1); assert.equal(restarted.count, 0);
});

test('a legacy write during the first isolated save is retained and prevents network replay', async () => {
  const baseline = JSON.stringify([entry()]), conflict = JSON.stringify([entry(2, -1)]);
  const disk = memoryStorage({ [LEGACY]: baseline }), store = disk.setItem.bind(disk);
  let raced = false, calls = 0;
  disk.setItem = (key, value) => {
    store(key, value);
    if (key === CURRENT && !raced) { raced = true; store(LEGACY, conflict); }
  };
  const box = createOutbox({ storage: disk, request: async () => { calls++; return ok(); } });
  await box.flush();
  assert.equal(calls, 0); assert.equal(box.issue.legacyConflict, true);
  assert.equal(saved(disk).legacySnapshot, baseline);
  assert.equal(saved(disk).legacyConflict.snapshot, conflict);
  assert.equal(disk.getItem(LEGACY), conflict); assert.equal(box.count, 1);
});

test('two new tabs migrate once under shared locks and append distinct contiguous sequences', async () => {
  const baseline = JSON.stringify([entry()]), disk = memoryStorage({ [LEGACY]: baseline }), sharedLocks = locks();
  const a = createOutbox({ storage: disk, locks: sharedLocks }), b = createOutbox({ storage: disk, locks: sharedLocks });
  await Promise.all([put(a, 2), put(b, -1)]);
  assert.deepEqual(saved(disk).entries.map(row => row.sequence), [1,2,3]);
  assert.equal(new Set(saved(disk).entries.map(row => row.id)).size, 3);
  assert.equal(disk.getItem(LEGACY), baseline);
});

test('legacy feedback appearing during a request is not absorbed; only the acknowledged new entry is removed', async () => {
  const disk = memoryStorage(); let release, started, calls = 0;
  const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
  const box = createOutbox({ storage: disk, request: async () => { calls++; started(); await gate; return ok(); } });
  await put(box, 1); const second = await put(box, -1);
  const flushing = box.flush(); await entered;
  const conflict = JSON.stringify([entry(2, -2)]); disk.setItem(LEGACY, conflict); release(); await flushing;
  assert.equal(calls, 1); assert.equal(box.count, 1); assert.equal(box.issue.legacyConflict, true);
  assert.equal(saved(disk).entries[0].id, second.id);
  assert.equal(saved(disk).legacyConflict.snapshot, conflict); assert.equal(disk.getItem(LEGACY), conflict);
});

test('a corrupt isolated record is never replaced by reimporting the old queue', async () => {
  const baseline = JSON.stringify([entry()]);
  const disk = memoryStorage({ [LEGACY]: baseline, [CURRENT]: 'corrupt' });
  let calls = 0; const box = createOutbox({ storage: disk, request: async () => { calls++; return ok(); } });
  await box.flush(); await assert.rejects(put(box));
  assert.equal(calls, 0); assert.equal(disk.getItem(CURRENT), 'corrupt'); assert.equal(disk.getItem(LEGACY), baseline);
  assert.match(box.issue.message, /Cannot access/);
});
