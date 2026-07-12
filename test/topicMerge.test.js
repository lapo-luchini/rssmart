import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, startOllamaStub, testConfig } from './helpers.js';
import { proposeTopicMerges, applyTopicMerge } from '../src/topicMerge.js';
import { enrichPending, existingTopicNames, resolveTopicId } from '../src/enrich.js';
import { Ollama } from '../src/llm.js';
import { compressText } from '../src/compress.js';

function seedArticle(db, title) {
  db.prepare("INSERT OR IGNORE INTO feeds (id, url) VALUES (1, 'http://f')").run();
  const { lastInsertRowid } = db
    .prepare('INSERT INTO articles (feed_id, guid, title, content, published_at) VALUES (1, ?, ?, ?, ?)')
    .run(`g-${title}`, title, compressText('body'), null);
  return Number(lastInsertRowid);
}

function seedTopic(db, name) {
  return db.prepare('INSERT INTO topics (name) VALUES (?) RETURNING id').get(name).id;
}

test('proposeTopicMerges: valid proposals kept, unknown/self/duplicate-from ones dropped', async () => {
  const db = tempDb();
  const stub = await startOllamaStub();
  try {
    seedTopic(db, 'ai');
    seedTopic(db, 'artificial-intelligence');
    seedTopic(db, 'sports');
    stub.chat = () => ({
      merges: [
        { from: 'artificial-intelligence', to: 'ai', reason: 'same concept' },
        { from: 'sports', to: 'sports', reason: 'self-merge, must be dropped' },
        { from: 'not-a-real-topic', to: 'ai', reason: 'unknown from, must be dropped' },
        { from: 'ai', to: 'not-a-real-topic', reason: 'unknown to, must be dropped' },
        { from: 'artificial-intelligence', to: 'sports', reason: 'duplicate from, must be dropped (first wins)' },
      ],
    });
    const config = testConfig();
    const llm = new Ollama({ ...config.ollama, url: stub.url });
    const proposals = await proposeTopicMerges(db, llm);
    assert.deepEqual(proposals, [{ from: 'artificial-intelligence', to: 'ai', reason: 'same concept' }]);
  } finally {
    await stub.close();
  }
});

test('proposeTopicMerges: fewer than two topics short-circuits without calling the LLM', async () => {
  const db = tempDb();
  seedTopic(db, 'only-one');
  let called = false;
  const llm = { chatJSON: async () => { called = true; return { merges: [] }; } };
  const proposals = await proposeTopicMerges(db, llm);
  assert.deepEqual(proposals, []);
  assert.equal(called, false);
});

test('applyTopicMerge: retags articles, collapses an already-double-tagged one, deletes the old topic, records an alias', () => {
  const db = tempDb();
  const a1 = seedArticle(db, 'one');
  const a2 = seedArticle(db, 'two'); // will end up tagged with both from/to before the merge
  const from = seedTopic(db, 'artificial-intelligence');
  const to = seedTopic(db, 'ai');
  db.prepare('INSERT INTO article_topics (article_id, topic_id) VALUES (?, ?)').run(a1, from);
  db.prepare('INSERT INTO article_topics (article_id, topic_id) VALUES (?, ?)').run(a2, from);
  db.prepare('INSERT INTO article_topics (article_id, topic_id) VALUES (?, ?)').run(a2, to);

  applyTopicMerge(db, 'artificial-intelligence', 'ai');

  const topics = db.prepare('SELECT name FROM topics ORDER BY name').all().map((r) => r.name);
  assert.deepEqual(topics, ['ai'], 'the old topic is gone, only the canonical one remains');

  const a1Topics = db.prepare(`
    SELECT t.name FROM article_topics at JOIN topics t ON t.id = at.topic_id WHERE at.article_id = ?
  `).all(a1).map((r) => r.name);
  assert.deepEqual(a1Topics, ['ai'], 'retagged to the canonical topic');

  const a2Topics = db.prepare(`
    SELECT t.name FROM article_topics at JOIN topics t ON t.id = at.topic_id WHERE at.article_id = ?
  `).all(a2).map((r) => r.name);
  assert.deepEqual(a2Topics, ['ai'], 'double-tagged article collapses to a single row, not a PK violation');

  const alias = db.prepare('SELECT canonical_topic_id FROM topic_aliases WHERE alias_name = ?').get('artificial-intelligence');
  assert.equal(alias.canonical_topic_id, to);
});

test('applyTopicMerge: a later merge repoints an already-recorded alias to the new canonical topic', () => {
  const db = tempDb();
  const a = seedTopic(db, 'a');
  const b = seedTopic(db, 'b');
  const c = seedTopic(db, 'c');
  applyTopicMerge(db, 'a', 'b'); // alias: a -> b
  applyTopicMerge(db, 'b', 'c'); // b itself gets merged away next

  const aliasA = db.prepare('SELECT canonical_topic_id FROM topic_aliases WHERE alias_name = ?').get('a');
  const aliasB = db.prepare('SELECT canonical_topic_id FROM topic_aliases WHERE alias_name = ?').get('b');
  assert.equal(aliasA.canonical_topic_id, c, 'the earlier alias now resolves to the final canonical topic, not the deleted intermediate one');
  assert.equal(aliasB.canonical_topic_id, c);
});

test('applyTopicMerge: throws on unknown or identical topic names, changes nothing', () => {
  const db = tempDb();
  seedTopic(db, 'real');
  assert.throws(() => applyTopicMerge(db, 'ghost', 'real'), /unknown topic "ghost"/);
  assert.throws(() => applyTopicMerge(db, 'real', 'ghost'), /unknown topic "ghost"/);
  assert.throws(() => applyTopicMerge(db, 'real', 'real'), /same topic/);
});

test('resolveTopicId redirects a merged-away name to its canonical topic', () => {
  const db = tempDb();
  seedTopic(db, 'artificial-intelligence');
  const aiId = seedTopic(db, 'ai');
  applyTopicMerge(db, 'artificial-intelligence', 'ai');

  assert.equal(resolveTopicId(db, 'artificial-intelligence'), aiId, 'redirected through the alias, not recreated');
  assert.equal(resolveTopicId(db, 'ai'), aiId);

  const brandNewId = resolveTopicId(db, 'quantum-computing');
  assert.ok(brandNewId, 'a genuinely new name still creates a topic');
  assert.notEqual(brandNewId, aiId);
});

test('end to end: a classification that names a merged-away topic gets silently redirected', async () => {
  const db = tempDb();
  const stub = await startOllamaStub();
  try {
    const aiId = seedTopic(db, 'ai');
    seedTopic(db, 'artificial-intelligence');
    applyTopicMerge(db, 'artificial-intelligence', 'ai');

    stub.chat = () => ({ topics: ['artificial-intelligence'], summary: 'S.', depth: 3 });
    seedArticle(db, 'A fresh AI article');
    const config = testConfig();
    const llm = new Ollama({ ...config.ollama, url: stub.url });
    await enrichPending(db, config, llm);

    const names = existingTopicNames(db, 0);
    assert.deepEqual(names, ['ai'], 'no new "artificial-intelligence" topic was recreated');
    const row = db.prepare(`
      SELECT t.id FROM article_topics at JOIN topics t ON t.id = at.topic_id
      WHERE at.article_id = (SELECT id FROM articles ORDER BY id DESC LIMIT 1)
    `).get();
    assert.equal(row.id, aiId);
  } finally {
    await stub.close();
  }
});
