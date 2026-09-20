import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app, deferred, page } from './frontendHelpers.js';
import { createOutbox } from '../public/outbox.js';

test('all four feedback surfaces share the ordered queue', async () => {
  let disk = null; const calls = []; const state = { id: 1, vote: 0, read_at: null };
  const box = createOutbox({ storage: { getItem: () => disk, setItem: (_, value) => { disk = value; } }, request: async (path, opts) => {
    const body = JSON.parse(opts.body); calls.push({ path, body });
    if ('vote' in body) { state.vote = body.vote; if (body.vote) state.read_at ??= 'saved'; }
    else state.read_at = body.read ? 'saved' : null;
    return new Response(JSON.stringify(state));
  } });
  const { ctx } = app(box); const article = { ...state }; ctx.articles = [article]; ctx.triageQueue = [article]; ctx.triageAdvance = async () => {};
  await ctx.vote(article, 1); await ctx.toggleRead(article); await ctx.triageVote(-1); await ctx.triageSkip();
  await ctx.flushOutbox();
  assert.deepEqual(calls.map(item => item.path.split('/').at(-1)), ['vote', 'read', 'vote', 'read']);
  assert.deepEqual(calls.map(item => item.body.mutation.sequence), [1, 2, 3, 4]);
  assert.equal(state.vote, -1); assert.equal(state.read_at, 'saved'); assert.equal(box.count, 0);
});

test('old feedback acknowledgement cannot replace a newer optimistic vote', async () => {
  let disk = null; const first = deferred(), second = deferred(), started = deferred(), nextStarted = deferred(); let calls = 0;
  const box = createOutbox({ storage: { getItem: () => disk, setItem: (_, value) => { disk = value; } }, request: () => {
    if (++calls === 1) { started.resolve(); return first.promise; }
    nextStarted.resolve(); return second.promise;
  } });
  const { ctx } = app(box); const article = { id: 1, vote: 0, read_at: null }; ctx.articles = [article];
  await ctx.vote(article, 1); await started.promise; await ctx.vote(article, -1);
  first.resolve(new Response('{"id":1,"vote":1,"read_at":"first"}')); await nextStarted.promise;
  assert.equal(article.vote, -1);
  second.resolve(new Response('{"id":1,"vote":-1,"read_at":"first"}')); await ctx.flushOutbox();
  assert.equal(article.vote, -1); assert.equal(box.count, 0);
});

test('failed local persistence leaves the article unchanged and reports an error', async () => {
  const box = createOutbox({ storage: { getItem: () => null, setItem: () => { throw new Error('quota'); } } });
  const { ctx } = app(box); const article = { id: 1, vote: 0, read_at: null };
  await ctx.vote(article, 1); assert.equal(article.vote, 0); assert.equal(article.read_at, null); assert.match(ctx.error, /quota/);
});

test('a list response projects queued vote/read intentions over stale server state', async () => {
  let disk = null;
  const box = createOutbox({ storage: { getItem: () => disk, setItem: (_, value) => { disk = value; } } });
  await box.enqueue('/api/articles/1/vote', { method: 'POST', body: '{"vote":-1}' });
  const { ctx } = app(box); ctx.api = async () => ({ articles: [{ id: 1, vote: 0, read_at: null }], total: 1 });
  await ctx.reload(); assert.equal(ctx.articles[0].vote, -1); assert.ok(ctx.articles[0].read_at);
});

test('a GET begun before an acknowledgement cannot restore the old vote after the queue drains', async () => {
  let disk = null;
  const box = createOutbox({ storage: { getItem: () => disk, setItem: (_, value) => { disk = value; } },
    request: async () => new Response('{"id":1,"vote":-1,"read_at":"saved"}') });
  const { ctx } = app(box); const pending = deferred(); ctx.api = () => pending.promise;
  const loading = ctx.reload();
  await box.enqueue('/api/articles/1/vote', { method: 'POST', body: '{"vote":-1}' });
  await box.flush(); assert.equal(box.count, 0);
  pending.resolve({ articles: [{ id: 1, vote: 0, read_at: null }], total: 1 }); await loading;
  assert.equal(ctx.articles[0].vote, -1); assert.equal(ctx.articles[0].read_at, 'saved');
});
