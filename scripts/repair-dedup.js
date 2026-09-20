#!/usr/bin/env node
// Inspect connected components in each stored duplicate group. A child
// having one similar sibling does not establish connectivity to its root.
// Dry-run is enforced readonly, without migrations or model calls.
// --fix splits only complete, comparable, disconnected groups; it never
// reattaches the components immediately through the former stale group.
// --fix-legacy clears wrong-dimension dedup vectors for the usual reembed
// queue. --drop-old-dedup drops vectors outside the configured window.
// Usage: node scripts/repair-dedup.js [--json] [--fix] [--fix-legacy] [--drop-old-dedup]

import { loadConfig } from '../src/config.js';
import { openDb, openReadOnlyDb } from '../src/db.js';
import { inspectDuplicateGroups, repairDisconnectedGroups } from '../src/dedupRepair.js';

const flags = new Set(process.argv.slice(2));
const known = new Set(['--fix', '--fix-legacy', '--drop-old-dedup', '--json']);
for (const flag of flags) if (!known.has(flag)) throw new Error(`unknown option ${flag}`);
const config = loadConfig();
const dimensions = config.ollama.dedupEmbedDimensions ?? config.ollama.embedDimensions;
const model = config.ollama.dedupEmbedModel ?? config.ollama.embedModel;
if (flags.has('--fix-legacy') && !dimensions) throw new Error('--fix-legacy requires explicit dedup embedding dimensions');

// Validate compatibility before even a requested repair can invoke openDb's
// startup migration path. Older snapshots must first be migrated on a copy.
let db = openReadOnlyDb(config.db);
if (flags.has('--fix') || flags.has('--fix-legacy') || flags.has('--drop-old-dedup')) {
  db.close();
  db = openDb(config.db);
}
try {
  const storedSpace = db.prepare("SELECT value FROM meta WHERE key='embed_model_dedup'").get()?.value;
  let spaceCompatible = false;
  let provenance = 'missing-or-incompatible';
  if (storedSpace === `${model}::${dimensions ?? 'default'}::f16`) {
    spaceCompatible = true;
    provenance = 'legacy-model-dimensions-only';
  } else if (storedSpace) {
    try {
      const identity = JSON.parse(storedSpace);
      spaceCompatible = identity.version === 2 && identity.model === model && identity.storage === 'f16'
        && identity.dimensions === (dimensions ?? 'default')
        && identity.documentPrefix === (config.ollama.embedPrefixes?.document ?? '')
        && identity.input === 'title-summary-v1' && identity.preprocessing === 'stripHtml-v1/sampleText-v2';
      if (spaceCompatible) provenance = 'document-pipeline-v2';
    } catch { /* incompatible metadata is reported as unmeasurable */ }
  }
  const cutoff = new Date(Date.now() - config.enrich.dupWindowDays * 86400000).toISOString();
  const outOfWindow = db.prepare('SELECT COUNT(*) AS n FROM articles WHERE embedding IS NOT NULL AND created_at < ?').get(cutoff).n;
  const wrongDimensions = dimensions ? db.prepare('SELECT COUNT(*) AS n FROM articles WHERE embedding IS NOT NULL AND LENGTH(embedding) != ?').get(dimensions * 2).n : null;
  let droppedOld = 0, clearedLegacy = 0;
  if (flags.has('--drop-old-dedup')) droppedOld = db.prepare('UPDATE articles SET embedding=NULL WHERE embedding IS NOT NULL AND created_at < ?').run(cutoff).changes;
  if (flags.has('--fix-legacy')) clearedLegacy = db.prepare('UPDATE articles SET embedding=NULL WHERE embedding IS NOT NULL AND LENGTH(embedding) != ?').run(dimensions * 2).changes;
  const options = { dimensions, threshold: config.enrich.dupThreshold, spaceCompatible };
  const result = flags.has('--fix')
    ? repairDisconnectedGroups(db, options)
    : { groups: inspectDuplicateGroups(db, options), splitGroups: 0, changedLinks: 0 };
  const counts = { connected: 0, disconnected: 0, unmeasurable: 0 };
  for (const group of result.groups) counts[group.verdict]++;
  const report = {
    mode: flags.has('--fix') || flags.has('--fix-legacy') || flags.has('--drop-old-dedup') ? 'write' : 'readonly',
    dimensions, threshold: config.enrich.dupThreshold, provenance,
    outOfWindow, wrongDimensions, droppedOld, clearedLegacy,
    counts, ...result,
  };
  if (flags.has('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`dedup graph: ${counts.connected} connected, ${counts.disconnected} complete disconnected, ${counts.unmeasurable} unmeasurable groups`);
    console.log(`space provenance: ${provenance}; connectivity does not establish semantic correctness`);
    console.log(`out-of-window vectors ${outOfWindow}; wrong dimensions ${wrongDimensions ?? 'unknown (default dimensions)'}; dropped ${droppedOld}; cleared ${clearedLegacy}`);
    for (const group of result.groups.filter((g) => g.verdict !== 'connected').slice(0, 20)) {
      console.log(`#${group.root}: ${group.verdict}; observed components ${JSON.stringify(group.components)}; unavailable ${JSON.stringify(group.unavailable)}${group.invalidStructure ? '; invalid group structure' : ''}`);
    }
    console.log(`split ${result.splitGroups} groups; changed ${result.changedLinks} links; no cross-component reattachment`);
  }
} finally { db.close(); }
