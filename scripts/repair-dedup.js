#!/usr/bin/env node
// Re-validate every stored duplicate decision in the CURRENT dedup space.
//
// Why this exists: when the embedding model config changes, stored
// duplicate_of links are never re-derived (re-deriving is O(N²) and old
// decisions were made with the same data). But a model/dims mismatch window
// (e.g. embedModel switched to harrier while the code still routed the
// summary embeddings through embedModel) leaves behind links whose pair
// similarity no longer holds in the current space — visible as a burst of
// false duplicates.
//
// For every stored link this recomputes the summary-embedding similarity of
// the copy against the members of its group in the current space and, with
// --fix, un-links pairs that don't reach the configured dupThreshold against
// ANY member, immediately re-running duplicate detection for the detached
// copy (recheckDuplicates) so genuinely-similar stories re-attach to their
// true best match. Without --fix it only reports. (Similarity isn't
// transitive across a chain, so a link is only stale when the copy fails
// against every member of its own group.)
//
// Also reports legacy rows whose dedup vector length doesn't match the
// configured dedupEmbedDimensions — those are invisible to dedup (cosine
// returns 0 on length mismatch). Clearing them makes reembedMissing rebuild
// them at the configured dims; done only with --fix-legacy.
//
// --drop-old-dedup: dedup vectors are only ever compared against the recent
// window, so vectors for out-of-window articles are dead weight — this
// drops them in bulk (the ongoing trickle is pruned by syncRecentCache, and
// reembedMissing deliberately does not refill them). text_embedding is
// never touched: search and taste kNN reach across the whole archive.
//
// Usage: node scripts/repair-dedup.js [--fix] [--fix-legacy] [--drop-old-dedup]
// (config resolved like bin/rssmart.js; writes nothing without a flag)

import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { recheckDuplicates, bufToVec } from '../src/enrich.js';

const fix = process.argv.includes('--fix');
const fixLegacy = process.argv.includes('--fix-legacy');
const dropOld = process.argv.includes('--drop-old-dedup');
const config = loadConfig();
const db = openDb(config.db);

const dedupDims = config.ollama.dedupEmbedDimensions ?? config.ollama.embedDimensions;
const threshold = config.enrich.dupThreshold;
const dedupCutoff = new Date(Date.now() - config.enrich.dupWindowDays * 86400000).toISOString();
const expectedBytes = dedupDims * 2;
const cosine = (a, b) => {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

if (dropOld) {
  const r = db.prepare('UPDATE articles SET embedding = NULL WHERE embedding IS NOT NULL AND created_at < ?').run(dedupCutoff);
  console.log(`dropped ${r.changes} out-of-window dedup vectors (freed ~${(r.changes * dedupDims * 2 / 1048576).toFixed(1)} MB); run VACUUM to shrink the file`);
} else {
  const kept = db.prepare('SELECT COUNT(*) AS c FROM articles WHERE embedding IS NOT NULL AND created_at < ?').get(dedupCutoff).c;
  console.log(`out-of-window dedup vectors kept: ${kept} (run with --drop-old-dedup to drop them)`);
}

const links = db.prepare(`
  SELECT a.id, a.duplicate_of AS root, a.title AS copyTitle,
         LENGTH(a.embedding) AS copyBytes, LENGTH(b.embedding) AS rootBytes
  FROM articles a JOIN articles b ON b.id = a.duplicate_of
  WHERE a.duplicate_of IS NOT NULL
`).all();
console.log(`stored duplicate links: ${links.length} (threshold ${threshold}, dedup dims ${dedupDims})`);

const legacyRows = db.prepare(`
  SELECT id FROM articles
  WHERE embedding IS NOT NULL AND LENGTH(embedding) != ?
`).all(expectedBytes);
console.log(`dedup vectors with unexpected dims: ${legacyRows.length}${legacyRows.length && !fixLegacy ? ' (run with --fix-legacy to rebuild; note: they are inert — cosine returns 0 against other lengths)' : ''}`);
if (fixLegacy && legacyRows.length) {
  const clear = db.prepare('UPDATE articles SET embedding = NULL WHERE id = ?');
  for (const r of legacyRows) clear.run(r.id);
  console.log(`  cleared ${legacyRows.length} legacy vectors — reembedMissing will rebuild them at ${dedupDims} dims (~${Math.ceil(legacyRows.length * 0.15 / 60)} min of embedding, spread across scheduler batches)`);
}

// decode each involved vector once; group members by root
const vecById = new Map();
const groupMembers = new Map(); // root -> member ids
for (const r of db.prepare(`
  SELECT id, duplicate_of, embedding FROM articles
  WHERE embedding IS NOT NULL
    AND (id IN (SELECT duplicate_of FROM articles WHERE duplicate_of IS NOT NULL)
      OR id IN (SELECT id FROM articles WHERE duplicate_of IS NOT NULL))
`).all()) {
  vecById.set(r.id, bufToVec(r.embedding));
  const root = r.duplicate_of ?? r.id;
  if (!groupMembers.has(root)) groupMembers.set(root, []);
  groupMembers.get(root).push(r.id);
}

let ok = 0, lowSim = 0, mismatch = 0, reattached = 0, stillStandalone = 0;
const worst = [];
for (const link of links) {
  const copyVec = vecById.get(link.id);
  const memberIds = groupMembers.get(link.root);
  if (!copyVec || !memberIds) { mismatch++; continue; }
  let best = 0;
  for (const mid of memberIds) {
    if (mid === link.id) continue;
    const sim = cosine(copyVec, vecById.get(mid));
    if (sim > best) best = sim;
  }
  if (best >= threshold) { ok++; continue; }
  lowSim++;
  worst.push({ id: link.id, root: link.root, sim: best, title: link.copyTitle });
  if (!fix) continue;
  db.prepare('UPDATE articles SET duplicate_of = NULL WHERE id = ?').run(link.id);
  const re = recheckDuplicates(db, config, link.id);
  if (re.duplicateOf) reattached++;
  else stillStandalone++;
}
console.log(`recomputed in current space: ok ${ok}, below threshold vs every group member ${lowSim}${mismatch ? `, not measurable ${mismatch}` : ''}`);
if (worst.length) {
  worst.sort((a, b) => a.sim - b.sim);
  console.log('lowest-sim links (best vs any group member):');
  for (const w of worst.slice(0, 10)) console.log(`  ${w.sim.toFixed(3)} #${w.id} -> #${w.root}  "${w.title.slice(0, 60)}"`);
}
if (fix) console.log(`--fix: unlinked ${lowSim}, re-attached to a better match ${reattached}, still standalone ${stillStandalone}`);
else if (lowSim) console.log(`run with --fix to un-link those and re-run duplicate detection for each`);
db.close();
