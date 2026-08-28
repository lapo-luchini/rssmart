#!/usr/bin/env node
// Benchmarks Ollama embedding models for rssmart's three embedding jobs:
// duplicate detection (title+summary, 64 dims), taste kNN over text
// embeddings (title+text, 512 dims), and semantic search (query-side
// instruct prefix). Uses the exact production inputs (same string
// construction, same prefixes, same Matryoshka truncation) on a real
// article subset from the DB, so numbers reflect how a candidate model
// would actually behave here.
//
// Read-only: never writes to the database.
//
// Usage: node scripts/bench-embed.js <model> [model2 ...]
//   The first model listed is treated as the incumbent baseline for
//   threshold-equivalence comparisons. Config resolves like bin/rssmart.js
//   ($RSSMART_CONFIG or ./config.yaml).
//
// Quality is evaluated against ground truth that exists in the DB:
//   - duplicate_of links (3.5k+ pairs) vs same-feed recent non-duplicate
//     pairs -> ROC AUC + false/true rates at the configured dupThreshold,
//     plus the threshold at which the candidate matches the baseline's
//     false-positive rate.
//   - votes: pairwise same-sign vs opposite-sign cosine among all voted
//     articles -> AUC (does the embedding cluster taste-coherent content).
//   - search: fixed EN/IT queries, top-10 agreement between models and
//     titles printed for manual review.
//
// Writes data/bench-embed-<timestamp>.txt with the full report.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { decompressText } from '../src/compress.js';
import { stripHtml } from '../src/html.js';
import { sampleText } from '../src/enrich.js';

const TEXT_SAMPLE = Number(process.env.BENCH_TEXT_SAMPLE ?? 400); // non-voted text-embedding articles
const DUP_PAIRS = Number(process.env.BENCH_DUP_PAIRS ?? 800); // labeled duplicate pairs
const NEG_PAIRS = Number(process.env.BENCH_NEG_PAIRS ?? 800); // same-feed non-duplicate pairs
const SEARCH_QUERIES = [
  'ssl tls certificate vulnerabilities',
  'come configurare un server casalingo con raspberry pi',
  'rust vs go performance web backend',
  'privacy browser fingerprinting protection',
  'intelligenza artificiale locale llm su mac',
  'docker kubernetes container orchestration tips',
];

const models = process.argv.slice(2);
if (models.length === 0) {
  console.error('Usage: node scripts/bench-embed.js <model> [model2 ...] (first = incumbent baseline)');
  process.exit(2);
}

const config = loadConfig();
const db = openDb(config.db);

function articleText(row) {
  const raw = decompressText(row.full_content) ?? decompressText(row.content) ?? '';
  return stripHtml(raw);
}

