// Compare dimensionalities on fixed, recorded pair sets. Prefix-energy and
// prefix-direction diagnostics do not prove MRL training or task quality.
// Dedup metrics use automatic link proxies; vote-sign pair clustering is
// not a temporal preference/ranking evaluation. RUN=knn remains an alias
// for that historical diagnostic, not a claim that this runs the ranker.
import { selectDedupPairs, writePairManifest, requireDedupPairs, prefixDiagnostics } from './bench-utils.js';
import { dirname } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openReadOnlyDb } from '../src/db.js';
import { Ollama } from '../src/llm.js';

const config = loadConfig();
const db = openReadOnlyDb(config.db);
const dedupSample = selectDedupPairs(db);
const { positives: dupSample, negatives: negPairs, articles: arts } = dedupSample;
const RUN = process.env.RUN ?? 'all';
if (RUN === 'all' || RUN === 'dedup') requireDedupPairs(dedupSample);
console.log(`Pair manifest: ${writePairManifest(dirname(config.db), dedupSample)}`);
console.log('Dedup labels are stored links versus cross-group candidate negatives, not independent human judgments.');
const voted = db.prepare(`
  SELECT id, title, vote, content, full_content FROM articles
  WHERE vote != 0 AND (full_content IS NOT NULL OR content IS NOT NULL)
`).all();
const { stripHtml } = await import('../src/html.js');
const { decompressText } = await import('../src/compress.js');
const { sampleText } = await import('../src/enrich.js');
const text = (r) => { const raw = decompressText(r.full_content) ?? decompressText(r.content) ?? ''; return `${r.title}\n${sampleText(stripHtml(raw), 4000)}`; };


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

// --- 1) geometric prefix diagnostics (up to 40 texts)
console.log('== prefix geometry: retained energy and prefix direction agreement (not task quality or MRL evidence)');
if (RUN === 'all' || RUN === 'probe') {
const probe = voted.slice(0, 40).map((r) => ({ key: r.id, input: text(r) }));
for (const [model, dims] of [['qwen3-embedding:0.6b', 64], ['qwen3-embedding:0.6b', 512], ['leoipulsar/harrier-0.6b', 64], ['leoipulsar/harrier-0.6b', 512]]) {
  const llm = new Ollama({ ...config.ollama, embedModel: model });
  const nat = await embedSet(llm, probe, 1024, 'document');
  const trc = await embedSet(llm, probe, dims, 'document');
  const diagnostics = probe.map((p) => prefixDiagnostics(nat.get(p.key), trc.get(p.key)));
  const median = (key) => diagnostics.map((d) => d[key]).sort((a, b) => a - b)[Math.floor(diagnostics.length / 2)];
  if (!diagnostics.length) throw new Error('prefix probe needs at least one voted article with text');
  console.log(`  ${model} @${dims}: retained-energy p50 ${median('retainedEnergy').toFixed(3)}, prefix-cosine p50 ${median('prefixCosine').toFixed(3)}, padded-cosine p50 ${median('paddedCosine').toFixed(3)}`);
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

// --- 3) vote-sign pair clustering at native dims; not a ranker replay
console.log('\n== vote-sign pair clustering AUC (not preference-ranker accuracy)');
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
