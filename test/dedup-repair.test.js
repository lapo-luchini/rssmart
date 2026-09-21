import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { openDb, openReadOnlyDb } from '../src/db.js';
import { tempDb } from './helpers.js';
import { analyzeDuplicateGroups, inspectDuplicateGroups, repairDisconnectedGroups } from '../src/dedupRepair.js';

const options = { threshold: .8, dimensions: 2 };
const blob = (v) => v == null ? null : Buffer.from(Float16Array.from(v).buffer);
const atAngle = (degrees) => [Math.cos(degrees * Math.PI / 180), Math.sin(degrees * Math.PI / 180)];
const row = (id, parent, vector) => ({ id, duplicate_of: parent, embedding: blob(vector) });
const inspect = (rows, overrides = {}) => analyzeDuplicateGroups(rows, { ...options, ...overrides });

test('graph validation accepts a star and a connected chain with distant endpoints', () => {
  assert.equal(inspect([row(1, null, atAngle(0)), row(2, 1, atAngle(20)), row(3, 1, atAngle(-20))])[0].verdict, 'connected');
  const [chain] = inspect([row(1, null, atAngle(0)), row(2, 1, atAngle(30)), row(3, 1, atAngle(60))]);
  assert.equal(chain.verdict, 'connected');
  assert.deepEqual(chain.components, [[1, 2, 3]]);
  assert.equal(chain.comparisons, 3);
});

test('mutually similar siblings cannot certify an isolated root', () => {
  const [group] = inspect([row(1, null, [1, 0]), row(2, 1, [0, 1]), row(3, 1, [0, 1])]);
  assert.equal(group.verdict, 'disconnected');
  assert.deepEqual(group.components, [[1], [2, 3]]);
});

test('two internally connected pairs remain disconnected as one stored group', () => {
  const [group] = inspect([row(1, null, [1, 0]), row(2, 1, [1, 0]), row(3, 1, [0, 1]), row(4, 1, [0, 1])]);
  assert.equal(group.verdict, 'disconnected');
  assert.deepEqual(group.components, [[1, 2], [3, 4]]);
});

test('missing or invalid vectors make disconnection unmeasurable rather than valid or repairable', () => {
  for (const missing of [null, [1, 0, 0], [NaN, 0], [0, 0], [2, 0]]) {
    const [group] = inspect([row(1, null, [1, 0]), row(2, 1, missing), row(3, 1, [0, 1])]);
    assert.equal(group.verdict, 'unmeasurable');
    assert.deepEqual(group.unavailable, [2]);
  }
});

test('missing roots, nested groups and incompatible space metadata are never certified', () => {
  assert.equal(inspect([row(2, 1, [1, 0])])[0].verdict, 'unmeasurable');
  const nested = inspect([row(1, null, [1, 0]), row(2, 1, [1, 0]), row(3, 2, [1, 0])]);
  assert.ok(nested.every((g) => g.invalidStructure && g.verdict === 'unmeasurable'));
  assert.equal(inspect([row(1, null, [1, 0]), row(2, 1, [1, 0])], { spaceCompatible: false })[0].verdict, 'unmeasurable');
});

function seed(db, rows) {
  db.prepare("INSERT INTO feeds (id,url) VALUES (1,'https://example.invalid')").run();
  const add = db.prepare(`INSERT INTO articles
    (id,feed_id,guid,title,embedding,duplicate_of,status,vote,read_at)
    VALUES (?,1,?,'Article',?,?,'enriched',1,'2026-09-01T00:00:00Z')`);
  for (const item of rows) add.run(item.id, String(item.id), item.embedding, item.duplicate_of);
}
const disconnected = () => [row(1, null, [1, 0]), row(2, 1, [0, 1]), row(3, 1, [0, 1])];
const links = (db) => db.prepare('SELECT id,duplicate_of FROM articles ORDER BY id').all();

test('repair splits complete components once, retains feedback and never immediately reattaches them', (t) => {
  const db = tempDb(); t.after(() => db.close()); seed(db, disconnected());
  const before = db.prepare('SELECT id,vote,read_at,embedding FROM articles ORDER BY id').all();
  const result = repairDisconnectedGroups(db, options);
  assert.equal(result.splitGroups, 1); assert.equal(result.changedLinks, 2);
  assert.deepEqual(links(db).map((r) => r.duplicate_of), [null, null, 2]);
  assert.deepEqual(db.prepare('SELECT id,vote,read_at,embedding FROM articles ORDER BY id').all(), before);
  assert.ok(inspectDuplicateGroups(db, options).every((g) => g.verdict === 'connected'));
  assert.equal(repairDisconnectedGroups(db, options).changedLinks, 0);
});

