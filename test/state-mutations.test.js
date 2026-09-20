import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, testConfig } from './helpers.js';
import { syncEmbeddingSpace, reembedMissing, enrichPending, requestReclassification } from '../src/enrich.js';
import { applyTopicMerge } from '../src/topicMerge.js';
import { recomputeScores, recomputeIfDue } from '../src/scoring.js';
import { startScheduler } from '../src/scheduler.js';
import { compressText } from '../src/compress.js';

const buffer = (v = [1, 0]) => Buffer.from(Float16Array.from(v).buffer);
const marker = (db) => db.prepare("SELECT value FROM meta WHERE key = 'score_recompute_due_at'").get()?.value;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function setup(t) {
  const db = tempDb(); t.after(() => db.close());
  db.prepare("INSERT INTO feeds (id,url,active) VALUES (1,'https://example.invalid',0)").run();
  return { db, config: testConfig() };
}
function article(db, id, { vote = 0, text = buffer(), dedup = buffer(), status = 'enriched', topic = null } = {}) {
  db.prepare(`INSERT INTO articles (id,feed_id,guid,title,content,summary,status,vote,embedding,text_embedding)
    VALUES (?,1,?,'Article',?,'Summary',?,?,?,?)`)
    .run(id, String(id), compressText('Article body'), status, vote, dedup, text);
  if (topic) {
    const row = db.prepare('INSERT INTO topics (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name=name RETURNING id').get(topic);
    db.prepare('INSERT INTO article_topics (article_id,topic_id) VALUES (?,?)').run(id, row.id);
  }
}
const fakeLlm = (overrides = {}) => ({
  available: async () => true,
  chatJSON: async () => ({ topics: ['new-topic'], summary: 'Summary', depth: 3 }),
  embed: async () => Float16Array.from([1, 0]),
  ...overrides,
});

test('a topic merge schedules its scoring ripple in the same transaction', async (t) => {
  const { db, config } = setup(t);
  article(db, 1, { vote: 1, topic: 'old-topic' }); article(db, 2, { topic: 'new-topic' });
  await recomputeScores(db, config);
  assert.equal(db.prepare('SELECT score FROM articles WHERE id=2').get().score, 0);
  applyTopicMerge(db, 'old-topic', 'new-topic');
  assert.ok(marker(db));
  assert.ok(await recomputeIfDue(db, config));
  assert.ok(db.prepare('SELECT score FROM articles WHERE id=2').get().score > .3);
});

test('a failure recording merge work rolls back the taxonomy change too', (t) => {
  const { db } = setup(t);
  article(db, 1, { topic: 'old-topic' }); article(db, 2, { topic: 'new-topic' });
  db.exec(`CREATE TRIGGER reject_work BEFORE INSERT ON meta
    WHEN NEW.key='score_recompute_revision' BEGIN SELECT RAISE(ABORT,'reject work'); END`);
  assert.throws(() => applyTopicMerge(db, 'old-topic', 'new-topic'), /reject work/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM topics').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM topic_aliases').get().n, 0);
});

test('re-embedding an unvoted candidate immediately refreshes its score and novelty', async (t) => {
  const { db, config } = setup(t);
  config.scoring.weights = { topics: 0, embedding: 1, depth: 0, feed: 0 };
  article(db, 1, { vote: 1 }); article(db, 2, { text: null });
  const result = await reembedMissing(db, config, fakeLlm());
  assert.equal(result.reembedded, 1);
  const row = db.prepare('SELECT score_embedding,score_novelty FROM articles WHERE id=2').get();
  assert.equal(row.score_embedding, .5); assert.equal(row.score_novelty, 0);
  assert.equal(marker(db), undefined, 'unvoted replacement needs no global ripple');
});

test('re-embedding a voted example refreshes other candidates through durable work', async (t) => {
  const { db, config } = setup(t);
  config.scoring.weights = { topics: 0, embedding: 1, depth: 0, feed: 0 };
  article(db, 1, { vote: 1, text: null }); article(db, 2);
  await recomputeScores(db, config);
  await reembedMissing(db, config, fakeLlm());
  assert.ok(marker(db));
  await recomputeIfDue(db, config);
  assert.equal(db.prepare('SELECT score_embedding FROM articles WHERE id=2').get().score_embedding, .5);
});

test('a dedup-only replacement leaves taste scores and pending work unchanged', async (t) => {
  const { db, config } = setup(t);
  article(db, 1, { vote: 1, dedup: null });
  db.prepare('UPDATE articles SET score=123 WHERE id=1').run();
  const result = await reembedMissing(db, config, fakeLlm());
  assert.equal(result.reembedded, 1);
  assert.equal(db.prepare('SELECT score FROM articles WHERE id=1').get().score, 123);
  assert.equal(marker(db), undefined);
});

test('a failed ripple write rolls back a voted text-vector replacement', async (t) => {
  const { db, config } = setup(t);
  article(db, 1, { vote: 1, text: null });
  db.exec(`CREATE TRIGGER reject_work BEFORE INSERT ON meta
    WHEN NEW.key='score_recompute_revision' BEGIN SELECT RAISE(ABORT,'reject work'); END`);
  const result = await reembedMissing(db, config, fakeLlm());
  assert.equal(result.failed, 1);
  assert.equal(db.prepare('SELECT text_embedding FROM articles WHERE id=1').get().text_embedding, null);
});

