// Detects when the Node.js event loop itself stalls — the mechanism behind
// "the web UI is unresponsive during enrichment" even though SQLite's WAL
// mode (see db.js) means a write transaction never actually blocks a read
// at the database level. Node has a single thread: any synchronous call
// (a SQLite query, a happy-dom parse, plain JS computation) blocks
// *everything* else running in the process, including an HTTP request
// that would otherwise be instant. A short setInterval tick measures its
// own drift from the expected period — any drift past `thresholdMs` is a
// real stall, not ordinary timer jitter.

import { readFileSync } from 'node:fs';

let maxLagMs = 0;
let stallCount = 0;

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

export function startLagWatchdog({ log, intervalMs = 50, thresholdMs = 200 } = {}) {
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const lag = now - last - intervalMs;
    last = now;
    if (lag > thresholdMs) {
      stallCount++;
      if (lag > maxLagMs) maxLagMs = lag;
      log(`event loop stalled for ${lag.toFixed(0)}ms${psiSummary()}`);
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
