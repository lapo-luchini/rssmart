import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app, deferred } from './frontendHelpers.js';
import { createOutbox } from '../public/outbox.js';
import { memoryStorage } from './feedbackStorage.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { testConfig } from './helpers.js';

function storage() {
  return memoryStorage();
}
function locks() {
  const tails = new Map();
  return { request(name, fn) {
    const next = (tails.get(name) ?? Promise.resolve()).then(fn);
    tails.set(name, next.catch(() => {}));
    return next;
  } };
}
const options = (field, value) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [field]: value }) });
const put = (box, field, value) => box.enqueue('/api/articles/1/' + field, options(field, value));
const article = id => ({ id, vote: 1, read_at: 'saved' });
const html = text => ({ html: `<p>${text}</p>`, source: 'cached' });
function fixture(t) {
  const db = openDb(':memory:'); t.after(() => db.close());
  db.exec("INSERT INTO feeds(id,url) VALUES(1,'https://example.invalid/feed'); INSERT INTO articles(id,feed_id,guid,title) VALUES(1,1,'one','Article'),(2,1,'two','Other');");
  const server = createApp(db, testConfig());
  const request = (path, opts) => server.request(path, opts);
  const state = () => db.prepare('SELECT vote,read_at,voted_at FROM articles WHERE id=1').get();
  return { db, request, state };
}

test('B01: a delayed list GET in another tab preserves feedback acknowledged after it began', async t => {
  const { request, state } = fixture(t);
  const old = await (await request('/api/articles/1')).json();
  const disk = storage(), sharedLocks = locks();
  const a = createOutbox({ storage: disk, locks: sharedLocks, request });
  const b = createOutbox({ storage: disk, locks: sharedLocks, request });
  const { ctx } = app(b); const pending = deferred(); ctx.api = () => pending.promise;
  const loading = ctx.reload();
  await put(a, 'vote', 1); await a.flush();
  assert.equal(state().vote, 1); assert.equal(b.count, 0);
  assert.equal(a.revision, b.revision); assert.equal(b.revision, 1);
  pending.resolve({ articles: [old], total: 1 }); await loading;
  assert.equal(ctx.articles[0].vote, 1); assert.equal(ctx.articles[0].read_at, state().read_at);
});

test('B02/B09: delayed permalink feedback is projected before opening and causes no redundant read mutation', async t => {
  const { request, state, db } = fixture(t);
  const old = await (await request('/api/articles/1')).json();
  const box = createOutbox({ storage: storage(), request });
  const { ctx } = app(box); const pending = deferred();
  ctx.api = path => path.endsWith('/reader') ? Promise.resolve(html('content')) : pending.promise;
  const opening = ctx.openReaderById(1);
  await put(box, 'vote', -1); await box.flush();
  const acknowledged = state();
  pending.resolve(old); await opening; await ctx.flushOutbox();
  assert.equal(ctx.readerArticle.vote, -1);
  assert.equal(ctx.readerArticle.read_at, acknowledged.read_at);
  assert.equal(ctx.readerHtml, '<p>content</p>');
  assert.equal(box.count, 0); assert.deepEqual(state(), acknowledged);
  assert.equal(db.prepare('SELECT count(*) AS n FROM feedback_receipts').get().n, 1);
});

test('permalink detail also projects a still-queued vote before deciding whether to mark read', async t => {
  const { request, db } = fixture(t);
  const old = await (await request('/api/articles/1')).json();
  const box = createOutbox({ storage: storage(), request });
  const { ctx } = app(box); const pending = deferred();
  ctx.api = path => path.endsWith('/reader') ? Promise.resolve(html('content')) : pending.promise;
  const opening = ctx.openReaderById(1);
  await put(box, 'vote', 2);
  pending.resolve(old); await opening;
  assert.equal(ctx.readerArticle.vote, 2); assert.ok(ctx.readerArticle.read_at);
  assert.equal(box.count, 1); assert.equal(db.prepare('SELECT count(*) AS n FROM feedback_receipts').get().n, 0);
});

test('B03: only the latest permalink can open, even when an aborted GET still resolves', async () => {
  const { ctx } = app(); const first = deferred(), second = deferred(); const signals = [];
  ctx.api = (path, options) => {
    if (path.endsWith('/reader')) return Promise.resolve(html('content'));
    signals.push(options.signal); return path.endsWith('/1') ? first.promise : second.promise;
  };
  const older = ctx.openReaderById(1); const newer = ctx.openReaderById(2);
  assert.equal(signals[0].aborted, true);
  second.resolve(article(2)); await newer;
  first.resolve(article(1)); await older;
  assert.equal(ctx.readerArticle.id, 2); assert.equal(ctx.readerTargetId, 2);
});

