import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, startOllamaStub, testConfig } from './helpers.js';
import { syncEmbeddingSpace, reembedMissing, bufToVec } from '../src/enrich.js';
import { Ollama } from '../src/llm.js';

function seedEnriched(db, title, withVectors = true) {
  db.prepare("INSERT OR IGNORE INTO feeds (id, url) VALUES (1, 'http://f')").run();
  const blob = withVectors ? Buffer.from(Float16Array.from([1, 0]).buffer) : null;
  return Number(db.prepare(`
    INSERT INTO articles (feed_id, guid, title, content, summary, status, embedding, text_embedding)
    VALUES (1, ?, ?, 'body text', 'a summary', 'enriched', ?, ?)
  `).run(`g-${title}`, title, blob, blob).lastInsertRowid);
}

test('syncEmbeddingSpace records, detects changes, clears stale vectors', () => {
  const db = tempDb();
  const config = testConfig();
  config.ollama.embedModel = 'model-a';

  // empty DB: record silently
  assert.deepEqual(syncEmbeddingSpace(db, config), { changed: false });
  // same model again: no-op
  seedEnriched(db, 'one');
  assert.deepEqual(syncEmbeddingSpace(db, config), { changed: false });

  // model changed: vectors cleared
  config.ollama.embedModel = 'model-b';
  const r = syncEmbeddingSpace(db, config);
  assert.deepEqual(r, { changed: true, from: 'model-a::default::f16', cleared: 1 });
  const art = db.prepare('SELECT embedding, text_embedding FROM articles').get();
  assert.equal(art.embedding, null);
  assert.equal(art.text_embedding, null);

  // legacy DB: vectors exist but no record -> treated as changed
  const legacy = tempDb();
  seedEnriched(legacy, 'old');
  const l = syncEmbeddingSpace(legacy, testConfig());
  assert.equal(l.changed, true);
  assert.equal(l.from, 'unknown');
});

test('reembedMissing fills vectors with the document prefix, respects deadline', async () => {
  const db = tempDb();
  const stub = await startOllamaStub();
  try {
    const config = testConfig();
    config.ollama.embedPrefixes = { document: 'search_document: ', query: '' };
    const llm = new Ollama({ ...config.ollama, url: stub.url });

    const a = seedEnriched(db, 'Needs vectors', false);
    seedEnriched(db, 'Already has vectors');

    // expired deadline: nothing happens
    const late = await reembedMissing(db, config, llm, { deadline: Date.now() - 1 });
    assert.equal(late.reembedded, 0);

    const r = await reembedMissing(db, config, llm);
    assert.equal(r.reembedded, 1, 'only the article missing vectors');
    const art = db.prepare('SELECT embedding, text_embedding FROM articles WHERE id = ?').get(a);
    assert.ok(art.embedding && art.text_embedding);
    assert.equal(bufToVec(art.embedding).length, 8);
    assert.ok(
      stub.calls.embed.every((c) => c.input.startsWith('search_document: ')),
      'document prefix applied',
    );
  } finally {
    await stub.close();
  }
});
