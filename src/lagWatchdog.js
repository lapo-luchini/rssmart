// Detects when the Node.js event loop itself stalls — the mechanism behind
// "the web UI is unresponsive during enrichment" even though SQLite's WAL
// mode (see db.js) means a write transaction never actually blocks a read
// at the database level. Node has a single thread: any synchronous call
// (a SQLite query, a happy-dom parse, plain JS computation) blocks
// *everything* else running in the process, including an HTTP request
// that would otherwise be instant. A short setInterval tick measures its
// own drift from the expected period — any drift past `thresholdMs` is a
// real stall, not ordinary timer jitter.

import { readFileSync, statSync } from 'node:fs';

let maxLagMs = 0;
let stallCount = 0;
let expectedReason = null;

/**
 * Mark the event loop as expected to stall for a known reason (e.g. a
 * full recompute sweep) — annotates any stall log line that fires while
 * set, rather than silencing it, so an unrelated new stall during the
 * same window still reads as unexplained instead of getting attributed
 * to the wrong cause. Not stacked: only one reason is tracked at a time,
 * matching the one long-running synchronous job this project actually
 * runs (callers already prevent overlapping sweeps — see scheduler.js's
 * own guard — so this doesn't need to defend against that itself).
 */
export function markExpectedStall(reason) {
  expectedReason = reason;
}

export function clearExpectedStall() {
  expectedReason = null;
}

export function _expectedReasonForTests() {
  return expectedReason;
}

function parsePsiLine(line) {
  const m = line?.match(/avg10=([\d.]+)/);
  return m ? Number(m[1]) : null;
}

// Pressure Stall Information (Linux cgroup v2): the fraction of the last
// 10s some/all tasks in this container spent blocked waiting on a
// resource — a direct, first-party answer to "is a stall actually disk
// contention (e.g. a noisy neighbor on the Proxmox host), not our code?"
// Absent on non-Linux hosts or with PSI disabled — null, not an error.
function readPsi(resource) {
  try {
    const [some, full] = readFileSync(`/proc/pressure/${resource}`, 'utf8').trim().split('\n');
    return { some: parsePsiLine(some), full: parsePsiLine(full) };
  } catch {
    return null;
  }
}

export const _readPsiForTests = readPsi;

function psiSummary() {
  const io = readPsi('io');
  const cpu = readPsi('cpu');
  if (!io && !cpu) return '';
  const pct = (v) => (v === null || v === undefined ? '?' : v);
  return ` (io pressure some=${pct(io?.some)}% full=${pct(io?.full)}%,` +
    ` cpu pressure some=${pct(cpu?.some)}% full=${pct(cpu?.full)}%)`;
}

export function startLagWatchdog({ log, intervalMs = 50, thresholdMs = 200, dbPath = null } = {}) {
  let last = performance.now();
  // WAL size tracked at every sample: when a stall is recorded, the delta
  // across the whole stall window (last sample before the freeze -> first
  // sample after) is the diagnostic — shrinkage means an autocheckpoint
  // copied the WAL back into the db, a flat line means compute, and a big
  // growth marks a writer burst.
  let lastWal = null;
  const timer = setInterval(() => {
    const now = performance.now();
    const walBefore = lastWal;
    let wal = null;
    if (dbPath) {
      try {
        wal = statSync(`${dbPath}-wal`).size;
      } catch {
        wal = 0; // no WAL activity yet, or a :memory: db
      }
    }
    const lag = now - last - intervalMs;
    lastWal = wal;
    last = now;
    if (lag > thresholdMs) {
      stallCount++;
      if (lag > maxLagMs) maxLagMs = lag;
      const reasonSuffix = expectedReason ? ` (expected: ${expectedReason})` : '';
      let walSuffix = '';
      if (dbPath) {
        if (lastWal === 0) walSuffix = ' (wal empty)';
        else if (walBefore == null) walSuffix = '';
        else if (Math.abs(wal - walBefore) < 1024) walSuffix = ` (wal unchanged at ${(wal / 1048576).toFixed(1)} MB)`;
        else if (wal < walBefore) walSuffix = ` (wal ${((walBefore - wal) / 1024) | 0} KB copied back into the db)`;
        else walSuffix = ` (wal +${((wal - walBefore) / 1024) | 0} KB)`;
      }
      log(`event loop stalled for ${lag.toFixed(0)}ms${reasonSuffix}${psiSummary()}${walSuffix}`);
    }
  }, intervalMs);
  timer.unref(); // diagnostic only — must never keep the process alive on its own
  return () => clearInterval(timer);
}

/** Cumulative since process start — worst single stall and how many
 *  crossed the threshold, mirroring enrich.js's phase-timing accumulators
 *  (see rssmart_enrich_slowest_seconds) so this reads the same way in
 *  /metrics: a "since start" watermark plus a running count. */
export function getLagStats() {
  return { maxLagMs, stallCount };
}
