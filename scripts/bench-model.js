#!/usr/bin/env node
// Benchmarks one or more Ollama chat models for rssmart's classification
// use case: speed and generated output on a fixed spread of real,
// already-classified articles from the DB. Uses the exact production
// prompt (src/enrich.js's classifyPrompt/SYSTEM/contextTokens) so results
// reflect how a candidate model would actually behave here, not a
// synthetic stand-in prompt that could quietly drift from the real one.
// Read-only: never writes to the database, never changes any article's
// stored classification.
//
// Usage: node scripts/bench-model.js <model> [model2 model3 ...]
// (config resolved the same way as bin/rssmart.js: $RSSMART_CONFIG or
// ./config.yaml -- only ollama.url/timeoutMs/apiKey are used from it, not
// ollama.chatModel, which this script overrides per model under test)
//
// Writes data/bench-model-<timestamp>.txt: average wall time per model
// first (the number that matters for "is this worth switching to"), then
// every model's full generated output per article underneath, for a
// human to actually read through and judge quality.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { decompressText } from '../src/compress.js';
import { stripHtml } from '../src/html.js';
import { existingTopicNames, classifyPrompt, contextTokens, SYSTEM } from '../src/enrich.js';
import { Ollama } from '../src/llm.js';

const SAMPLE_SIZE = 5;

const models = process.argv.slice(2);
if (models.length === 0) {
  console.error('Usage: node scripts/bench-model.js <model> [model2 model3 ...]');
  process.exit(2);
}

const config = loadConfig();
const db = openDb(config.db);

function articleText(row) {
  const raw = decompressText(row.full_content) ?? decompressText(row.content) ?? '';
  return stripHtml(raw);
}

/**
 * "Well-chosen" here means spread across content length: it's the single
 * strongest lever on both the prompt's actual context size and the
 * model's depth judgment (a thin blurb and a 40k-char essay are a much
 * more informative pair than five similar-length articles). Picked by
 * percentile across everything already classified, so the sample adapts
 * as the archive grows instead of pinning specific article ids that
 * could eventually get pruned or bundled away as duplicates.
 */
function pickSampleArticles(n) {
  const rows = db.prepare(`
    SELECT id, title, content, full_content FROM articles
    WHERE status = 'enriched' AND (full_content IS NOT NULL OR content IS NOT NULL)
  `).all();
  const withLen = rows
    .map((r) => ({ ...r, textLen: articleText(r).length }))
    .filter((r) => r.textLen > 200) // skip near-empty posts, not a representative case
    .sort((a, b) => a.textLen - b.textLen);
  if (withLen.length === 0) throw new Error('no enriched articles with usable text found to benchmark against');

  const picked = [];
  const seen = new Set();
  for (let i = 0; i < n && picked.length < withLen.length; i++) {
    const idx = Math.min(
      withLen.length - 1,
      Math.round((i / Math.max(n - 1, 1)) * (withLen.length - 1)),
    );
    if (!seen.has(withLen[idx].id)) {
      seen.add(withLen[idx].id);
      picked.push(withLen[idx]);
    }
  }
  return picked;
}

const articles = pickSampleArticles(SAMPLE_SIZE);
const existingTopics = existingTopicNames(db, config.enrich.maxSuggestedTopics);
const guidelines = db.prepare("SELECT value FROM meta WHERE key = 'guidelines'").get()?.value;

const results = {};
for (const model of models) {
  const llm = new Ollama({ ...config.ollama, chatModel: model });
  results[model] = [];
  for (const a of articles) {
    const text = articleText(a);
    const prompt = classifyPrompt(existingTopics, a.title, text, config.enrich.maxInputChars, { guidelines });
    // Same sizing enrichOne uses: worst-case for maxInputChars, not this
    // particular article's actual (usually shorter) length -- changing
    // num_ctx between requests makes Ollama reload the model.
    const contentChars = Math.min(text.length, config.enrich.maxInputChars);
    const worstCaseChars = SYSTEM.length + prompt.length + (config.enrich.maxInputChars - contentChars);

    const t0 = performance.now();
    let out = null;
    let error = null;
    try {
      out = await llm.chatJSON(SYSTEM, prompt, { numCtx: contextTokens(worstCaseChars) });
    } catch (err) {
      error = err.message;
    }
    const ms = performance.now() - t0;
    results[model].push({ id: a.id, ms, out, error });
    console.log(`[${model}] #${a.id} (${text.length} chars) ${ms.toFixed(0)}ms${error ? ` ERROR: ${error}` : ''}`);
  }
}

const lines = [];
lines.push(`rssmart model benchmark -- ${new Date().toISOString()}`);
lines.push(`Sample: ${articles.length} articles, ids [${articles.map((a) => a.id).join(', ')}]`);
lines.push('');
lines.push('Average wall time per classification call (the number that matters for speed):');
for (const model of models) {
  const times = results[model].map((r) => r.ms);
  const avg = times.reduce((s, x) => s + x, 0) / times.length;
  const errors = results[model].filter((r) => r.error).length;
  lines.push(
    `  ${model}: avg ${avg.toFixed(0)}ms, min ${Math.min(...times).toFixed(0)}ms, max ${Math.max(...times).toFixed(0)}ms` +
      (errors ? `, ${errors} error(s)` : ''),
  );
}
lines.push('');
lines.push('='.repeat(70));
lines.push('Per-article generated output (for manual quality review)');
lines.push('='.repeat(70));
for (const a of articles) {
  lines.push('');
  lines.push(`#${a.id} "${a.title}" (${articleText(a).length} chars)`);
  for (const model of models) {
    const r = results[model].find((x) => x.id === a.id);
    lines.push(`  [${model}] ${r.ms.toFixed(0)}ms`);
    if (r.error) {
      lines.push(`    ERROR: ${r.error}`);
    } else {
      lines.push(`    topics: ${JSON.stringify(r.out.topics)}`);
      lines.push(`    depth: ${r.out.depth}`);
      lines.push(`    summary: ${r.out.summary}`);
    }
  }
}

const outPath = join(dirname(config.db), `bench-model-${Date.now()}.txt`);
writeFileSync(outPath, lines.join('\n') + '\n');
console.log(`\nWrote ${outPath}`);

db.close();
