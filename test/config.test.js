import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';

function writeConfig(content) {
  const dir = mkdtempSync(join(tmpdir(), 'rssmart-'));
  const file = join(dir, 'config.yaml');
  writeFileSync(file, content);
  return { dir, file };
}

test('loads YAML, merges defaults, resolves db against config dir', () => {
  const { dir, file } = writeConfig(`
db: ./my-data/news.db
ollama:
  url: http://macmini.local:11434
`);
  const config = loadConfig(file);
  assert.equal(config.db, join(dir, 'my-data', 'news.db'));
  assert.equal(config.ollama.url, 'http://macmini.local:11434');
  assert.equal(config.ollama.embedModel, 'nomic-embed-text', 'default survives partial override');
  assert.equal(config.enrich.dupThreshold, 0.87, 'untouched section keeps defaults');
  assert.equal(config.cron.maxRunMs, 300_000, 'cron time budget default');
});

test('JSON is accepted too (YAML superset)', () => {
  const { file } = writeConfig('{"ollama": {"url": "http://example:11434"}}');
  assert.equal(loadConfig(file).ollama.url, 'http://example:11434');
});

test('helpful errors for missing file, bad syntax, bad shape', () => {
  assert.throws(() => loadConfig('/nonexistent/config.yaml'), /cannot read config file/);
  assert.throws(() => loadConfig(writeConfig('feeds: [').file), /not valid YAML/);
  assert.throws(() => loadConfig(writeConfig('just a string').file), /YAML mapping/);
});

test('validation rejects wrong types', () => {
  assert.throws(
    () => loadConfig(writeConfig('server:\n  port: "not-a-number"').file),
    /config.server.port: expected number, got string/,
  );
});

test('validation rejects null for non-nullable fields', () => {
  assert.throws(
    () => loadConfig(writeConfig('server:\n  port: null').file),
    /config.server.port: expected number, got null/,
  );
});

test('validation warns on unknown keys', () => {
  // Should not throw — just warn to stderr
  const { file } = writeConfig('enrich:\n  dedupEmbedDimensions: 64');
  const config = loadConfig(file);
  assert.equal(config.enrich.dedupEmbedDimensions, 64);
});