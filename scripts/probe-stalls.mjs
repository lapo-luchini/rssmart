#!/usr/bin/env node
// Diagnose recurring event-loop stalls next to a running rssmart instance.
// Read-only: never opens a write connection, never executes git — statSync
// and plain file reads only, so it can run alongside the live server and
// never disturb the behavior it measures.
//
// It samples every 10ms:
//   - event-loop lag (drift of a chained 10ms timer)
//   - WAL file size, with the delta since the previous sample
//   - /proc/pressure/io avg10 (if PSI is available)
//
// and reports every gap >= --threshold, annotated with what coincided:
//   stall + WAL SHRINKAGE  -> an autocheckpoint flush (WAL copied back
//                             into the db and fsynced)
//   stall + WAL growth     -> many/late writes inside the gap
//   stall + flat WAL       -> compute or non-WAL IO (e.g. an origin fetch)
//
// Usage: node scripts/probe-stalls.mjs [--db data/rssmart.db]
//        [--duration 120] [--threshold 150]
// Safe to run next to a live serve; also works standalone (no app traffic
// -> also a useful baseline: if stalls STILL occur with the app paused,
// it's the host, not the app).

import { statSync, readFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const DB = arg('--db', process.env.RSSMART_DB ?? 'data/rssmart.db');
const DURATION = Number(arg('--duration', 120)) * 1000;
const THRESHOLD = Number(arg('--threshold', 150));

const walPath = `${DB}-wal`;
const psiPath = '/proc/pressure/io';
const hasPsi = existsSync(psiPath);
console.log(`probing for ${DURATION / 1000}s | db: ${DB} | threshold: ${THRESHOLD}ms | PSI: ${hasPsi}`);

const walBytes = () => { try { return statSync(walPath).size } catch { return 0 } };
const parsePsi = () => {
  if (!hasPsi) return null;
  try {
    const line = readFileSync(psiPath, 'utf8').split('\n')[0];
    return Number(line.match(/some avg10=([\d.]+)/)?.[1]);
  } catch { return null; }
};

const events = [];
const end = Date.now() + DURATION;

(async () => {
  let prev = performance.now();
  let prevWal = walBytes();
  let prevPsi = parsePsi();
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 10));
    const now = performance.now();
    const gap = now - prev;
    prev = now;
    const wal = walBytes();
    const psi = parsePsi();
    // combine consecutive silent misses into one event window (like the
    // watchdog's own sampling: a longer elaborated gap reports as one)
    if (gap >= THRESHOLD) {
      events.push({
        at: new Date().toISOString(),
        gap: Math.round(gap),
        wal,
        delta: wal - prevWal,
        psi: psi != null ? psi.toFixed(1) : null,
      });
    }
    prevWal = wal;
    prevPsi = psi;
  }

  console.log(`\ndetected ${events.length} stall windows >= ${THRESHOLD}ms:`);
  for (const e of events) {
    const d = e.delta === 0 ? 'WAL flat' : e.delta < 0 ? `WAL ${e.delta} B (checkpoint flush)` : `WAL +${e.delta}`;
    console.log(`  ${e.at}  stall ${String(e.gap).padStart(5)}ms  ${d}`);
  }
  const biggest = events.reduce((m, e) => Math.max(m, e.gap), 0);
  console.log(`biggest sampled gap: ${biggest}ms`);
})();
