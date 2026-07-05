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
feeds:
  - https://example.com/a.rss
  - url: https://example.com/b.rss
    title: B
ollama:
  url: http://macmini.local:11434
`);
  const config = loadConfig(file);
  assert.equal(config.db, join(dir, 'my-data', 'news.db'));
  assert.deepEqual(config.feeds, [
    { url: 'https://example.com/a.rss' },
    { url: 'https://example.com/b.rss', title: 'B' },
  ]);
  assert.equal(config.ollama.url, 'http://macmini.local:11434');
  assert.equal(config.ollama.embedModel, 'nomic-embed-text', 'default survives partial override');
  assert.equal(config.enrich.dupThreshold, 0.87, 'untouched section keeps defaults');
});

test('JSON is accepted too (YAML superset)', () => {
  const { file } = writeConfig('{"feeds": ["https://example.com/a.rss"]}');
  assert.equal(loadConfig(file).feeds[0].url, 'https://example.com/a.rss');
});

test('helpful errors for missing file, bad syntax, bad shape', () => {
  assert.throws(() => loadConfig('/nonexistent/config.yaml'), /cannot read config file/);
  assert.throws(() => loadConfig(writeConfig('feeds: [').file), /not valid YAML/);
  assert.throws(() => loadConfig(writeConfig('just a string').file), /YAML mapping/);
  assert.throws(() => loadConfig(writeConfig('feeds:\n  - title: no url').file), /every feed needs a "url"/);
});
