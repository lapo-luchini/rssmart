#!/usr/bin/env node
// Experiment: does recovering <img alt> text (stripHtml's [image: ...]
// markers) improve dedup separation on image-only posts (webcomics)?
//
// For same-feed image-only article pairs (the class harrier's dedup
// falsely flagged, and where qwen3's spread on near-empty texts was the
// only thing keeping them under threshold), regenerate the summary with
// the exact production prompt and the real chat model, then compare
// dedup-space distances:
//   old = title + stored summary      (pre-alt-recovery input)
//   new = title + regenerated summary (post-alt-recovery input)
// for both candidate dedup models. Rich-text same-feed pairs are controls:
// their summaries shouldn't move much.
//
// Read-only against the DB (re-classification happens in memory, nothing
// is persisted). Writes data/bench-comic-alt-<ts>.txt.
//
// Usage: node scripts/bench-comic-alt.js [pairs]

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { decompressText } from '../src/compress.js';
import { stripHtml, sanitizeHtml } from '../src/html.js';
import { sampleText, classifyPrompt, contextTokens, existingTopicNames, SYSTEM } from '../src/enrich.js';
import { Ollama } from '../src/llm.js';

const PAIRS = Number(process.argv[2] ?? 30);
const config = loadConfig();
const db = openDb(config.db);
let rngState = 99;
const rand = () => (rngState = (rngState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

// Candidate image-only posts: compressed content blobs under 900 bytes are
// near-certainly tiny entries; the real filter is the extracted-text check
// below (with the NEW stripHtml, image posts contain [image markers).
const rows = db.prepare(`
  SELECT id, feed_id, title, summary, published_at, content, full_content FROM articles
  WHERE status = 'enriched' AND summary IS NOT NULL AND published_at IS NOT NULL
    AND LENGTH(COALESCE(full_content, content)) < 900
`).all();
const richPosts = db.prepare(`
  SELECT id, feed_id, title, summary, published_at, content, full_content FROM articles
  WHERE status = 'enriched' AND summary IS NOT NULL AND published_at IS NOT NULL
    AND LENGTH(COALESCE(full_content, content)) > 3000
`).all();

const textOf = (r) => stripHtml(sanitizeHtml(decompressText(r.full_content) ?? decompressText(r.content) ?? ''));
const DAY = 86400000;
const imagePosts = rows.filter((r) => textOf(r).includes('[image'));

function pairUp(pool, n, imageOnly) {
  const byFeed = new Map();
  for (const r of pool) {
    if (!byFeed.has(r.feed_id)) byFeed.set(r.feed_id, []);
    byFeed.get(r.feed_id).push(r);
  }
  const feeds = [...byFeed.entries()].filter(([, v]) => v.length >= 2).map(([k]) => k);
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < 5000 && feeds.length) {
    const feed = feeds[Math.floor(rand() * feeds.length)];
    const items = byFeed.get(feed);
    const a = items[Math.floor(rand() * items.length)];
    const b = items[Math.floor(rand() * items.length)];
    if (!a || !b || a.id === b.id) continue;
    if (Math.abs(new Date(a.published_at) - new Date(b.published_at)) > 14 * DAY) continue;
    if (imageOnly && (!textOf(a).includes('[image') || !textOf(b).includes('[image'))) continue;
    out.push([a.id, b.id]);
  }
  return out;
}

const comicPairs = pairUp(imagePosts, PAIRS, true);
const controlPairs = pairUp(richPosts, Math.max(8, Math.round(PAIRS / 3)), false);
const involved = [...new Set([...comicPairs, ...controlPairs].flat())];
const byId = new Map([...rows, ...richPosts].filter((r) => involved.includes(r.id)).map((r) => [r.id, r]));
console.log(`image-only pairs: ${comicPairs.length} (${new Set(comicPairs.flat()).size} articles), rich control pairs: ${controlPairs.length}`);

// ---- regenerate summaries with the production prompt ----
const llm = new Ollama(config.ollama);
const topics = existingTopicNames(db, config.enrich.maxSuggestedTopics);
const guidelines = db.prepare("SELECT value FROM meta WHERE key = 'guidelines'").get()?.value;

const newSummaries = new Map();
let done = 0;
for (const id of involved) {
  const r = byId.get(id);
  const text = textOf(r);
  const prompt = classifyPrompt(topics, r.title, text, config.enrich.maxInputChars, { guidelines });
  const contentChars = Math.min(text.length, config.enrich.maxInputChars);
  const worstCase = SYSTEM.length + prompt.length + (config.enrich.maxInputChars - contentChars);
  try {
    const out = await llm.chatJSON(SYSTEM, prompt, { numCtx: contextTokens(worstCase) });
    newSummaries.set(id, String(out?.summary ?? '').trim() || null);
  } catch (err) {
    newSummaries.set(id, null);
    console.log(`  #${id} chat failed: ${err.message.slice(0, 80)}`);
  }
  if (++done % 10 === 0) console.log(`  re-classified ${done}/${involved.length}`);
}
const okCount = involved.filter((id) => newSummaries.get(id)).length;
console.log(`re-classified ${okCount}/${involved.length} successfully`);

// ---- embed old vs new summaries in both candidate dedup spaces ----
const cos = (a, b) => { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; };
async function embedMap(model, dims, items) {
  const llm2 = new Ollama({ ...config.ollama, embedModel: model });
  const vecs = new Map();
  for (const it of items) vecs.set(it.key, await llm2.embed(it.text, 'document', dims));
  return vecs;
}

const dedupDims = config.ollama.dedupEmbedDimensions ?? 64;
const models = [
  { name: 'qwen3-embedding:0.6b', dims: dedupDims },
  { name: 'leoipulsar/harrier-0.6b', dims: dedupDims },
];

const results = {};
for (const m of models) {
  const oldV = await embedMap(m.name, m.dims, involved.map((id) => ({ key: id, text: `${byId.get(id).title}\n${byId.get(id).summary}` })));
  const newV = await embedMap(m.name, m.dims, involved.filter((id) => newSummaries.get(id)).map((id) => ({ key: id, text: `${byId.get(id).title}\n${newSummaries.get(id)}` })));
  const sim = (vecs, pair) => (vecs.has(pair[0]) && vecs.has(pair[1]) ? cos(vecs.get(pair[0]), vecs.get(pair[1])) : null);
  results[m.name] = {
    comic: { old: comicPairs.map((p) => sim(oldV, p)), new: comicPairs.map((p) => sim(newV, p)) },
    control: { old: controlPairs.map((p) => sim(oldV, p)), new: controlPairs.map((p) => sim(newV, p)) },
  };
}

// ---- report ----
const lines = [];
lines.push(`comic alt-recovery dedup experiment -- ${new Date().toISOString()}`);
lines.push(`threshold: ${config.enrich.dupThreshold}; pairs: ${comicPairs.length} image-only, ${controlPairs.length} rich control; ${okCount}/${involved.length} re-classified`);
const q = (arr, x) => { const v = arr.filter((x2) => x2 != null).sort((a, b) => a - b); return v[Math.floor(x * (v.length - 1))]; };
const over = (arr, t) => `${arr.filter((v) => v != null && v >= t).length}/${arr.filter((v) => v != null).length}`;
for (const m of models) {
  const r = results[m.name];
  for (const kind of ['comic', 'control']) {
    const { old: o, new: n } = r[kind];
    lines.push(`${m.name} [${kind}]`);
    lines.push(`  old: p10 ${q(o, 0.1)?.toFixed(3)} p50 ${q(o, 0.5)?.toFixed(3)} | >= threshold: ${over(o, 0.87)}`);
    lines.push(`  new: p10 ${q(n, 0.1)?.toFixed(3)} p50 ${q(n, 0.5)?.toFixed(3)} | >= threshold: ${over(n, 0.87)}`);
  }
}
lines.push('');
lines.push('== per-pair detail (image-only pairs), old -> new');
const qV = results['qwen3-embedding:0.6b'];
const hV = results['leoipulsar/harrier-0.6b'];
const fmt = (v) => (v != null ? v.toFixed(3) : 'n/a');
comicPairs.forEach((p, i) => {
  const [a, b] = p;
  lines.push(`#${a} <-> #${b}  qwen ${fmt(qV.comic.old[i])}->${fmt(qV.comic.new[i])}  harrier ${fmt(hV.comic.old[i])}->${fmt(hV.comic.new[i])}`);
  lines.push(`   a: "${byId.get(a).title.slice(0, 70)}"`);
  lines.push(`      old sum: ${(byId.get(a).summary ?? '').slice(0, 80)}`);
  lines.push(`      new sum: ${(newSummaries.get(a) ?? '').slice(0, 80)}`);
  lines.push(`   b: "${byId.get(b).title.slice(0, 70)}"`);
  lines.push(`      old sum: ${(byId.get(b).summary ?? '').slice(0, 80)}`);
  lines.push(`      new sum: ${(newSummaries.get(b) ?? '').slice(0, 80)}`);
});

const outPath = join(dirname(config.db), `bench-comic-alt-${Date.now()}.txt`);
writeFileSync(outPath, lines.join('\n') + '\n');
console.log('\n' + lines.slice(0, 13).join('\n'));
console.log(`\nWrote ${outPath}`);
db.close();
