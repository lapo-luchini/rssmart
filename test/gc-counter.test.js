import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, testConfig } from './helpers.js';
import { renderMetrics, _recordGcForTests, getGcStats } from '../src/metrics.js';

function metricValue(text, name, labels) {
  const labelStr = labels ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}` : '';
  const escaped = `${name}${labelStr}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^${escaped} (\\S+)$`, 'm'));
  return match ? Number(match[1]) : undefined;
}

test('gc counters render per kind, accumulating via the test hook', () => {
  const db = tempDb();
  db.prepare("INSERT INTO feeds (id, url) VALUES (1, 'http://f')").run();

  const before = getGcStats();
  _recordGcForTests('major', 120);
  _recordGcForTests('major', 80);
  _recordGcForTests('minor', 5);

  const text = renderMetrics(db, testConfig(), 'test');
  assert.equal(
    metricValue(text, 'nodejs_gc_runs_total', { type: 'major' }),
    (before.major?.runs ?? 0) + 2,
    'major runs counted',
  );
  assert.equal(
    metricValue(text, 'nodejs_gc_runs_total', { type: 'minor' }),
    (before.minor?.runs ?? 0) + 1,
    'minor runs counted',
  );
  // zero-count kinds still render — the documented or-vector(0) convention
  assert.ok(metricValue(text, 'nodejs_gc_runs_total', { type: 'incremental' }) !== undefined);
  assert.equal(
    metricValue(text, 'nodejs_gc_duration_seconds', { type: 'major' }) * 1000,
    before.major.durationMs + 200,
    'cumulative duration accumulated',
  );
});