test('repair refuses incomplete groups whose missing member could bridge observed components', (t) => {
  const db = tempDb(); t.after(() => db.close());
  seed(db, [...disconnected(), row(4, 1, null)]);
  const before = links(db);
  assert.equal(repairDisconnectedGroups(db, options).changedLinks, 0);
  assert.deepEqual(links(db), before);
});

test('repair rolls back all component moves when one update fails', (t) => {
  const db = tempDb(); t.after(() => db.close()); seed(db, disconnected());
  db.exec(`CREATE TRIGGER reject_split BEFORE UPDATE OF duplicate_of ON articles
    WHEN NEW.id=3 BEGIN SELECT RAISE(ABORT,'fixture failure'); END`);
  assert.throws(() => repairDisconnectedGroups(db, options), /fixture failure/);
  assert.deepEqual(links(db).map((r) => r.duplicate_of), [null, 1, 1]);
});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rssmart-repair-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'sample.db');
  const db = openDb(dbPath); seed(db, disconnected());
  db.prepare("INSERT INTO meta (key,value) VALUES ('embed_model_dedup','fixture-embed::2::f16')").run();
  db.close();
  const config = YAML.parse(readFileSync(new URL('../config.example.yaml', import.meta.url), 'utf8'));
  config.db = dbPath; config.ollama.embedModel = 'fixture-embed'; config.ollama.dedupEmbedModel = 'fixture-embed';
  config.ollama.embedDimensions = 2; config.ollama.dedupEmbedDimensions = 2;
  config.enrich.dupThreshold = .8;
  const configPath = join(dir, 'config.yaml');
  writeFileSync(configPath, YAML.stringify(config));
  const run = (...args) => {
    const result = spawnSync(process.execPath, [new URL('../scripts/repair-dedup.js', import.meta.url).pathname, '--json', ...args], {
      encoding: 'utf8', env: { ...process.env, RSSMART_CONFIG: configPath }, timeout: 10000,
    });
    assert.equal(result.error, undefined, 'CLI subprocess must actually execute');
    return result;
  };
  return { dir, dbPath, run };
}
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('CLI dry-run reports the isolated root and preserves the database bytes', (t) => {
  const { dbPath, run } = fixture(t);
  const before = hash(dbPath), result = run();
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, 'readonly'); assert.equal(report.counts.disconnected, 1);
  assert.equal(report.counts.connected, 0); assert.equal(report.changedLinks, 0);
  assert.equal(hash(dbPath), before);
});

test('CLI fix splits the group, while the next dry-run has no disconnected component', (t) => {
  const { dbPath, run } = fixture(t);
  const result = run('--fix');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).changedLinks, 2);
  const report = JSON.parse(run().stdout);
  assert.deepEqual(report.counts, { connected: 1, disconnected: 0, unmeasurable: 0 });
  const db = openReadOnlyDb(dbPath);
  assert.deepEqual(links(db).map((r) => r.duplicate_of), [null, null, 2]);
  db.close();
});

test('CLI refuses incompatible schemas and absent databases without migration or creation', (t) => {
  const { dbPath, run } = fixture(t);
  const db = openDb(dbPath); db.exec('PRAGMA user_version=0'); db.close();
  const before = hash(dbPath);
  const result = run('--fix');
  assert.notEqual(result.status, 0); assert.match(result.stderr, /read-only benchmark requires database schema/);
  assert.equal(hash(dbPath), before);
  rmSync(dbPath);
  assert.notEqual(run().status, 0);
  assert.equal(existsSync(dbPath), false);
});

test('CLI does not repair a group when recorded model provenance is incompatible', (t) => {
  const { dbPath, run } = fixture(t);
  const db = openDb(dbPath);
  db.prepare("UPDATE meta SET value='other-model::2::f16' WHERE key='embed_model_dedup'").run();
  db.close();
  const result = run('--fix');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.provenance, 'missing-or-incompatible');
  assert.equal(report.counts.unmeasurable, 1);
  assert.equal(report.changedLinks, 0);
  const read = openReadOnlyDb(dbPath);
  assert.deepEqual(links(read).map((r) => r.duplicate_of), [null, 1, 1]);
  read.close();
});
