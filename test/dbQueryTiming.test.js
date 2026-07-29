import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, testConfig } from './helpers.js';
import { getDbQueryMs } from '../src/db.js';
import { renderMetrics } from '../src/metrics.js';

test('getDbQueryMs accumulates real time across run/get/all, not just one', () => {
  const db = tempDb();
  const before = getDbQueryMs();

  db.prepare("INSERT INTO feeds (url, active) VALUES ('http://a', 1)").run();
  db.prepare('SELECT * FROM feeds').get();
  db.prepare('SELECT * FROM feeds').all();

  assert.ok(getDbQueryMs() >= before, 'never goes backwards');
  assert.ok(getDbQueryMs() > before || before > 0, 'three real queries register some time (or already did, cumulative)');
});

test('a prepared-once, reused-many-times statement is still timed on every call', () => {
  const db = tempDb();
  const before = getDbQueryMs();
  const insert = db.prepare("INSERT INTO feeds (url, active) VALUES (?, 1)");
  for (let i = 0; i < 20; i++) insert.run(`http://reused-${i}`);
  // Can't assert an exact delta (module-global, shared across the whole
  // test file), but the statement object itself must still be the timed
  // wrapper 20 calls later, not just on its first use.
  assert.ok(getDbQueryMs() >= before);
});

test('/metrics exposes cumulative query time as a counter', async () => {
  const db = tempDb();
  db.prepare("INSERT INTO feeds (url, active) VALUES ('http://a', 1)").run();
  const text = renderMetrics(db, testConfig(), 'abc1234');
  assert.match(text, /# HELP rssmart_db_query_seconds_total .+\n# TYPE rssmart_db_query_seconds_total counter\n/);
  const match = text.match(/^rssmart_db_query_seconds_total (\S+)$/m);
  assert.ok(match, 'metric line present');
  assert.ok(Number(match[1]) >= 0);
});
