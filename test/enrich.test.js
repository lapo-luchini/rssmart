import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, startOllamaStub, testConfig } from './helpers.js';
import { enrichPending, cosine, bufToVec, sampleText } from '../src/enrich.js';
import { Ollama } from '../src/llm.js';

function seedArticle(db, { title, content = 'body' }) {
  db.prepare("INSERT OR IGNORE INTO feeds (id, url) VALUES (1, 'http://f')").run();
  const { lastInsertRowid } = db
    .prepare("INSERT INTO articles (feed_id, guid, title, content) VALUES (1, ?, ?, ?)")
    .run(`g-${title}`, title, content);
  return Number(lastInsertRowid);
}

test('sampleText keeps short text whole, long text keeps head and tail', () => {
  assert.equal(sampleText('short', 100), 'short');
  const long = 'A'.repeat(900) + 'B'.repeat(900) + 'C'.repeat(900);
  const sampled = sampleText(long, 1000);
  assert.ok(sampled.startsWith('AAA'), 'head kept');
  assert.ok(sampled.endsWith('CCC'), 'tail kept');
  assert.ok(sampled.includes('omitted'), 'gap marked');
  assert.ok(sampled.length < 1100, 'stays near budget');
});

test('cosine similarity basics', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(cosine([1, 1], [1, 0]) - Math.SQRT1_2) < 1e-9);
});

test('enrichPending classifies, summarizes and embeds pending articles', async () => {
  const db = tempDb();
  const stub = await startOllamaStub();
  stub.chat = () => ({ topics: ['Linux', 'security'], summary: 'Kernel patch released.' });

  const id = seedArticle(db, { title: 'Kernel 6.20 fixes bug' });
  try {
    const config = testConfig();
    const llm = new Ollama({ ...config.ollama, url: stub.url });
    const result = await enrichPending(db, config, llm);

    assert.deepEqual(
      { enriched: result.enriched, failed: result.failed },
      { enriched: 1, failed: 0 },
    );
    const art = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
    assert.equal(art.status, 'enriched');
    assert.equal(art.summary, 'Kernel patch released.');
    assert.ok(art.embedding instanceof Buffer && art.embedding.length > 0);
    assert.equal(bufToVec(art.embedding).length, 8);

    const topics = db.prepare(`
      SELECT t.name FROM topics t
      JOIN article_topics at ON at.topic_id = t.id
      WHERE at.article_id = ? ORDER BY t.name
    `).all(id).map((r) => r.name);
    assert.deepEqual(topics, ['linux', 'security'], 'topics normalized to lowercase');

    // The prompt advertises existing topics to later classifications, and
    // the request sizes the context window for the configured input length.
    stub.calls.chat.length = 0;
    seedArticle(db, { title: 'Another one' });
    await enrichPending(db, config, llm);
    assert.match(stub.calls.chat[0].messages[1].content, /linux, security/);
    assert.ok(stub.calls.chat[0].options.num_ctx >= 4096);
  } finally {
    await stub.close();
  }
});

test('near-identical embeddings mark the newer article as duplicate', async () => {
  const db = tempDb();
  const stub = await startOllamaStub();
  stub.chat = () => ({ topics: ['news'], summary: 'Same event.' });
  stub.embed = (input) =>
    input.includes('Alpha') || input.includes('Alpha again')
      ? [1, 0.05, 0, 0]
      : [0, 1, 0, 0];

  const a = seedArticle(db, { title: 'Alpha happens' });
  const b = seedArticle(db, { title: 'Alpha again: happens' });
  const c = seedArticle(db, { title: 'Unrelated thing' });
  try {
    const config = testConfig();
    const llm = new Ollama({ ...config.ollama, url: stub.url });
    const result = await enrichPending(db, config, llm);

    assert.equal(result.enriched, 3);
    assert.equal(result.duplicates, 1);
    const rows = db.prepare('SELECT id, duplicate_of FROM articles ORDER BY id').all();
    assert.deepEqual(rows, [
      { id: a, duplicate_of: null },
      { id: b, duplicate_of: a },
      { id: c, duplicate_of: null },
    ]);
  } finally {
    await stub.close();
  }
});

test('LLM failures retry then park the article as error', async () => {
  const db = tempDb();
  const stub = await startOllamaStub();
  stub.chat = () => ({ nonsense: true });

  const id = seedArticle(db, { title: 'Unclassifiable' });
  try {
    const config = testConfig();
    config.enrich.maxAttempts = 2;
    const llm = new Ollama({ ...config.ollama, url: stub.url });

    const first = await enrichPending(db, config, llm);
    assert.equal(first.failed, 1);
    let art = db.prepare('SELECT status, enrich_attempts FROM articles WHERE id = ?').get(id);
    assert.deepEqual(art, { status: 'pending', enrich_attempts: 1 });

    const second = await enrichPending(db, config, llm);
    assert.equal(second.failed, 1);
    art = db.prepare('SELECT status, enrich_attempts FROM articles WHERE id = ?').get(id);
    assert.deepEqual(art, { status: 'error', enrich_attempts: 2 });

    const third = await enrichPending(db, config, llm);
    assert.deepEqual(
      { enriched: third.enriched, failed: third.failed },
      { enriched: 0, failed: 0 },
      'errored articles are not retried',
    );
  } finally {
    await stub.close();
  }
});

test('an expired deadline stops before touching any article', async () => {
  const db = tempDb();
  const stub = await startOllamaStub();
  const id = seedArticle(db, { title: 'Never reached' });
  try {
    const config = testConfig();
    const llm = new Ollama({ ...config.ollama, url: stub.url });
    const result = await enrichPending(db, config, llm, { deadline: Date.now() - 1 });
    assert.equal(result.timedOut, true);
    assert.equal(result.enriched, 0);
    const art = db.prepare('SELECT status, enrich_attempts FROM articles WHERE id = ?').get(id);
    assert.deepEqual(art, { status: 'pending', enrich_attempts: 0 });
  } finally {
    await stub.close();
  }
});

test('waitForMore keeps draining articles inserted mid-run', async () => {
  const db = tempDb();
  const stub = await startOllamaStub();
  try {
    const config = testConfig();
    const llm = new Ollama({ ...config.ollama, url: stub.url });

    let ingesting = true;
    const run = enrichPending(db, config, llm, {
      waitForMore: () => ingesting,
      pollMs: 10,
    });
    // Simulate a slow feed fetch finishing after enrichment started.
    setTimeout(() => {
      seedArticle(db, { title: 'Arrived late' });
      ingesting = false;
    }, 30);

    const result = await run;
    assert.equal(result.enriched, 1);
    assert.equal(result.timedOut, false);
    assert.equal(
      db.prepare('SELECT status FROM articles').get().status,
      'enriched',
    );
  } finally {
    await stub.close();
  }
});

test('unreachable ollama skips enrichment and keeps articles pending', async () => {
  const db = tempDb();
  const id = seedArticle(db, { title: 'Waiting' });
  const config = testConfig();
  const llm = new Ollama(config.ollama); // port 1 — nothing listens
  const result = await enrichPending(db, config, llm);
  assert.equal(result.skipped, true);
  const art = db.prepare('SELECT status, enrich_attempts FROM articles WHERE id = ?').get(id);
  assert.deepEqual(art, { status: 'pending', enrich_attempts: 0 });
});
