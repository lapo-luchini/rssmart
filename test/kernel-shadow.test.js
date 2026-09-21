import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { openDb } from '../src/db.js';
import { parseKernelShadowArgs, runKernelShadow } from '../scripts/score-kernel-shadow.js';

const now = '2026-09-20T00:00:00Z';
const blob = (vector) => vector === null ? null : Buffer.from(Float16Array.from(vector).buffer);
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rssmart-kernel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'sample.db');
  const db = openDb(dbPath);
  db.prepare("INSERT INTO feeds (id,url) VALUES (1,'https://example.invalid')").run();
  const add = db.prepare(`INSERT INTO articles
    (id,feed_id,guid,title,content,full_content,summary,text_embedding,status,vote,voted_at,created_at,score)
    VALUES (?,1,?,'PRIVATE TITLE','PRIVATE CONTENT','PRIVATE FULL','PRIVATE SUMMARY',?,'enriched',?,?,?,.987654321)`);
  for (const [id, vote, vector] of [[1, 2, [1, 0]], [2, -2, [0, 1]], [3, 0, [1, 0]], [4, 0, [0, 1]], [5, 0, null], [6, 0, [.8, .6]]]) {
    add.run(id, String(id), blob(vector), vote, vote ? now : null, now);
  }
  db.prepare("INSERT INTO meta (key,value) VALUES ('embed_model_text','fixture-embed::2::f16')").run();
  db.close();
  const config = YAML.parse(readFileSync(new URL('../config.example.yaml', import.meta.url), 'utf8'));
  config.db = dbPath; config.ollama.embedModel = 'fixture-embed'; config.ollama.embedDimensions = 2;
  // Production settings must not leak into the frozen experimental defaults.
  config.scoring.knn = 1; config.scoring.voteDecayHalflifeYears = .001;
  config.scoring.weights = { topics: 123, embedding: 456, depth: 789, feed: 42 };
  const configPath = join(dir, 'config.yaml');
  writeFileSync(configPath, YAML.stringify(config));
  const options = (...args) => parseKernelShadowArgs(['--config', configPath, '--now', now, ...args]);
  const run = (...args) => runKernelShadow(options(...args));
  const mutate = (fn) => { const writable = openDb(dbPath); try { fn(writable); } finally { writable.close(); } };
  return { dir, dbPath, configPath, config, run, options, mutate };
}

test('readonly entry point scores only unvoted candidates, omits content/stored scores and makes no model calls', (t) => {
  const { dbPath, run } = fixture(t);
  const before = hash(dbPath), originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('unexpected network/model request'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const report = run();
  assert.equal(report.mode, 'readonly'); assert.equal(report.experimental, true);
  assert.deepEqual(report.results.map((r) => r.id), [6, 4, 3]);
  assert.equal(report.results.find((r) => r.id === 3).score, .5);
  assert.equal(report.results.find((r) => r.id === 4).score, -.5);
  assert.deepEqual(report.parameters, { tau: .2, k: 15, exponent: 1, lambda: 1, halfLifeYears: 1.5, now: Date.parse(now) / 1000 });
  assert.equal(report.selection.voted, 2); assert.equal(report.selection.candidatesWithoutEmbedding, 1);
  assert.equal(report.embeddingSpace.metadataKind, 'legacy-model-dimensions-only');
  assert.equal(report.embeddingSpace.pipelineHistoryVerified, false);
  assert.equal(report.snapshot.consistentReadTransaction, true);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|987654321|storedScore|score_embedding/);
  assert.equal(hash(dbPath), before);
});

test('CLI selectors and explicit parameters are reproducible and report their actual scope', (t) => {
  const { run } = fixture(t);
  assert.deepEqual(run('--limit', '1').results.map((r) => r.id), [6]);
  const all = run('--all');
  assert.equal(all.selection.policy, 'all-unvoted-with-embedding');
  assert.equal(all.selection.scoredCandidates, 3);
  const selected = run('--candidate-id', '3', '--candidate-id', '4', '--tau', '0', '--k', '1', '--exponent', '2', '--lambda', '3', '--half-life', '0');
  assert.equal(selected.selection.policy, 'explicit-unvoted-ids');
  assert.deepEqual(selected.results.map((r) => r.id), [3, 4]);
  assert.equal(selected.results[0].score, .25);
  assert.equal(selected.parameters.exponent, 2); assert.equal(selected.parameters.halfLifeYears, 0);
  assert.equal(run('--all').snapshot.selectedInputsSha256, all.snapshot.selectedInputsSha256);
  assert.notEqual(selected.snapshot.selectedInputsSha256, all.snapshot.selectedInputsSha256);
});

test('explicit IDs cannot score a voted, missing or unembedded article', (t) => {
  const { run } = fixture(t);
  for (const id of ['1', '5', '999']) assert.throws(() => run('--candidate-id', id), /must exist, be unvoted/);
});

test('missing training vectors are refused rather than quietly changing the evidence set', (t) => {
  const { mutate, run } = fixture(t);
  mutate((db) => db.prepare('UPDATE articles SET text_embedding=NULL WHERE id=1').run());
  assert.throws(() => run(), /voted article\(s\) lack text embeddings/);
});

