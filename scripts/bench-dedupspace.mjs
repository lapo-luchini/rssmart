#!/usr/bin/env node
// Dedup-strength A/B: harrier-0.6b vs qwen3-embedding:0.6b at 64/128/256
// dims, on the same labeled duplicate pairs from the real archive (seeded
// identically to bench-embed.js / bench-embed-threshold.js).
// Answers whether the "wrong-model" constructor bug (config key
// dedupEmbedModel vs llm's embedModelDedup — fixed) meaningfully degraded
// dedup: under the bug, production wrote dedup vectors with the TEXT model
// (harrier) at the dedup dims.

import { loadConfig } from '../src/config.js';
import { openReadOnlyDb } from '../src/db.js';
import { Ollama } from '../src/llm.js';

const config = loadConfig();
const db = openReadOnlyDb(config.db);
let rngState = 7;
const rand = () => (rngState = (rngState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const dupPairs = db.prepare('SELECT a.id AS dup_id, a.duplicate_of AS root_id FROM articles a WHERE a.duplicate_of IS NOT NULL').all();
function sample(arr, n) {
  const copy = [...arr], out = [];
  while (out.length < n && copy.length > 0) out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
  return out;
}
const dupSample = sample(dupPairs, 800);
const ids = [...new Set(dupSample.flatMap((p) => [p.dup_id, p.root_id]))];
const arts = db.prepare(`SELECT id, feed_id, title, summary, published_at FROM articles WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);

const DAY = 86400000;
const negPairs = [];
let guard = 0;
while (negPairs.length < 800 && guard++ < 30000) {
  const a = arts[Math.floor(rand() * arts.length)];
  const cands = arts.filter((b) =>
    b.id !== a.id && b.feed_id === a.feed_id && a.published_at && b.published_at &&
    Math.abs(new Date(a.published_at) - new Date(b.published_at)) <= 14 * DAY &&
    (a.duplicate_of ?? a.id) !== (b.duplicate_of ?? b.id) &&
    b.duplicate_of !== a.id && a.duplicate_of !== b.id);
  if (cands.length) negPairs.push([a.id, cands[Math.floor(rand() * cands.length)].id]);
}
console.log(`pairs: ${dupSample.length} dup / ${negPairs.length} same-feed negatives, ${arts.length} unique articles`);

const cos = (a, b) => { let s = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i]; return s; };

function auc(pos, neg) {
  const all = [...pos.map((v) => ({ v, p: 1 })), ...neg.map((v) => ({ v, p: 0 }))].sort((l, r) => l.v - r.v);
  let rankSum = 0, i = 0;
  while (i < all.length) {
    let j = i;
    while (j < all.length && all[j].v === all[i].v) j++;
    const mid = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) if (all[k].p) rankSum += mid;
    i = j;
  }
  return (rankSum - pos.length * (pos.length + 1) / 2) / (pos.length * neg.length);
}
const fprAt = (neg, t) => neg.filter((s) => s >= t).length / neg.length;
const recallAt = (pos, t) => pos.filter((s) => s >= t).length / pos.length;

const results = {};
for (const [model, dims] of [
  ['leoipulsar/harrier-0.6b', 64], ['leoipulsar/harrier-0.6b', 128], ['leoipulsar/harrier-0.6b', 256],
  ['qwen3-embedding:0.6b', 64], ['qwen3-embedding:0.6b', 128], ['qwen3-embedding:0.6b', 256],
]) {
  const llm = new Ollama({ ...config.ollama, embedModel: model });
  const vecs = new Map();
  for (const a of arts) vecs.set(a.id, await llm.embed(`${a.title}\n${a.summary}`, 'document', dims));
  const pos = dupSample.flatMap((p) => (vecs.has(p.dup_id) && vecs.has(p.root_id) ? [cos(vecs.get(p.dup_id), vecs.get(p.root_id))] : []));
  const neg = negPairs.map((p) => cos(vecs.get(p[0]), vecs.get(p[1])));
  results[`${model.replace('leoipulsar/', '')}@${dims}`] = { pos, neg };
  console.log(`embedded ${model}@${dims}`);
}

console.log('\nresults (same seeded pair sets as the earlier benchmarks):');
for (const key of Object.keys(results)) {
  const { pos, neg } = results[key];
  const q = (arr, x) => [...arr].sort((a, b) => a - b)[Math.floor(x * (arr.length - 1))];
  console.log(
    `  ${key.padEnd(22)} AUC ${auc(pos, neg).toFixed(4)} | R@0.87 ${(recallAt(pos, 0.87) * 100).toFixed(1)}% FPR ${(fprAt(neg, 0.87) * 100).toFixed(2)}%` +
    ` | pos p05/p50 ${q(pos, 0.05).toFixed(3)}/${q(pos, 0.5).toFixed(3)} neg p50/p95 ${q(neg, 0.5).toFixed(3)}/${q(neg, 0.95).toFixed(3)}`);
}

// FPR-matched recall against the deployed baseline so far: production's
// dedup space has been harrier@256 (written under the constructor bug).
const base = results['harrier-0.6b@256'];
const baseFPR = fprAt(base.neg, 0.87);
console.log(`\nFPR-matched at harrier@256's own FPR ${(baseFPR * 100).toFixed(2)}%:`);
for (const key of Object.keys(results)) {
  const { pos, neg } = results[key];
  const sorted = [...neg].sort((x, y) => x - y);
  const t = sorted[Math.floor((1 - baseFPR) * (sorted.length - 1))];
  console.log(`  ${key.padEnd(18)} recall ${(recallAt(pos, t) * 100).toFixed(1)}% @ ${t.toFixed(3)}`);
}
db.close();