test('document prefix changes invalidate both spaces, query prefix changes invalidate neither', (t) => {
  const { db, config } = setup(t);
  syncEmbeddingSpace(db, config);
  article(db, 1);
  config.ollama.embedPrefixes = { document: '', query: 'search query: ' };
  assert.deepEqual(syncEmbeddingSpace(db, config), { changed: false });
  config.ollama.embedPrefixes.document = 'search document: ';
  assert.deepEqual(syncEmbeddingSpace(db, config), { changed: true, cleared: 2, dedupChanged: true, textChanged: true });
  const row = db.prepare('SELECT embedding,text_embedding FROM articles').get();
  assert.equal(row.embedding, null); assert.equal(row.text_embedding, null);
  assert.ok(marker(db), 'invalidating the taste space also invalidates its scores');
  const identity = JSON.parse(db.prepare("SELECT value FROM meta WHERE key='embed_model_text'").get().value);
  assert.equal(identity.documentPrefix, 'search document: ');
  assert.equal(identity.input, 'title-text-4000-v1');
});

test('an in-flight embedding from an obsolete space cannot refill a newly invalidated column', async (t) => {
  const { db, config } = setup(t);
  syncEmbeddingSpace(db, config);
  article(db, 1, { text: null });
  const result = await reembedMissing(db, config, fakeLlm({ embed: async () => {
    const newer = structuredClone(config);
    newer.ollama.embedPrefixes = { document: 'new space: ', query: '' };
    syncEmbeddingSpace(db, newer);
    return Float16Array.from([1, 0]);
  } }));
  assert.equal(result.failed, 1);
  assert.match(result.errors[0].error, /embedding space changed/);
  assert.equal(db.prepare('SELECT text_embedding FROM articles').get().text_embedding, null);
});

test('reclassification schedules a ripple when a vote arrives during the LLM call', async (t) => {
  const { db, config } = setup(t);
  article(db, 1, { status: 'pending', topic: 'old-topic' }); article(db, 2, { topic: 'new-topic' });
  const llm = fakeLlm({ chatJSON: async () => {
    db.prepare('UPDATE articles SET vote=1 WHERE id=1').run();
    return { topics: ['new-topic'], summary: 'New summary', depth: 4 };
  } });
  const result = await enrichPending(db, config, llm);
  assert.equal(result.enriched, 1); assert.ok(marker(db));
  await recomputeIfDue(db, config);
  assert.ok(db.prepare('SELECT score FROM articles WHERE id=2').get().score > .3);
});

test('a newer reclassification supersedes an in-flight reply without consuming attempts', async (t) => {
  const { db, config } = setup(t);
  article(db, 1, { topic: 'old-topic' });
  requestReclassification(db, 1, 'first');
  const result = await enrichPending(db, config, fakeLlm({ chatJSON: async () => {
    requestReclassification(db, 1, 'newest');
    return { topics: ['stale-topic'], summary: 'Stale summary', depth: 5 };
  } }));
  assert.equal(result.superseded, 1); assert.equal(result.enriched, 0); assert.equal(result.failed, 0);
  const row = db.prepare('SELECT status,enrich_attempts,enrich_note,summary FROM articles').get();
  assert.deepEqual(row, { status: 'pending', enrich_attempts: 0, enrich_note: 'newest', summary: 'Summary' });
  assert.equal(db.prepare('SELECT name FROM topics').get().name, 'old-topic');
  assert.equal((await enrichPending(db, config, fakeLlm())).enriched, 1);
});

test('a stale LLM failure cannot increment attempts for the newer request', async (t) => {
  const { db, config } = setup(t);
  article(db, 1, { status: 'pending' });
  const result = await enrichPending(db, config, fakeLlm({ chatJSON: async () => {
    requestReclassification(db, 1, 'newest');
    throw new Error('older request failed');
  } }));
  assert.equal(result.superseded, 1); assert.equal(result.failed, 0);
  assert.equal(db.prepare('SELECT enrich_attempts FROM articles').get().enrich_attempts, 0);
});

test('an idle scheduler ignores intentional old dedup NULLs and wakes on reclassification', async (t) => {
  const { db, config } = setup(t);
  article(db, 1, { dedup: null });
  db.prepare("UPDATE articles SET created_at='2000-01-01T00:00:00Z' WHERE id=1").run();
  let calls = 0, chats = 0;
  t.mock.method(globalThis, 'fetch', async (target) => {
    calls++;
    if (String(target).endsWith('/api/tags')) return Response.json({ models: [] });
    if (String(target).endsWith('/api/chat')) {
      chats++;
      return Response.json({ message: { content: JSON.stringify({ topics: ['new-topic'], summary: 'Done', depth: 3 }) } });
    }
    if (String(target).endsWith('/api/embed')) return Response.json({ embeddings: [[1, 0]] });
    throw new Error(`unexpected fetch ${target}`);
  });
  const stop = startScheduler(db, config, { fetchEveryMs: 60000, enrichEveryMs: 5, scoreEveryMs: 60000 });
  try {
    await sleep(25);
    assert.equal(calls, 0, 'out-of-window dedup NULL is not pending work');
    requestReclassification(db, 1, 'classify again');
    for (let i = 0; i < 100 && db.prepare('SELECT status FROM articles').get().status !== 'enriched'; i++) await sleep(5);
    assert.equal(chats, 1);
    assert.equal(db.prepare('SELECT status FROM articles').get().status, 'enriched');
  } finally { stop(); }
});
