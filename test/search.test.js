import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, startOllamaStub, testConfig } from './helpers.js';
import { semanticSearch } from '../src/search.js';
import { Ollama } from '../src/llm.js';

const vec = (...values) => Buffer.from(Float16Array.from(values).buffer);

function seedArticle(db, id, embedding, extra = {}) {
  db.prepare("INSERT OR IGNORE INTO feeds (id, url) VALUES (1, 'http://f')").run();
  db.prepare(`
    INSERT INTO articles (id, feed_id, guid, title, status, text_embedding, duplicate_of)
    VALUES (?, 1, ?, ?, 'enriched', ?, ?)
  `).run(id, `g${id}`, extra.title ?? `Article ${id}`, embedding, extra.duplicateOf ?? null);
}

test('semanticSearch ranks by cosine similarity and respects the SQL filter', async () => {
  const db = tempDb();
  seedArticle(db, 1, vec(1, 0));
  seedArticle(db, 2, vec(0, 1));
  seedArticle(db, 3, null); // no embedding (e.g. still pending) -> never a candidate

  const stub = await startOllamaStub();
  stub.embed = () => [1, 0];
  try {
    const llm = new Ollama({ ...testConfig().ollama, url: stub.url });

    const all = await semanticSearch(db, llm, 'anything', { whereSql: '', params: [], grouped: true });
    assert.deepEqual(all.map((r) => r.id), [1, 2], 'ranked by similarity, article 3 excluded');
    assert.ok(all[0].similarity > all[1].similarity);

    const filtered = await semanticSearch(db, llm, 'anything', {
      whereSql: 'WHERE a.id = ?', params: [2], grouped: true,
    });
    assert.deepEqual(filtered.map((r) => r.id), [2], 'the caller\'s SQL filter still applies');
  } finally {
    await stub.close();
  }
});

test('semanticSearch collapses duplicate groups to the best-matching member', async () => {
  const db = tempDb();
  seedArticle(db, 1, vec(0.5, 0.5)); // root, moderate match
  seedArticle(db, 2, vec(1, 0), { duplicateOf: 1 }); // repeat, closer match to the query

  const stub = await startOllamaStub();
  stub.embed = () => [1, 0];
  try {
    const llm = new Ollama({ ...testConfig().ollama, url: stub.url });

    const grouped = await semanticSearch(db, llm, 'q', { whereSql: '', params: [], grouped: true });
    assert.deepEqual(
      grouped.map((r) => r.id), [2],
      'the closer-matching repeat represents the group, not the higher-scoring root',
    );

    const ungrouped = await semanticSearch(db, llm, 'q', { whereSql: '', params: [], grouped: false });
    assert.deepEqual(ungrouped.map((r) => r.id).sort(), [1, 2]);
  } finally {
    await stub.close();
  }
});

test('semanticSearch surfaces an unreachable Ollama by rejecting', async () => {
  const db = tempDb();
  seedArticle(db, 1, vec(1, 0));
  const llm = new Ollama({ ...testConfig().ollama, url: 'http://127.0.0.1:1' });
  await assert.rejects(() =>
    semanticSearch(db, llm, 'q', { whereSql: '', params: [], grouped: true }));
});

test('semanticSearch with no candidates never calls the embedder', async () => {
  const db = tempDb();
  const stub = await startOllamaStub();
  try {
    const llm = new Ollama({ ...testConfig().ollama, url: stub.url });
    const result = await semanticSearch(db, llm, 'q', { whereSql: '', params: [], grouped: true });
    assert.deepEqual(result, []);
    assert.equal(stub.calls.embed.length, 0);
  } finally {
    await stub.close();
  }
});
