// MRL hypothesis test: harrier's docs don't claim Matryoshka support, while
// rssmart truncates via Ollama's `dimensions` param (64 dims for dedup
// summaries, 512 for text). If harrier isn't MRL-trained, its first-k dims
// are not trained to be self-sufficient and truncation itself is the damage
// — predictions:
//   1. harrier dedup @ native 1024 >> harrier @ 64/128 (recovers vs qwen3@64)
//   2. direction agreement cos(native, truncated) much lower for harrier
//   3. harrier text kNN @ 1024 >= @ 512
// Pair sets are seeded identically to bench-embed.js/bench-embed-threshold.js
// so results are directly comparable with the earlier runs.
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { Ollama } from '../src/llm.js';

const config = loadConfig();
const db = openDb(config.db);
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
const voted = db.prepare(`
  SELECT id, title, vote, content, full_content FROM articles
  WHERE vote != 0 AND (full_content IS NOT NULL OR content IS NOT NULL)
`).all();
const { stripHtml } = await import('../src/html.js');
const { decompressText } = await import('../src/compress.js');
const { sampleText } = await import('../src/enrich.js');
const text = (r) => { const raw = decompressText(r.full_content) ?? decompressText(r.content) ?? ''; return `${r.title}\n${sampleText(stripHtml(raw), 4000)}`; };

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

const cos = (a, b) => { const n = Math.min(a.length, b.length); let s = 0; for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; };
// Native-dim vectors can carry |v| > Float16 max (65504): llm.embed's
// Float16Array.from silently turns those into ±Infinity, and Inf + -Inf in
// a dot product = NaN. Clamp and count, so the experiment survives and the
// overflow rate is visible.
let overflowCount = 0;
function f16safe(v) {
  const out = new Float16Array(v.length);
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(v[i])) { overflowCount++; out[i] = v[i] > 0 ? 65504 : -65504; }
    else out[i] = v[i];
  }
  return out;
}
async function embedSet(llm, items, dims, kind) {
  const vecs = new Map();
  for (const it of items) {
    vecs.set(it.id ?? it.key, f16safe(await llm.embed(it.text ?? it.input, kind, dims)));
  }
  return vecs;
}
function auc(pos, neg) {
  const all = [...pos.map((v) => ({ v, p: 1 })), ...neg.map((v) => ({ v, p: 0 }))].sort((a, b) => a.v - b.v);
  let rs = 0, i = 0;
  while (i < all.length) { let j = i; while (j < all.length && all[j].v === all[i].v) j++; const mid = (i + 1 + j) / 2; for (let k = i; k < j; k++) rs += all[k].p ? mid : 0; i = j; }
  return (rs - pos.length * (pos.length + 1) / 2) / (pos.length * neg.length);
}
const fprAt = (neg, t) => neg.filter((s) => s >= t).length / neg.length;
const recallAt = (pos, t) => pos.filter((s) => s >= t).length / pos.length;

// --- 1) truncation direction-damage probe (40 texts, native vs truncated)
const RUN = process.env.RUN ?? 'all';
console.log('== truncation damage: cos(native 1024, truncated), higher = truncation-safe');
if (RUN === 'all' || RUN === 'probe') {
const probe = voted.slice(0, 40).map((r) => ({ key: r.id, input: text(r) }));
for (const [model, dims] of [['qwen3-embedding:0.6b', 64], ['qwen3-embedding:0.6b', 512], ['leoipulsar/harrier-0.6b', 64], ['leoipulsar/harrier-0.6b', 512]]) {
  const llm = new Ollama({ ...config.ollama, embedModel: model });
  const nat = await embedSet(llm, probe, 1024, 'document');
  const trc = await embedSet(llm, probe, dims, 'document');
  const ds = probe.map((p) => cos(nat.get(p.key), trc.get(p.key))).sort((a, b) => a - b);
  console.log(`  ${model} @${dims}: p05 ${ds[2].toFixed(3)} p50 ${ds[20].toFixed(3)}`);
}
}

// --- 2) dedup at native dims
console.log('\n== dedup AUC / operating points');
if (RUN === 'all' || RUN === 'dedup') {
const posPairs = dupSample;
for (const [model, dims] of [
  ['qwen3-embedding:0.6b', 64],
  ['qwen3-embedding:0.6b', 1024],
  ['leoipulsar/harrier-0.6b', 64],
  ['leoipulsar/harrier-0.6b', 1024],
]) {
  const llm = new Ollama({ ...config.ollama, embedModel: model });
  const vecs = await embedSet(llm, arts.map((a) => ({ id: a.id, text: `${a.title}\n${a.summary}` })), dims, 'document');
  const pos = posPairs.map((p) => cos(vecs.get(p.dup_id), vecs.get(p.root_id)));
  const neg = negPairs.map((p) => cos(vecs.get(p[0]), vecs.get(p[1])));
  const a = auc(pos, neg);
  const baseFPR = fprAt(neg, 0.87);
  const sorted = [...neg].sort((x, y) => x - y);
  const tEq = sorted[Math.floor((1 - 0.0625) * (sorted.length - 1))];
  console.log(`  ${model} @${dims}: AUC ${a.toFixed(4)} | @0.87 recall ${(recallAt(pos, 0.87) * 100).toFixed(1)}% FPR ${(baseFPR * 100).toFixed(2)}% | FPR-matched(6.25%) t=${tEq.toFixed(3)} recall ${(recallAt(pos, tEq) * 100).toFixed(1)}%`);
  }
}

// --- 3) taste kNN at native dims
console.log('\n== taste kNN AUC (voted pairs)');
if (RUN === 'all' || RUN === 'knn') {
  const votedInputs = voted.map((r) => ({ id: r.id, vote: r.vote, text: text(r) }));
  for (const [model, dims] of [
    ['qwen3-embedding:0.6b', 1024],
    ['leoipulsar/harrier-0.6b', 1024],
  ]) {
  const llm = new Ollama({ ...config.ollama, embedModel: model });
  const vecs = await embedSet(llm, votedInputs, dims, 'document');
  const same = [], opp = [];
  for (let i = 0; i < votedInputs.length; i++) {
    for (let j = i + 1; j < votedInputs.length; j++) {
      const s = cos(vecs.get(votedInputs[i].id), vecs.get(votedInputs[j].id));
      (votedInputs[i].vote * votedInputs[j].vote > 0 ? same : opp).push(s);
    }
  }
  console.log(`  ${model} @${dims}: AUC ${auc(same, opp).toFixed(4)} (float16 overflows clamped: ${overflowCount})`);
  overflowCount = 0;
}
}
db.close();
