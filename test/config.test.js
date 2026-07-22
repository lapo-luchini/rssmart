import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import YAML from 'yaml';
import { loadConfig } from '../src/config.js';

const examplePath = join(process.cwd(), 'config.example.yaml');

/** Write a complete config from the example, optionally with overrides. */
function writeConfig(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rssmart-'));
  const file = join(dir, 'config.yaml');
  let obj = YAML.parse(readFileSync(examplePath, 'utf8'));
  for (const [k, v] of Object.entries(overrides)) {
    if (typeof v === 'object' && !Array.isArray(v) && obj[k]) {
      obj[k] = { ...obj[k], ...v };
    } else {
      obj[k] = v;
    }
  }
  writeFileSync(file, YAML.stringify(obj));
  return { dir, file };
}

test('loads a full config and resolves db against config dir', () => {
  const { dir, file } = writeConfig({ server: { port: 8099 } });
  const config = loadConfig(file);
  assert.equal(config.db, join(dir, 'data', 'rssmart.db'));
  assert.equal(config.server.port, 8099);
  assert.equal(config.ollama.chatModel, 'gemma4:12b-it-qat');
  assert.equal(config.scoring.weights.embedding, 0.4);
});

test('helpful errors for missing file, bad syntax, bad shape', () => {
  assert.throws(() => loadConfig('/nonexistent/config.yaml'), /cannot read config file/);

  // Bad YAML: write a broken file directly
  const dir = mkdtempSync(join(tmpdir(), 'rssmart-'));
  const broken = join(dir, 'config.yaml');
  writeFileSync(broken, 'feeds: [\n');
  assert.throws(() => loadConfig(broken), /not valid YAML/);

  // Wrong shape: not a mapping
  writeFileSync(broken, 'just a string');
  assert.throws(() => loadConfig(broken), /YAML mapping/);
});

test('validation rejects missing keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rssmart-'));
  const file = join(dir, 'config.yaml');
  writeFileSync(file, 'db: ./data/rssmart.db\nollama:\n  url: http://localhost:11434');
  assert.throws(() => loadConfig(file), /missing key/);
});

test('validation rejects wrong types', () => {
  const { file } = writeConfig({ server: { port: 'not-a-number' } });
  assert.throws(() => loadConfig(file), /expected number, got string/);
});

test('validation warns on unknown keys but does not throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rssmart-'));
  const file = join(dir, 'config.yaml');
  writeFileSync(file, readFileSync(examplePath, 'utf8') + '\nunknownSection:\n  foo: 1\n');
  const config = loadConfig(file);
  assert.ok(config);
});