test('B04: failed acknowledgement persistence retains replay identity, shared revision and FIFO', async t => {
  const { request: baseRequest, state, db } = fixture(t);
  const disk = storage(), originalSave = disk.setItem.bind(disk), sharedLocks = locks();
  let failSave = false, responses = 0;
  disk.setItem = (key, value) => { if (failSave) throw new Error('quota after server commit'); originalSave(key, value); };
  const a = createOutbox({ storage: disk, locks: sharedLocks, request: async (path, opts) => {
    const response = await baseRequest(path, opts);
    if (++responses === 1) failSave = true;
    return response;
  } });
  const first = await put(a, 'vote', 1); await a.flush();
  const committed = state();
  assert.equal(committed.vote, 1); assert.ok(committed.read_at); assert.equal(a.count, 1);
  assert.equal(a.revision, 0); assert.match(a.issue.message, /quota/);
  assert.equal(JSON.parse(disk.getItem('rssmart_outbox_v3')).entries[0].id, first.id);
  failSave = false;
  const b = createOutbox({ storage: disk, locks: sharedLocks, request: baseRequest });
  await b.flush();
  assert.deepEqual(state(), committed); assert.equal(a.revision, 1);
  await put(b, 'vote', 0); await put(b, 'read', false); await put(b, 'vote', -2);
  await Promise.all([a.flush(), b.flush()]);
  assert.equal(state().vote, -2); assert.ok(state().read_at); assert.equal(a.count, 0);
  assert.equal(a.revision, 4); assert.equal(b.revision, 4);
  const rows = db.prepare('SELECT sequence,operation,value FROM feedback_receipts ORDER BY sequence').all();
  assert.deepEqual(rows.map(x => [x.sequence, x.operation, x.value]), [[1, 'vote', 1], [2, 'vote', 0], [3, 'read', 0], [4, 'vote', -2]]);
});

test('B06: closing cancels a pending permalink without reopening it on a late response', async () => {
  const { ctx } = app(); const pending = deferred(); let contentRequests = 0;
  ctx.api = path => { if (path.endsWith('/reader')) { contentRequests++; return Promise.resolve(html('late')); } return pending.promise; };
  const work = ctx.openReaderById(1); ctx.closeReader();
  pending.resolve(article(1)); await work;
  assert.equal(ctx.readerArticle, null); assert.equal(ctx.readerTargetId, null); assert.equal(contentRequests, 0);
});

test('B07: a local article selection supersedes a pending permalink', async () => {
  const { ctx } = app(); const pending = deferred();
  ctx.api = path => path.endsWith('/reader') ? Promise.resolve(html('selected')) : pending.promise;
  const work = ctx.openReaderById(1); await ctx.openReader(article(2));
  pending.resolve(article(1)); await work;
  assert.equal(ctx.readerArticle.id, 2); assert.equal(ctx.readerHtml, '<p>selected</p>');
});

test('B08: close and reopen of the same id gives its new HTML request exclusive ownership', async () => {
  const { ctx } = app(); const first = deferred(), second = deferred(); let calls = 0;
  ctx.api = () => ++calls === 1 ? first.promise : second.promise;
  const older = ctx.openReader(article(1)); ctx.closeReader(); const newer = ctx.openReader(article(1));
  second.resolve(html('new')); await newer; first.resolve(html('old')); await older;
  assert.equal(ctx.readerHtml, '<p>new</p>'); assert.equal(ctx.readerLoading, false);
});

test('old reader errors/finally cannot close the replacement or clear its loading state', async () => {
  const { ctx } = app(); const first = deferred(), second = deferred(); let calls = 0;
  ctx.api = () => ++calls === 1 ? first.promise : second.promise;
  const older = ctx.openReader(article(1)); const newer = ctx.openReader(article(1));
  first.reject(new Error('obsolete failure')); await older;
  assert.equal(ctx.readerArticle.id, 1); assert.equal(ctx.readerLoading, true); assert.equal(ctx.error, null);
  second.resolve(html('new')); await newer; assert.equal(ctx.readerLoading, false);
});

test('a late detail error cannot replace an error from the latest permalink', async () => {
  const { ctx } = app(); const first = deferred(), second = deferred();
  ctx.api = path => path.endsWith('/1') ? first.promise : second.promise;
  const older = ctx.openReaderById(1); const newer = ctx.openReaderById(2);
  second.reject(new Error('current failure')); await newer;
  first.reject(new Error('obsolete failure')); await older;
  assert.equal(ctx.error, 'Cannot load article: current failure');
});

test('returning to the already visible reader cancels a different pending permalink', async () => {
  const { ctx } = app(); const pending = deferred();
  ctx.api = path => path.endsWith('/reader') ? Promise.resolve(html('current')) : pending.promise;
  await ctx.openReader(article(1));
  const older = ctx.openReaderById(2); await ctx.openReaderById(1);
  pending.resolve(article(2)); await older;
  assert.equal(ctx.readerArticle.id, 1);
});

test('navigation back to the current list cancels a pending permalink too', async () => {
  const { ctx } = app(); const pending = deferred(); ctx.api = () => pending.promise;
  const work = ctx.openReaderById(1); ctx.applyRoute('#/' + ctx.currentRoute());
  pending.resolve(article(1)); await work;
  assert.equal(ctx.readerArticle, null); assert.equal(ctx.readerTargetId, null);
});
