import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { testConfig } from './helpers.js';
import { enrichPending, getReaderContent, requestReclassification, syncEmbeddingSpace } from '../src/enrich.js';
import { compressText } from '../src/compress.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rssmart-enrichment-race-'));
  const db = openDb(join(dir, 'fixture.db')), other = openDb(join(dir, 'fixture.db'));
  t.after(() => { other.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const config = testConfig(); config.enrich.fetchMinChars = 0;
  syncEmbeddingSpace(db, config);
  db.exec("INSERT INTO feeds(id,url,active) VALUES(1,'https://example.invalid',0)");
  const vector = Buffer.from(Float16Array.from([1, 0]).buffer);
  db.prepare(`INSERT INTO articles(id,feed_id,guid,title,content,status,summary,embedding,text_embedding)
    VALUES(1,1,'one','Article',?,'enriched','Original',?,?)`).run(compressText('Original body'), vector, vector);
  return { db, other, config };
}
const llm = (chatJSON) => ({ available: async () => true, chatJSON, embed: async () => Float16Array.from([1, 0]) });
const reply = { topics: ['topic'], summary: 'Older reply', depth: 3 };

test('article inputs and request revision are captured atomically across a second-connection update', async (t) => {
  const { db, other, config } = fixture(t);
  requestReclassification(db, 1, 'request-alpha');
  const prepare = db.prepare.bind(db);
  let intervened = false, usedOldNote = false;
  t.mock.method(db, 'prepare', (sql) => {
    const statement = prepare(sql);
    if (sql.includes('SELECT id, url, title, content, full_content, depth, enrich_note')) {
      const get = statement.get.bind(statement);
      statement.get = (...args) => {
        const row = get(...args);
        if (row && !intervened) {
          intervened = true;
          requestReclassification(other, row.id, 'request-beta');
        }
        return row;
      };
    }
    return statement;
  });
  const result = await enrichPending(db, config, llm(async (_, input) => {
    usedOldNote = input.includes('request-alpha');
    return reply;
  }));
  assert.equal(intervened, true); assert.equal(usedOldNote, true);
  assert.equal(result.enriched, 0); assert.equal(result.superseded, 1);
  assert.deepEqual(db.prepare('SELECT status,enrich_note,summary FROM articles').get(), {
    status: 'pending', enrich_note: 'request-beta', summary: 'Original',
  });
});

test('the failure UPDATE itself rejects a request superseded immediately before the write', async (t) => {
  const { db, other, config } = fixture(t);
  config.enrich.maxAttempts = 1;
  requestReclassification(db, 1, 'request-alpha');
  const prepare = db.prepare.bind(db);
  let intervened = false;
  t.mock.method(db, 'prepare', (sql) => {
    const statement = prepare(sql);
    if (sql.includes('SET enrich_attempts = enrich_attempts + 1')) {
      const run = statement.run.bind(statement);
      statement.run = (...args) => {
        if (!intervened) { intervened = true; requestReclassification(other, 1, 'request-beta'); }
        return run(...args);
      };
    }
    return statement;
  });
  const result = await enrichPending(db, config, llm(async () => { throw new Error('Older request failed'); }));
  assert.equal(intervened, true); assert.equal(result.failed, 0); assert.equal(result.superseded, 1);
  assert.deepEqual(db.prepare('SELECT status,enrich_attempts,enrich_note FROM articles').get(), {
    status: 'pending', enrich_attempts: 0, enrich_note: 'request-beta',
  });
});

test('a stale reader fetch cannot refill content cleared by a newer classification request', async (t) => {
  const { db, other, config } = fixture(t);
  config.enrich.fetchMinChars = 500; config.enrich.allowPrivateFetch = true;
  db.prepare("UPDATE articles SET url='http://127.0.0.1/fixture' WHERE id=1").run();
  let release, started, fetches = 0;
  const waiting = new Promise((resolve) => { release = resolve; });
  const fetched = new Promise((resolve) => { started = resolve; });
  t.mock.method(globalThis, 'fetch', async () => {
    const index = ++fetches;
    if (index === 1) { started(); await waiting; }
    const text = index === 1 ? 'OLDER_CONTENT' : 'NEWER_CONTENT';
    return new Response(`<html><head><title>Fixture extraction</title></head><body><article><h1>Fixture extraction</h1><p>${`${text} A substantial sentence from the fixture article. `.repeat(80)}</p></article></body></html>`, {
      headers: { 'content-type': 'text/html' },
    });
  });
  const work = getReaderContent(db, db.prepare('SELECT * FROM articles').get(), config);
  await fetched;
  requestReclassification(other, 1, 'request-beta');
  release();
  assert.equal((await work).source, 'fetched');
  assert.equal(db.prepare('SELECT full_content FROM articles').get().full_content, null);
  let newerUsed = false;
  const result = await enrichPending(db, config, llm(async (_, input) => {
    assert.ok(!input.includes('OLDER_CONTENT'));
    newerUsed = input.includes('NEWER_CONTENT');
    return reply;
  }));
  assert.equal(result.enriched, 1); assert.equal(newerUsed, true); assert.equal(fetches, 2);
});
