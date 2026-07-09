import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, startOllamaStub, testConfig } from './helpers.js';
import { enrichPending, cosine, bufToVec, sampleText } from '../src/enrich.js';
import { Ollama } from '../src/llm.js';

function seedArticle(db, { title, content = 'body', published = null }) {
  db.prepare("INSERT OR IGNORE INTO feeds (id, url) VALUES (1, 'http://f')").run();
  const { lastInsertRowid } = db
    .prepare("INSERT INTO articles (feed_id, guid, title, content, published_at) VALUES (1, ?, ?, ?, ?)")
    .run(`g-${title}`, title, content, published);
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

test('num_ctx grows with a large topic vocabulary, not just article length', async () => {
  const db = tempDb();
  const stub = await startOllamaStub();
  try {
    const config = testConfig();
    const llm = new Ollama({ ...config.ollama, url: stub.url });

    seedArticle(db, { title: 'Baseline, no topics yet' });
    await enrichPending(db, config, llm);
    const baseline = stub.calls.chat[0].options.num_ctx;

    // simulate a large existing vocabulary (the real DB has 283+ and growing)
    const insertTopic = db.prepare('INSERT INTO topics (name) VALUES (?)');
    for (let i = 0; i < 800; i++) insertTopic.run(`topic number ${i} of the classification vocabulary`);

    stub.calls.chat.length = 0;
    seedArticle(db, { title: 'Second article, huge vocabulary now' });
    await enrichPending(db, config, llm);
    const withManyTopics = stub.calls.chat[0].options.num_ctx;

    assert.ok(
      withManyTopics > baseline,
      `num_ctx should grow with the topic list (${baseline} -> ${withManyTopics})`,
    );
  } finally {
    await stub.close();
  }
});

test('cosine similarity basics', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(cosine([1, 1], [1, 0]) - Math.SQRT1_2) < 1e-9);
});

test('enrichPending classifies, summarizes and embeds pending articles', async () => {
  const db = tempDb();
  const stub = await startOllamaStub();
  stub.chat = () => ({ topics: ['Linux', 'security'], summary: 'Kernel patch released.', depth: 4 });

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
    assert.equal(art.depth, 4);
    // Uint8Array, not the more specific Buffer check: bun:sqlite returns
    // BLOB columns as plain Uint8Array, and that's all bufToVec ever needs.
    assert.ok(art.embedding instanceof Uint8Array && art.embedding.length > 0);
    assert.ok(art.text_embedding instanceof Uint8Array && art.text_embedding.length > 0);
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
    assert.equal(stub.calls.chat[0].think, false, 'model thinking disabled');
  } finally {
    await stub.close();
  }
});

test('a missing summary falls back to the article opening (deterministic at temp 0)', async () => {
  const db = tempDb();
  const stub = await startOllamaStub();
  stub.chat = () => ({ topic: ['software'] }); // no summary, drifted key
  const id = seedArticle(db, { title: 'Odd reply', content: 'Words one two three.' });
  try {
    const config = testConfig();
    const llm = new Ollama({ ...config.ollama, url: stub.url });
    const result = await enrichPending(db, config, llm);
    assert.equal(result.enriched, 1);
    const art = db.prepare('SELECT summary, status FROM articles WHERE id = ?').get(id);
    assert.equal(art.status, 'enriched');
    assert.equal(art.summary, 'Words one two three.');
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

  const a = seedArticle(db, { title: 'Alpha happens', published: '2026-07-01T00:00:00Z' });
  const b = seedArticle(db, { title: 'Alpha again: happens', published: '2026-07-02T00:00:00Z' });
  const c = seedArticle(db, { title: 'Unrelated thing', published: '2026-07-03T00:00:00Z' });
  try {
    const config = testConfig();
    const llm = new Ollama({ ...config.ollama, url: stub.url });
    const progress = [];
    const order = [];
    const result = await enrichPending(db, config, llm, {
      onItem: (i) => {
        progress.push([i.index, i.total]);
        order.push(i.id);
      },
    });
    assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]], 'queue positions reported');
    assert.deepEqual(order, [c, b, a], 'freshest articles are classified first');

    assert.equal(result.enriched, 3);
    assert.equal(result.duplicates, 1);
    // the newer twin was enriched first, so the older one is the repeat
    const rows = db.prepare('SELECT id, duplicate_of FROM articles ORDER BY id').all();
    assert.deepEqual(rows, [
      { id: a, duplicate_of: b },
      { id: b, duplicate_of: null },
      { id: c, duplicate_of: null },
    ]);
  } finally {
    await stub.close();
  }
});

