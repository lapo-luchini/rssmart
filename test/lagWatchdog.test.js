import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLagWatchdog, getLagStats, _readPsiForTests, _diskProbeMsForTests } from '../src/lagWatchdog.js';

test('_readPsiForTests degrades to null for a nonexistent resource instead of throwing', () => {
  assert.equal(_readPsiForTests('not-a-real-psi-resource'), null);
});

test('_diskProbeMsForTests times a real write+fsync and degrades gracefully', () => {
  assert.equal(_diskProbeMsForTests(undefined), null, 'no probeDir configured');
  assert.equal(_diskProbeMsForTests(join(tmpdir(), 'not-a-real-dir-xyz')), null, 'nonexistent dir does not throw');
  const ms = _diskProbeMsForTests(tmpdir());
  assert.ok(typeof ms === 'number' && ms >= 0, `real probe against tmpdir returns a duration (${ms})`);
});

function busyWaitMs(ms) {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* deliberately synchronous */ }
}

// Order matters within this file (node:test runs a file's tests
// sequentially, sharing the module's process-lifetime state — same
// pattern as enrich.test.js's cumulative getEnrichTimings assertions):
// this must run before anything below induces a real stall.
test('reports zero before any stall has crossed the threshold', async () => {
  const stop = startLagWatchdog({ log: () => {}, intervalMs: 10, thresholdMs: 10_000 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    const { maxLagMs, stallCount } = getLagStats();
    assert.equal(maxLagMs, 0);
    assert.equal(stallCount, 0);
  } finally {
    stop();
  }
});

test('detects a real synchronous stall past the threshold and logs it', async () => {
  const logs = [];
  const stop = startLagWatchdog({ log: (msg) => logs.push(msg), intervalMs: 20, thresholdMs: 80 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 60)); // let a few clean ticks pass
    busyWaitMs(200); // block the event loop synchronously past the threshold
    await new Promise((resolve) => setTimeout(resolve, 60)); // let the next tick observe it
    const { maxLagMs, stallCount } = getLagStats();
    assert.ok(stallCount >= 1, 'a real stall was counted');
    assert.ok(maxLagMs >= 80, `max lag (${maxLagMs}) reflects the stall, not just the threshold`);
    assert.ok(logs.some((m) => /event loop stalled/.test(m)), 'stall was logged');
  } finally {
    stop();
  }
});

test('stop() clears the interval so it does not keep running', async () => {
  const stop = startLagWatchdog({ log: () => {}, intervalMs: 10, thresholdMs: 10_000 });
  stop();
  const before = getLagStats();
  busyWaitMs(50);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(getLagStats(), before, 'no more ticks fire once stopped');
});