test('missing, mismatched and unknown pipeline metadata stop execution; matching v2 remains recorded provenance only', (t) => {
  const { mutate, run, config } = fixture(t);
  const identity = { version: 2, model: 'fixture-embed', dimensions: 2, storage: 'f16', documentPrefix: config.ollama.embedPrefixes.document, preprocessing: 'stripHtml-v1/sampleText-v2', input: 'title-text-4000-v1' };
  const set = (value) => mutate((db) => db.prepare("UPDATE meta SET value=? WHERE key='embed_model_text'").run(value));
  for (const metadata of ['other-model::2::f16', '{}', JSON.stringify({ ...identity, documentPrefix: 'unexpected' }), JSON.stringify({ ...identity, input: 'title-summary-v1' }), JSON.stringify({ ...identity, version: 3 })]) {
    set(metadata); assert.throws(() => run(), /incompatible text embedding provenance/);
  }
  set(JSON.stringify(identity));
  const report = run();
  assert.equal(report.embeddingSpace.metadataKind, 'document-pipeline-v2');
  assert.equal(report.embeddingSpace.pipelineHistoryVerified, false);
  mutate((db) => db.prepare("DELETE FROM meta WHERE key='embed_model_text'").run());
  assert.throws(() => run(), /incompatible text embedding provenance/);
});

test('dimension, unit norm and finite-value guards cover all training and selected candidates', (t) => {
  const { mutate, run } = fixture(t);
  for (const vector of [[1, 0, 0], [2, 0], [0, 0], [NaN, 0], [Infinity, 0]]) {
    mutate((db) => db.prepare('UPDATE articles SET text_embedding=? WHERE id=1').run(blob(vector)));
    assert.throws(() => run('--candidate-id', '3'), /embedding/);
  }
  mutate((db) => {
    db.prepare('UPDATE articles SET text_embedding=? WHERE id=1').run(blob([1, 0]));
    db.prepare('UPDATE articles SET text_embedding=? WHERE id=4').run(blob([1, 0, 0]));
  });
  assert.equal(run('--candidate-id', '3').results.length, 1);
  assert.throws(() => run('--all'), /wrong-dimensional/);
});

test('default-dimensional metadata still requires one common observed dimension', (t) => {
  const { config, configPath, mutate, run } = fixture(t);
  config.ollama.embedDimensions = null;
  writeFileSync(configPath, YAML.stringify(config));
  mutate((db) => db.prepare("UPDATE meta SET value='fixture-embed::default::f16' WHERE key='embed_model_text'").run());
  assert.equal(run().embeddingSpace.observedDimensions, 2);
  mutate((db) => db.prepare('UPDATE articles SET text_embedding=? WHERE id=4').run(blob([1, 0, 0])));
  assert.throws(() => run('--all'), /dimension mismatch/);
});

test('unvoted archive with no training returns a neutral prior and zero support', (t) => {
  const { mutate, run } = fixture(t);
  mutate((db) => db.prepare('UPDATE articles SET vote=0').run());
  const report = run();
  assert.equal(report.selection.voted, 0);
  assert.ok(report.results.every((r) => r.score === 0 && r.support.mass === 0 && r.contributions.length === 0));
});

test('a changed vote changes the selected-input fingerprint; parameter-only changes do not', (t) => {
  const { mutate, run } = fixture(t);
  const before = run('--candidate-id', '3');
  const changedParameter = run('--candidate-id', '3', '--lambda', '3');
  assert.equal(changedParameter.snapshot.selectedInputsSha256, before.snapshot.selectedInputsSha256);
  assert.notEqual(changedParameter.results[0].score, before.results[0].score);
  mutate((db) => db.prepare('UPDATE articles SET vote=-2 WHERE id=1').run());
  const after = run('--candidate-id', '3');
  assert.notEqual(after.snapshot.selectedInputsSha256, before.snapshot.selectedInputsSha256);
  assert.equal(after.results[0].score, -.5);
});

test('incompatible schema and missing DB are refused without migration or creation', (t) => {
  const { dbPath, mutate, run } = fixture(t);
  mutate((db) => db.exec('PRAGMA user_version=0'));
  const before = hash(dbPath);
  assert.throws(() => run(), /read-only benchmark requires database schema/);
  assert.equal(hash(dbPath), before);
  rmSync(dbPath);
  assert.throws(() => run(), /ENOENT|existing file/);
  assert.equal(existsSync(dbPath), false);
});

test('argument parser rejects ambiguous selection, duplicate IDs and unknown options', () => {
  for (const args of [['--all', '--limit', '1'], ['--candidate-id', '3', '--all'], ['--limit', '1', '--candidate-id', '3'], ['--candidate-id', '3', '--candidate-id', '3'], ['--limit', '0'], ['--k', '2', '--k', '3'], ['--tau'], ['--mystery']]) {
    assert.throws(() => parseKernelShadowArgs(args));
  }
  assert.equal(parseKernelShadowArgs(['--now', '2026-09-20 00:00:00']).parameters.now, Date.parse(now) / 1000);
});

test('actual CLI emits parseable readonly JSON and help works without a config', (t) => {
  const { dbPath, configPath } = fixture(t);
  const before = hash(dbPath), script = new URL('../scripts/score-kernel-shadow.js', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [script, '--config', configPath, '--now', now, '--candidate-id', '3'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined, 'CLI subprocess must actually execute');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).results[0].score, .5);
  assert.equal(hash(dbPath), before);
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, RSSMART_CONFIG: '/does-not-exist' } });
  assert.equal(help.error, undefined); assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Experimental signed vote signal/);
});
