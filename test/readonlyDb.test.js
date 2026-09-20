import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { openDb, openReadOnlyDb, pragma } from '../src/db.js';

const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rssmart-readonly-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'sample.db');
  const db = openDb(path);
  db.exec("CREATE TABLE readonly_probe (value TEXT); INSERT INTO readonly_probe VALUES ('retained')");
  const version = pragma(db, 'user_version').user_version;
  db.close();
  return { dir, path, version };
}

test('read-only open permits queries and refuses content/schema writes without changing the file', (t) => {
  const { path, version } = fixture(t);
  const before = hash(path);
  const db = openReadOnlyDb(path);
  try {
    assert.equal(db.prepare('SELECT value FROM readonly_probe').get().value, 'retained');
    assert.equal(pragma(db, 'user_version').user_version, version);
    assert.throws(() => db.exec("UPDATE readonly_probe SET value = 'changed'"), /read.?only/i);
    assert.throws(() => db.exec('CREATE TABLE unexpected (value TEXT)'), /read.?only/i);
    assert.throws(() => pragma(db, 'user_version = 999'), /read.?only/i);
  } finally { db.close(); }
  assert.equal(hash(path), before);
});

test('read-only open rejects missing files and older or newer schemas without creating/migrating', (t) => {
  const { dir, path, version } = fixture(t);
  const absent = join(dir, 'missing', 'never-created.db');
  assert.throws(() => openReadOnlyDb(absent), /ENOENT|not.*exist/i);
  assert.equal(existsSync(join(dir, 'missing')), false);
  assert.throws(() => openReadOnlyDb(':memory:'), /ENOENT|not.*exist/i);
  for (const incompatible of [version + 1, version - 1]) {
    const db = openDb(path);
    pragma(db, `user_version = ${incompatible}`);
    db.close();
    const before = hash(path);
    assert.throws(() => openReadOnlyDb(path), /read-only benchmark requires database schema/);
    assert.equal(hash(path), before, `schema ${incompatible} was left intact`);
  }
});

test('every database benchmark rejects an incompatible fixture before model calls and leaves its bytes intact', (t) => {
  const { dir, path } = fixture(t);
  const db = openDb(path);
  pragma(db, 'user_version = 0');
  db.close();
  const before = hash(path);
  const config = YAML.parse(readFileSync(new URL('../config.example.yaml', import.meta.url), 'utf8'));
  config.db = path;
  config.ollama.url = 'http://127.0.0.1:1';
  const configPath = join(dir, 'config.yaml');
  writeFileSync(configPath, YAML.stringify(config));
  for (const script of [
    'bench-embed.js', 'bench-embed-threshold.js', 'bench-embed-mrl.js',
    'bench-dedupspace.mjs', 'bench-model.js', 'bench-comic-alt.js',
  ]) {
    const run = spawnSync(process.execPath, [new URL(`../scripts/${script}`, import.meta.url).pathname, '1'], {
      encoding: 'utf8', env: { ...process.env, RSSMART_CONFIG: configPath }, timeout: 10000,
    });
    assert.equal(run.error, undefined, script);
    assert.notEqual(run.status, 0, script);
    assert.match(run.stderr, /read-only benchmark requires database schema/, script);
    assert.equal(hash(path), before, script);
  }
});