// Deterministic PRNG so re-runs compare the exact same subset.
let rngState = 42;
const rand = () => (rngState = (rngState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
function sample(arr, n) {
  const copy = [...arr];
  const out = [];
  while (out.length < n && copy.length > 0) out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
  return out;
}

// ---- subset selection -----------------------------------------------------

const voted = db.prepare(`
  SELECT id, title, vote, content, full_content FROM articles
  WHERE vote != 0 AND (full_content IS NOT NULL OR content IS NOT NULL)
`).all();
const textPool = db.prepare(`
  SELECT id, title, content, full_content FROM articles
  WHERE status = 'enriched' AND (full_content IS NOT NULL OR content IS NOT NULL)
    AND vote = 0
  ORDER BY id
`).all();
// Stratify non-voted picks by text length, like bench-model.js does.
const withLen = textPool
  .map((r) => ({ ...r, textLen: articleText(r).length }))
  .filter((r) => r.textLen > 200)
  .sort((a, b) => a.textLen - b.textLen);
const textArticles = [...voted.map((v) => ({ ...v, isVoted: true }))];
for (let i = 0; i < TEXT_SAMPLE && withLen.length > 0; i++) {
  const idx = Math.min(withLen.length - 1, Math.round((i / Math.max(TEXT_SAMPLE - 1, 1)) * (withLen.length - 1)));
  textArticles.push({ ...withLen[idx], isVoted: false });
}

const dupPairs = db.prepare(`
  SELECT a.id AS dup_id, a.duplicate_of AS root_id FROM articles a
  WHERE a.duplicate_of IS NOT NULL
`).all();
const dupSample = sample(dupPairs, DUP_PAIRS);
const dupIds = [...new Set(dupSample.flatMap((p) => [p.dup_id, p.root_id]))];
const dupArticles = db.prepare(`
  SELECT id, feed_id, title, summary, published_at FROM articles WHERE id IN (${dupIds.map(() => '?').join(',')})
`).all(...dupIds);
const byId = new Map(dupArticles.map((a) => [a.id, a]));

// Same-feed pairs published within the dedup window (14d) that are NOT in
// the same duplicate group — the realistic hard negatives dedup must reject.
const DAY = 86400000;
const negPairs = [];
const pool = [...dupArticles];
let guard = 0;
while (negPairs.length < NEG_PAIRS && guard++ < 20000) {
  const a = pick(pool);
  const candidates = pool.filter((b) =>
    b.id !== a.id && b.feed_id === a.feed_id &&
    a.published_at && b.published_at &&
    Math.abs(new Date(a.published_at) - new Date(b.published_at)) <= 14 * DAY &&
    (a.duplicate_of ?? a.id) !== (b.duplicate_of ?? b.id) && b.duplicate_of !== a.id && a.duplicate_of !== b.id,
  );
  if (candidates.length > 0) negPairs.push([a.id, pick(candidates).id]);
}

console.log(`Subset: ${textArticles.length} text-embedding articles (${voted.length} voted + ${textArticles.length - voted.length} stratified), ${dupSample.length} duplicate pairs, ${negPairs.length} same-feed negative pairs, ${SEARCH_QUERIES.length} search queries`);

// ---- embedding ------------------------------------------------------------

const textInputs = textArticles.map((a) => ({
  id: a.id,
  isVoted: a.isVoted,
  vote: a.vote,
  text: `${a.title}\n${sampleText(articleText(a), 4000)}`,
}));
const summaryInputs = [...new Set([...dupSample.flatMap((p) => [p.dup_id, p.root_id]), ...negPairs.flat()])]
  .map((id) => byId.get(id))
  .filter((a) => a?.summary != null)
  .map((a) => ({ id: a.id, text: `${a.title}\n${a.summary}` }));

async function embedAll(llm, inputs, dims, kind) {
  const t0 = performance.now();
  const vecs = new Map();
  let chars = 0;
  const latencies = [];
  for (const item of inputs) {
    const t1 = performance.now();
    vecs.set(item.id, await llm.embed(item.text, kind, dims));
    const ms = performance.now() - t1;
    latencies.push(ms);
    chars += item.text.length;
    if (vecs.size % 250 === 0) {
      const done = (performance.now() - t0) / 1000;
      console.log(`    ${vecs.size}/${inputs.length} (${done.toFixed(0)}s)`);
    }
  }
  const totalMs = performance.now() - t0;
  return {
    vecs,
    totalMs,
    msPerItem: totalMs / inputs.length,
    p50: latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)],
    charsPerSec: chars / (totalMs / 1000),
  };
}

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
const pairSim = (vecs, [x, y]) => cosine(vecs.get(x), vecs.get(y));

function auc(pos, neg) {
  // Rank-based (Mann-Whitney) AUC; ties count half.
  const all = [...pos.map((v) => ({ v, pos: true })), ...neg.map((v) => ({ v, pos: false }))]
    .sort((a, b) => a.v - b.v);
  let rankSumPos = 0;
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j < all.length && all[j].v === all[i].v) j++;
    const avgRank = (i + 1 + j) / 2; // 1-based mid-rank of the tie group
    for (let k = i; k < j; k++) if (all[k].pos) rankSumPos += avgRank;
    i = j;
  }
  return (rankSumPos - pos.length * (pos.length + 1) / 2) / (pos.length * neg.length);
}
const quantile = (arr, q) => [...arr].sort((a, b) => a - b)[Math.floor(q * (arr.length - 1))];