test('new repeats point to the group root; re-enriched originals stay roots', async () => {
  const db = tempDb();
  const stub = await startOllamaStub();
  stub.chat = () => ({ topics: ['news'], summary: 'Same event.' });
  stub.embed = () => [1, 0, 0, 0]; // everything matches everything

  const vecBlob = Buffer.from(Float32Array.from([1, 0, 0, 0]).buffer);
  const a = seedArticle(db, { title: 'Original', published: '2026-07-01T00:00:00Z' });
  const b = seedArticle(db, { title: 'Copy', published: '2026-07-02T00:00:00Z' });
  db.prepare("UPDATE articles SET status='enriched', embedding=? WHERE id = ?").run(vecBlob, a);
  db.prepare("UPDATE articles SET status='enriched', embedding=?, duplicate_of=? WHERE id = ?").run(vecBlob, a, b);

  try {
    const config = testConfig();
    const llm = new Ollama({ ...config.ollama, url: stub.url });

    // A new copy matches b most strongly but must point to the root, a.
    const c = seedArticle(db, { title: 'Third copy', published: '2026-07-03T00:00:00Z' });
    await enrichPending(db, config, llm);
    assert.equal(
      db.prepare('SELECT duplicate_of FROM articles WHERE id = ?').get(c).duplicate_of,
      a,
      'repeat points to the group root, not another repeat',
    );

    // Re-enriching the original matches its own repeats -> must stay root.
    db.prepare("UPDATE articles SET status='pending', enrich_attempts=0 WHERE id = ?").run(a);
    await enrichPending(db, config, llm);
    assert.equal(
      db.prepare('SELECT duplicate_of FROM articles WHERE id = ?').get(a).duplicate_of,
      null,
      'no cycle: the re-enriched original keeps its root status',
    );
  } finally {
    await stub.close();
  }
});

test('reclassification: note + guidelines reach the prompt, topics are replaced, queue is jumped', async () => {
  const db = tempDb();
  const stub = await startOllamaStub();
  try {
    const config = testConfig();
    const llm = new Ollama({ ...config.ollama, url: stub.url });

    // first pass classifies as software
    stub.chat = () => ({ topics: ['software'], summary: 'About things.', depth: 3 });
    const old = seedArticle(db, { title: 'Corrected later', published: '2026-07-01T00:00:00Z' });
    await enrichPending(db, config, llm);

    // reader disagrees; a fresher pending article competes for the queue
    db.prepare("INSERT INTO meta (key, value) VALUES ('guidelines', 'embedded systems are hardware')").run();
    db.prepare(`UPDATE articles SET status='pending', enrich_attempts=0, enrich_priority=1,
                enrich_note='this is about hardware, not software' WHERE id = ?`).run(old);
    seedArticle(db, { title: 'Fresh competitor', published: '2026-07-05T00:00:00Z' });

    stub.calls.chat.length = 0;
    stub.chat = () => ({ topics: ['hardware'], summary: 'About hardware.', depth: 4 });
    const order = [];
    await enrichPending(db, config, llm, { onItem: (i) => order.push(i.id) });

    assert.equal(order[0], old, 'reclassification request jumps the newest-first queue');
    const prompt = stub.calls.chat[0].messages[1].content;
    assert.match(prompt, /embedded systems are hardware/, 'guidelines included');
    assert.match(prompt, /this is about hardware, not software/, 'reader note included');
    assert.match(prompt, /previous classification gave topics \[software\] and depth 3/i);

    const topics = db.prepare(`
      SELECT t.name FROM article_topics at JOIN topics t ON t.id = at.topic_id
      WHERE at.article_id = ?
    `).all(old).map((r) => r.name);
    assert.deepEqual(topics, ['hardware'], 'old topics replaced, not merged');
    const art = db.prepare('SELECT depth, enrich_priority FROM articles WHERE id = ?').get(old);
    assert.equal(art.depth, 4, 'depth re-evaluated');
    assert.equal(art.enrich_priority, 0, 'priority cleared after the run');
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

test('enrich.workers processes articles concurrently', async () => {
  const db = tempDb();
  const stub = await startOllamaStub();
  let active = 0;
  let peak = 0;
  stub.chat = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 60));
    active--;
    return { topics: ['x'], summary: 'S.' };
  };
  for (let i = 0; i < 4; i++) seedArticle(db, { title: `Article ${i}` });

  try {
    const config = testConfig();
    config.enrich.workers = 2;
    const llm = new Ollama({ ...config.ollama, url: stub.url });
    const indexes = [];
    const result = await enrichPending(db, config, llm, {
      onItem: (i) => indexes.push(i.index),
    });
    assert.equal(result.enriched, 4);
    assert.equal(result.failed, 0);
    assert.equal(peak, 2, 'two generations in flight at once');
    assert.deepEqual(indexes, [1, 2, 3, 4], 'progress index is monotonic under parallelism');
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
