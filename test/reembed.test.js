import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, startOllamaStub, testConfig } from './helpers.js';
import { syncEmbeddingSpace, reembedMissing, bufToVec } from '../src/enrich.js';
import { Ollama } from '../src/llm.js';
import { compressText } from '../src/compress.js';

function seedEnriched(db, title, withVectors = true) {
  db.prepare("INSERT OR IGNORE INTO feeds (id, url) VALUES (1, 'http://f')").run();
  const blob = withVectors ? Buffer.from(Float16Array.from([1, 0]).buffer) : null;
  return Number(db.prepare(`
    INSERT INTO articles (feed_id, guid, title, content, summary, status, embedding, text_embedding)
    VALUES (1, ?, ?, ?, 'a summary', 'enriched', ?, ?)
  `).run(`g-${title}`, title, compressText('body text'), blob, blob).lastInsertRowid);
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
  assert.equal(r.changed, true);
  assert.equal(r.cleared, 2);
  const art = db.prepare('SELECT embedding, text_embedding FROM articles').get();
  assert.equal(art.embedding, null);
  assert.equal(art.text_embedding, null);

  // legacy DB: vectors exist but no record -> treated as changed
  const legacy = tempDb();
  seedEnriched(legacy, 'old');
  const l = syncEmbeddingSpace(legacy, testConfig());
  assert.equal(l.changed, true);
});

test('hybrid setup: dedup model change clears only the summary column, text model only the text column', () => {
  const db = tempDb();
  const config = testConfig();
  config.ollama.embedModel = 'model-a';
  config.ollama.dedupEmbedModel = 'dedup-a';

  // record both spaces silently, then flip just the text model: only
  // text_embedding is stale — the dedup column must survive untouched.
  assert.deepEqual(syncEmbeddingSpace(db, config), { changed: false });
  seedEnriched(db, 'one');
  assert.deepEqual(syncEmbeddingSpace(db, config), { changed: false });
  config.ollama.embedModel = 'model-b';
  const r = syncEmbeddingSpace(db, config);
  assert.deepEqual(r, { changed: true, cleared: 1, dedupChanged: false, textChanged: true });
  const art = db.prepare('SELECT embedding, text_embedding FROM articles').get();
  assert.notEqual(art.embedding, null, 'dedup vectors kept');
  assert.equal(art.text_embedding, null, 'text vectors cleared');

  // and flipping just the dedup model: only the summary column goes stale.
  config.ollama.embedModel = 'model-a';
  assert.deepEqual(syncEmbeddingSpace(db, config), { changed: false });
  config.ollama.dedupEmbedModel = 'dedup-b';
  const r2 = syncEmbeddingSpace(db, config);
  assert.deepEqual(r2, { changed: true, cleared: 1, dedupChanged: true, textChanged: false });
  const art2 = db.prepare('SELECT embedding, text_embedding FROM articles').get();
  assert.equal(art2.embedding, null, 'dedup vectors cleared');
  assert.equal(art2.text_embedding, null, 'text vectors still cleared from above');
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
