import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app, deferred, page } from './frontendHelpers.js';

test('C25: old success cannot replace a newer filter or cursor', async () => {
  const { ctx } = app(); const a = deferred(), b = deferred(); const calls = [];
  ctx.api = (_, options) => { calls.push(options); return calls.length === 1 ? a.promise : b.promise; };
  const first = ctx.reload(); ctx.topic = 'new'; const second = ctx.reload();
  assert.equal(calls[0].signal.aborted, true);
  b.resolve(page(2)); await second; a.resolve(page(1)); await first;
  assert.equal(ctx.articles[0].id, 2); assert.equal(ctx.cursor, 'cursor-2'); assert.equal(ctx.loading, false);
});

test('old error/finally cannot clear loading or set an error for a newer request', async () => {
  const { ctx } = app(); const a = deferred(), b = deferred(); let calls = 0;
  ctx.api = () => ++calls === 1 ? a.promise : b.promise;
  const first = ctx.reload(); ctx.q = 'new'; const second = ctx.reload();
  a.reject(new Error('old failure')); await first;
  assert.equal(ctx.error, null); assert.equal(ctx.loading, true);
  b.resolve(page(2)); await second; assert.equal(ctx.loading, false);
});

test('typing invalidates results during the debounce interval', async () => {
  const { ctx, definition, timers } = app(); const pending = deferred(); ctx.api = () => pending.promise;
  const first = ctx.reload(); ctx.q = 'new text'; definition.watch.q.call(ctx);
  assert.equal(timers.length, 1);
  pending.resolve(page(1)); await first; assert.equal(ctx.articles.length, 0);
});

test('loadMore from an old query cannot append after a reload', async () => {
  const { ctx } = app(); ctx.api = async () => page(1); await ctx.reload();
  const more = deferred(), newer = deferred(); let calls = 0;
  ctx.api = () => ++calls === 1 ? more.promise : newer.promise;
  const oldMore = ctx.loadMore(); ctx.feedId = 'new-feed'; const newPage = ctx.reload();
  newer.resolve(page(2)); await newPage; more.resolve(page(3)); await oldMore;
  assert.equal(ctx.articles.length, 1); assert.equal(ctx.articles[0].id, 2); assert.equal(ctx.cursor, 'cursor-2');
});

test('overlapping loadMore calls cannot append the same page twice', async () => {
  const { ctx } = app(); ctx.api = async () => page(1); await ctx.reload();
  const pending = deferred(); let calls = 0; ctx.api = () => { calls++; return pending.promise; };
  const first = ctx.loadMore(); await ctx.loadMore();
  pending.resolve(page(2)); await first; assert.equal(calls, 1); assert.equal(ctx.articles.length, 2);
});

test('switching to another panel invalidates pending list errors and results', async () => {
  const { ctx } = app(); const pending = deferred(); ctx.api = () => pending.promise;
  const first = ctx.reload(); ctx.openPanel('feeds'); pending.reject(new Error('stale search')); await first;
  assert.equal(ctx.error, null); assert.equal(ctx.articles.length, 0); assert.equal(ctx.loading, false);
});

test('new triage scope owns queue, loading and errors when old responses arrive late', async () => {
  const { ctx } = app(); const a = deferred(), b = deferred(); let calls = 0;
  ctx.api = () => ++calls === 1 ? a.promise : b.promise;
  const first = ctx.loadTriageBatch(); ctx.triageScope = 'filtered'; ctx.topic = 'new';
  const second = ctx.loadTriageBatch(); b.resolve(page(2)); await second;
  a.reject(new Error('old queue failed')); await first;
  assert.equal(ctx.triageQueue[0].id, 2); assert.equal(ctx.error, null); assert.equal(ctx.triageLoading, false);
});

test('leaving triage directly also rejects a late batch error', async () => {
  const { ctx } = app(); const pending = deferred(); ctx.panel = 'triage'; ctx.api = () => pending.promise;
  const loading = ctx.loadTriageBatch(); ctx.panel = null;
  pending.reject(new Error('old triage failed')); await loading;
  assert.equal(ctx.error, null); assert.equal(ctx.triageQueue.length, 0);
});
