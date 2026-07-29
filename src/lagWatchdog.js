// Detects when the Node.js event loop itself stalls — the mechanism behind
// "the web UI is unresponsive during enrichment" even though SQLite's WAL
// mode (see db.js) means a write transaction never actually blocks a read
// at the database level. Node has a single thread: any synchronous call
// (a SQLite query, a happy-dom parse, plain JS computation) blocks
// *everything* else running in the process, including an HTTP request
// that would otherwise be instant. A short setInterval tick measures its
// own drift from the expected period — any drift past `thresholdMs` is a
// real stall, not ordinary timer jitter.

import { readFileSync, openSync, writeSync, fsyncSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

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

// Portable across every OS Node runs on (unlike PSI, Linux-only): times a
// real write+fsync against the same filesystem the SQLite DB lives on, so
// a stall on FreeBSD (no /proc/pressure at all) still gets direct evidence
// of whether the disk itself was slow at that moment, not just a guess.
// fsync matters — without it the write could land in page cache and
// return instantly even while the underlying disk is genuinely stalled.
function diskProbeMs(probeDir) {
  if (!probeDir) return null;
  const path = join(probeDir, `.lag-watchdog-probe-${process.pid}`);
  const start = performance.now();
  let fd;
  try {
    fd = openSync(path, 'w');
    writeSync(fd, 'x');
    fsyncSync(fd);
    return performance.now() - start;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(path); } catch { /* best effort cleanup */ }
  }
}

export const _diskProbeMsForTests = diskProbeMs;

export function startLagWatchdog({ log, intervalMs = 50, thresholdMs = 200, probeDir } = {}) {
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const lag = now - last - intervalMs;
    last = now;
    if (lag > thresholdMs) {
      stallCount++;
      if (lag > maxLagMs) maxLagMs = lag;
      const probe = diskProbeMs(probeDir);
      last = performance.now(); // exclude the probe's own time from the next tick's lag
      const probeInfo = probe === null ? '' : ` (disk probe: ${probe.toFixed(0)}ms write+fsync)`;
      log(`event loop stalled for ${lag.toFixed(0)}ms${probeInfo}${psiSummary()}`);
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
