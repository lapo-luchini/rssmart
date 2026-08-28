// harrier@128 vs qwen3@64: matched-FPR recall comparison on the same pair sets.
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
