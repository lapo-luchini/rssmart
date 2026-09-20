import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { loadConfig } from '../src/config.js';
import { tempDb } from './helpers.js';
import { recomputeScores } from '../src/scoring.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rssmart-config-domain-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.yaml');
  const original = YAML.parse(readFileSync(new URL('../config.example.yaml', import.meta.url), 'utf8'));
  return (changes) => {
    const config = structuredClone(original);
    for (const [key, value] of Object.entries(changes)) {
      const parts = key.split('.');
      const property = parts.pop();
      const object = parts.reduce((value, part) => value[part], config);
      if (value === undefined) delete object[property];
      else object[property] = value;
    }
    writeFileSync(path, YAML.stringify(config));
    return loadConfig(path);
  };
}

test('numeric config fields reject YAML NaN and infinities with their full field path', (t) => {
  const load = fixture(t);
  for (const field of ['scoring.knn', 'scoring.weights.depth', 'scoring.hotDecayPerDay',
    'enrich.dupThreshold', 'ollama.timeoutMs', 'scheduler.minIntervalMin', 'server.port']) {
    for (const value of [NaN, Infinity, -Infinity]) {
      assert.throws(() => load({ [field]: value }), (error) =>
        error.message.includes(`config.${field}: must be finite`));
    }
  }
});

test('counts, dimensions, workers and ports reject fractional and out-of-domain values', (t) => {
  const load = fixture(t);
  for (const field of ['scoring.knn', 'enrich.workers', 'enrich.maxAttempts', 'enrich.fetchMinChars',
    'enrich.maxInputChars', 'enrich.maxArticleChars', 'enrich.maxSuggestedTopics',
    'enrich.linkExpandMaxChars', 'ollama.embedDimensions', 'ollama.dedupEmbedDimensions']) {
    for (const value of [-1, 0.5, 0x100000000, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => load({ [field]: value }), (error) => error.message.includes(`config.${field}:`));
    }
  }
  for (const field of ['enrich.workers', 'enrich.maxAttempts', 'enrich.maxInputChars',
    'enrich.maxArticleChars', 'ollama.embedDimensions', 'ollama.dedupEmbedDimensions']) {
    assert.throws(() => load({ [field]: 0 }), (error) => error.message.includes(`config.${field}:`));
  }
  for (const value of [-1, 1.5, 65536]) assert.throws(() => load({ 'server.port': value }), /config.server.port:/);
  assert.equal(load({ 'server.port': 0 }).server.port, 0, 'runtime-assigned port is valid');
  assert.equal(load({ 'server.port': 65535 }).server.port, 65535);
});

test('timer domains and scheduler order fail during configuration loading', (t) => {
  const load = fixture(t);
  for (const field of ['ollama.timeoutMs', 'ollama.topicMergeTimeoutMs']) {
    for (const value of [-1, 0, 0.5, 0x80000000]) assert.throws(() => load({ [field]: value }), /config.ollama/);
  }
  assert.throws(() => load({ 'scheduler.minIntervalMin': 20, 'scheduler.maxIntervalMin': 10 }), /must be <=/);
  assert.throws(() => load({ 'scheduler.minIntervalMin': 0 }), /config.scheduler.minIntervalMin:/);
  assert.throws(() => load({ 'cron.maxRunMs': -1 }), /config.cron.maxRunMs:/);
  assert.equal(load({ 'cron.maxRunMs': 0 }).cron.maxRunMs, 0);
});

test('cosine thresholds, decays and weights enforce their semantic domains', (t) => {
  const load = fixture(t);
  for (const value of [-1.01, 1.01]) assert.throws(() => load({ 'enrich.dupThreshold': value }), /config.enrich.dupThreshold:/);
  for (const value of [-1, 0, 1]) assert.equal(load({ 'enrich.dupThreshold': value }).enrich.dupThreshold, value);
  for (const field of ['scoring.weights.topics', 'scoring.weights.embedding', 'scoring.weights.depth', 'scoring.weights.feed',
    'scoring.voteDecayHalflifeYears', 'scoring.recomputeDebounceSec', 'scoring.hotDecayPerDay',
    'enrich.dupWindowDays', 'triage.roundRobinWindowDays']) {
    assert.throws(() => load({ [field]: -1 }), (error) => error.message.includes(`config.${field}:`));
  }
  const config = load({ 'scoring.weights.topics': 3, 'scoring.weights.embedding': 4 });
  assert.equal(config.scoring.weights.topics + config.scoring.weights.embedding, 7, 'weights need not sum to one');
  assert.throws(() => load({ 'scoring.weights.topics': Number.MAX_VALUE, 'scoring.weights.embedding': Number.MAX_VALUE }), /sum must be finite/);
});

test('optional null/omitted values, fractional intervals and zero-disable settings retain their meaning', async (t) => {
  const load = fixture(t);
  for (const value of [null, undefined]) {
    assert.doesNotThrow(() => load({
      'ollama.embedDimensions': value, 'ollama.dedupEmbedDimensions': value,
      'scoring.voteDecayHalflifeYears': value, 'enrich.maxSuggestedTopics': value,
    }));
  }
  const config = load({
    'scoring.knn': 0, 'scoring.recomputeDebounceSec': 0, 'scoring.hotDecayPerDay': 0,
    'scoring.voteDecayHalflifeYears': 0, 'scoring.weights.topics': 0,
    'scoring.weights.embedding': 0, 'scoring.weights.depth': 0, 'scoring.weights.feed': 0,
    'enrich.fetchMinChars': 0, 'enrich.linkExpandMaxChars': 0, 'enrich.maxSuggestedTopics': 0,
    'enrich.dupWindowDays': 0, 'triage.roundRobinWindowDays': 0,
    'scheduler.minIntervalMin': 0.5, 'scheduler.maxIntervalMin': 1.25,
  });
  const db = tempDb();
  t.after(() => db.close());
  db.exec("INSERT INTO feeds(id,url) VALUES(1,'https://example.invalid'); INSERT INTO articles(feed_id,guid,title,status) VALUES(1,'g','Article','enriched')");
  await recomputeScores(db, config);
  assert.ok(Number.isFinite(db.prepare('SELECT score FROM articles').get().score));
});
