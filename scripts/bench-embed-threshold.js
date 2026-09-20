// harrier@128 vs qwen3@64: matched-FPR recall comparison on the same pair sets.
import { selectDedupPairs, writePairManifest, requireDedupPairs } from './bench-utils.js';
import { dirname } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openReadOnlyDb } from '../src/db.js';
import { Ollama } from '../src/llm.js';

const config = loadConfig();
const db = openReadOnlyDb(config.db);
const dedupSample = selectDedupPairs(db);
const { positives: dupSample, negatives: negPairs, articles: arts } = dedupSample;
requireDedupPairs(dedupSample);
console.log(`Pair manifest: ${writePairManifest(dirname(config.db), dedupSample)}`);
console.log('Dedup labels are stored links versus cross-group candidate negatives, not independent human judgments.');

const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

async function run(model, dims) {
  const llm = new Ollama({ ...config.ollama, embedModel: model });
  const vecs = new Map();
  for (const a of arts) vecs.set(a.id, await llm.embed(`${a.title}\n${a.summary}`, 'document', dims));
  const pos = dupSample.map((p) => cos(vecs.get(p.dup_id), vecs.get(p.root_id)));
  const neg = negPairs.map((p) => cos(vecs.get(p[0]), vecs.get(p[1])));
  return { pos, neg };
}
const qwen = await run('qwen3-embedding:0.6b', 64);
const harrier = await run('leoipulsar/harrier-0.6b', 128);
const fprAt = (neg, t) => neg.filter((s) => s >= t).length / neg.length;
const recallAt = (pos, t) => pos.filter((s) => s >= t).length / pos.length;
// Baseline operating point, then candidate threshold with equal FPR.
const baseFPR = fprAt(qwen.neg, 0.87);
const sortedNeg = [...harrier.neg].sort((a, b) => a - b);
const tEquiv = sortedNeg[Math.floor((1 - baseFPR) * (sortedNeg.length - 1))];
console.log(`qwen3@64    @0.87: recall ${(recallAt(qwen.pos, 0.87) * 100).toFixed(1)}%  FPR ${(baseFPR * 100).toFixed(2)}%`);
console.log(`harrier@128 @0.87: recall ${(recallAt(harrier.pos, 0.87) * 100).toFixed(1)}%  FPR ${(fprAt(harrier.neg, 0.87) * 100).toFixed(2)}%`);
console.log(`harrier@128 @${tEquiv.toFixed(3)} (FPR-matched): recall ${(recallAt(harrier.pos, tEquiv) * 100).toFixed(1)}%`);
for (const t of [0.90, 0.92, 0.94, 0.96]) {
  console.log(`harrier@128 @${t}: recall ${(recallAt(harrier.pos, t) * 100).toFixed(1)}%  FPR ${(fprAt(harrier.neg, t) * 100).toFixed(2)}%`);
}
db.close();
