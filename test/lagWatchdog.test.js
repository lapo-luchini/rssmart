import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startLagWatchdog, getLagStats, _readPsiForTests, markExpectedStall, clearExpectedStall,
} from '../src/lagWatchdog.js';

test('_readPsiForTests degrades to null for a nonexistent resource instead of throwing', () => {
  assert.equal(_readPsiForTests('not-a-real-psi-resource'), null);
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

test('a stall while markExpectedStall is set is annotated, not silenced', async () => {
  const logs = [];
  const stop = startLagWatchdog({ log: (msg) => logs.push(msg), intervalMs: 20, thresholdMs: 80 });
  try {
    markExpectedStall('recomputing scores');
    await new Promise((resolve) => setTimeout(resolve, 60));
    busyWaitMs(200);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(
      logs.some((m) => /event loop stalled/.test(m) && m.includes('(expected: recomputing scores)')),
      `expected an annotated stall line, got: ${JSON.stringify(logs)}`,
    );

    // once cleared, a later stall is unannotated again -- the mark isn't sticky
    clearExpectedStall();
    logs.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 60));
    busyWaitMs(200);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(logs.some((m) => /event loop stalled/.test(m) && !m.includes('(expected:')));
  } finally {
    clearExpectedStall();
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