// ---- per-model evaluation ---------------------------------------------------

const results = {};
for (const model of models) {
  console.log(`\n=== ${model}`);
  const llm = new (await import('../src/llm.js')).Ollama({ ...config.ollama, embedModel: model });
  const r = {};

  console.log(`  embedding ${textInputs.length} texts (512 dims)...`);
  r.text = await embedAll(llm, textInputs, config.ollama.embedDimensions ?? 512, 'document');
  console.log(`  embedding ${summaryInputs.length} summaries (64 dims)...`);
  r.summary = await embedAll(llm, summaryInputs, config.ollama.dedupEmbedDimensions ?? 64, 'document');

  // Norm sanity on truncated vectors (dot product = cosine assumes norm 1).
  const norms = [...r.text.vecs.values()].slice(200).map((v) => Math.sqrt(cosine(v, v)));
  r.normRange = [Math.min(...norms), Math.max(...norms)];

  // Dedup: positives vs same-feed hard negatives.
  const posSims = dupSample
    .filter((p) => r.summary.vecs.has(p.dup_id) && r.summary.vecs.has(p.root_id))
    .map((p) => pairSim(r.summary.vecs, [p.dup_id, p.root_id]));
  const negSims = negPairs
    .filter((p) => r.summary.vecs.has(p[0]) && r.summary.vecs.has(p[1]))
    .map((p) => pairSim(r.summary.vecs, p));
  r.dedup = {
    posSims, negSims,
    auc: auc(posSims, negSims),
    posAtThreshold: posSims.filter((s) => s >= config.enrich.dupThreshold).length / posSims.length,
    negAtThreshold: negSims.filter((s) => s >= config.enrich.dupThreshold).length / negSims.length,
    p50pos: quantile(posSims, 0.5), p05pos: quantile(posSims, 0.05),
    p50neg: quantile(negSims, 0.5), p95neg: quantile(negSims, 0.95),
  };

  // Taste kNN: same-sign vs opposite-sign voted pairs (text embeddings).
  const votedIdx = textInputs.filter((t) => t.isVoted && r.text.vecs.has(t.id));
  const sameSign = [];
  const oppositeSign = [];
  for (let i = 0; i < votedIdx.length; i++) {
    for (let j = i + 1; j < votedIdx.length; j++) {
      const s = cosine(r.text.vecs.get(votedIdx[i].id), r.text.vecs.get(votedIdx[j].id));
      if (votedIdx[i].vote * votedIdx[j].vote > 0) sameSign.push(s);
      else oppositeSign.push(s);
    }
  }
  r.knn = { auc: auc(sameSign, oppositeSign), sameP50: quantile(sameSign, 0.5), oppP50: quantile(oppositeSign, 0.5), pairs: sameSign.length + oppositeSign.length };

  // Search: query-side prefix as configured, top-10 overlap vs baseline later.
  r.search = [];
  for (const q of SEARCH_QUERIES) {
    const qv = await llm.embed(q, 'query', config.ollama.embedDimensions ?? 512);
    const scored = [...r.text.vecs.entries()]
      .map(([id, v]) => ({ id, sim: cosine(qv, v) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 10);
    r.search.push({ query: q, top10: scored });
  }

  results[model] = r;
}

// ---- report -----------------------------------------------------------------

const baseline = models[0];
const lines = [];
lines.push(`rssmart embedding benchmark -- ${new Date().toISOString()}`);
lines.push(`Subset: ${textInputs.length} text articles, ${dupSample.length} dup pairs, ${negPairs.length} hard negatives, ${SEARCH_QUERIES.length} queries`);
lines.push(`dupThreshold (config): ${config.enrich.dupThreshold}`);
lines.push('');

for (const model of models) {
  const r = results[model];
  lines.push(`== ${model}`);
  lines.push(`  speed text (${r.text.vecs.size}x): ${r.text.msPerItem.toFixed(0)}ms avg, ${r.text.p50.toFixed(0)}ms p50, ${Math.round(r.text.charsPerSec).toLocaleString()} chars/s`);
  lines.push(`  speed summary (${r.summary.vecs.size}x): ${r.summary.msPerItem.toFixed(0)}ms avg, ${r.summary.p50.toFixed(0)}ms p50`);
  lines.push(`  full re-embed projection (25,980 texts): ${(r.text.msPerItem * 25980 / 60000).toFixed(0)} min`);
  lines.push(`  norm range (truncated, sample): ${r.normRange[0].toFixed(4)} - ${r.normRange[1].toFixed(4)}`);
  lines.push(`  dedup: AUC ${r.dedup.auc.toFixed(4)}, dup-pairs >= threshold ${(r.dedup.posAtThreshold * 100).toFixed(1)}%, false-pos rate ${(r.dedup.negAtThreshold * 100).toFixed(2)}%`);
  lines.push(`         sim p05/p50 pos: ${r.dedup.p05pos.toFixed(3)}/${r.dedup.p50pos.toFixed(3)}, p50/p95 neg: ${r.dedup.p50neg.toFixed(3)}/${r.dedup.p95neg.toFixed(3)}`);
  lines.push(`  taste kNN (voted pairs): AUC ${r.knn.auc.toFixed(4)} (same-sign p50 ${r.knn.sameP50.toFixed(3)} vs opposite p50 ${r.knn.oppP50.toFixed(3)}, ${r.knn.pairs} pairs)`);
  lines.push('');
}

// Threshold equivalence: candidate threshold matching the baseline's FPR.
const base = results[baseline];
for (const model of models.slice(1)) {
  const r = results[model];
  const fpr = base.dedup.negAtThreshold;
  const sortedNeg = [...r.dedup.negSims].sort((a, b) => a - b);
  const equiv = sortedNeg[Math.floor((1 - fpr) * (sortedNeg.length - 1))];
  const recall = r.dedup.posSims.filter((s) => s >= equiv).length / r.dedup.posSims.length;
  const baseRecall = base.dedup.posAtThreshold;
  lines.push(`== threshold equivalence for ${model}`);
  lines.push(`  ${baseline} @ ${config.enrich.dupThreshold}: recall ${(baseRecall * 100).toFixed(1)}%, FPR ${(fpr * 100).toFixed(2)}%`);
  lines.push(`  ${model} matching that FPR at threshold ~${equiv.toFixed(3)}: recall ${(recall * 100).toFixed(1)}%`);
  lines.push('');
}

// Search top-10 overlap between models + titles for eyeballing.
const titles = new Map(textInputs.map((t) => [t.id, t.text.split('\n')[0]]));
for (let qi = 0; qi < SEARCH_QUERIES.length; qi++) {
  const sets = models.map((m) => new Set(results[m].search[qi].top10.map((s) => s.id)));
  const overlap = sets[1] ? [...sets[0]].filter((id) => sets[1].has(id)).length : null;
  lines.push(`== query: "${SEARCH_QUERIES[qi]}"${overlap != null ? ` (top-10 overlap with ${baseline}: ${overlap}/10)` : ''}`);
  for (const model of models) {
    lines.push(`  [${model}]`);
    for (const s of results[model].search[qi].top10.slice(0, 5)) lines.push(`    ${s.sim.toFixed(3)}  #${s.id}  ${titles.get(s.id)?.slice(0, 80)}`);
  }
  lines.push('');
}

mkdirSync(dirname(config.db), { recursive: true });
const outPath = join(dirname(config.db), `bench-embed-${Date.now()}.txt`);
writeFileSync(outPath, lines.join('\n') + '\n');
console.log('\n' + lines.join('\n'));
console.log(`\nWrote ${outPath}`);

db.close();
