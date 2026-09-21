#!/usr/bin/env node
// Experimental local kernel scoring; readonly, no model calls, no stored scores.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openReadOnlyDb } from '../src/db.js';
import { KERNEL_DEFAULTS, KERNEL_NORM_SQUARED_TOLERANCE, kernelParameters, scoreKernel } from '../src/kernelScore.js';

const HELP = `Usage: node scripts/score-kernel-shadow.js [options]
Experimental signed vote signal, not a probability or a production ranking.
Reads RSSMART_CONFIG / config.yaml unless --config is supplied. Never writes.

  --config FILE       Full rssmart config; only DB/text embedding space is used
  --limit N           Latest N unvoted articles with text embeddings (default 100)
  --all               All unvoted articles with text embeddings (can be expensive)
  --candidate-id ID   Explicit unvoted ID; repeatable, cannot combine with limit/all
  --now TIME          Unix seconds or ISO timestamp; default current time, recorded
  --tau NUMBER        Similarity threshold, default 0.2, range [-1,1)
  --k INTEGER         Pooled top-k before decay, default 15, may be zero
  --exponent NUMBER   Positive kernel exponent, default 1
  --lambda NUMBER     Positive zero-prior mass, default 1
  --half-life YEARS   Vote decay half-life, default 1.5; 0 disables decay
  --help              Show this help without opening a database
`;

function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) {
    throw new Error(`${label}: expected an ISO timestamp`);
  }
  // SQLite legacy timestamps without an offset are UTC, as in the reference.
  const utc = /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`;
  const time = Date.parse(utc) / 1000;
  if (!Number.isFinite(time)) throw new Error(`${label}: invalid timestamp`);
  return time;
}

export function parseKernelShadowArgs(args, now = Date.now() / 1000) {
  const options = { parameters: { ...KERNEL_DEFAULTS, now }, limit: 100, candidateIds: [] };
  const seen = new Set();
  let selection = null;
  const parameterFlags = { '--tau': 'tau', '--k': 'k', '--exponent': 'exponent', '--lambda': 'lambda', '--half-life': 'halfLifeYears' };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help') { options.help = true; continue; }
    if (flag === '--all') {
      if (selection) throw new Error('use only one of --all, --limit or --candidate-id');
      selection = 'all'; options.limit = null; continue;
    }
    if (!['--config', '--limit', '--candidate-id', '--now', ...Object.keys(parameterFlags)].includes(flag)) {
      throw new Error(`unknown option ${flag}`);
    }
    if (seen.has(flag) && flag !== '--candidate-id') throw new Error(`repeated option ${flag}`);
    seen.add(flag);
    const value = args[++i];
    if (value === undefined || value.startsWith('--') || value.trim() === '') throw new Error(`missing value for ${flag}`);
    if (flag === '--config') options.configPath = value;
    else if (flag === '--candidate-id') {
      if (selection && selection !== 'ids') throw new Error('use only one of --all, --limit or --candidate-id');
      selection = 'ids';
      const id = Number(value);
      if (!Number.isSafeInteger(id) || id < 1 || options.candidateIds.includes(id)) throw new Error('candidate IDs must be distinct positive safe integers');
      options.candidateIds.push(id);
    } else if (flag === '--limit') {
      if (selection) throw new Error('use only one of --all, --limit or --candidate-id');
      selection = 'limit'; options.limit = Number(value);
      if (!Number.isSafeInteger(options.limit) || options.limit < 1) throw new Error('--limit must be a positive safe integer');
    } else if (flag === '--now') {
      options.parameters.now = Number.isFinite(Number(value)) ? Number(value) : timestamp(value, '--now');
    } else options.parameters[parameterFlags[flag]] = Number(value);
  }
  options.parameters = kernelParameters(options.parameters);
  return options;
}

function embeddingSpace(stored, config) {
  const model = config.ollama.embedModel;
  const dimensions = config.ollama.embedDimensions ?? 'default';
  if (dimensions !== 'default' && (!Number.isSafeInteger(dimensions) || dimensions < 1)) throw new Error('configured text embedding dimensions must be positive');
  if (stored === `${model}::${dimensions}::f16`) {
    return {
      model, configuredDimensions: dimensions, storage: 'f16', metadataKind: 'legacy-model-dimensions-only',
      pipelineHistoryVerified: false,
      limitation: 'Legacy metadata does not establish document prefix, preprocessing, per-row provenance or immutable model identity.',
    };
  }
  let identity;
  try { identity = JSON.parse(stored); } catch { /* rejected below */ }
  if (identity?.version !== 2 || identity.model !== model || identity.dimensions !== dimensions
      || identity.storage !== 'f16' || identity.documentPrefix !== (config.ollama.embedPrefixes?.document ?? '')
      || identity.preprocessing !== 'stripHtml-v1/sampleText-v2' || identity.input !== 'title-text-4000-v1') {
    throw new Error('missing or incompatible text embedding provenance (embed_model_text); refusing to mix or certify spaces');
  }
  return {
    model, configuredDimensions: dimensions, storage: 'f16', metadataKind: 'document-pipeline-v2',
    recordedIdentity: {
      version: identity.version, model: identity.model, dimensions: identity.dimensions, storage: identity.storage,
      documentPrefix: identity.documentPrefix, preprocessing: identity.preprocessing, input: identity.input,
    },
    pipelineHistoryVerified: false,
    limitation: 'Matching recorded pipeline metadata does not establish per-row provenance or an immutable model digest.',
  };
}

function decode(row, dimensions) {
  const blob = row.text_embedding;
  if (!(blob instanceof Uint8Array) || blob.byteLength === 0 || blob.byteLength % 2 !== 0
      || (dimensions !== null && blob.byteLength !== dimensions * 2)) {
    throw new Error(`article #${row.id}: missing or wrong-dimensional text embedding`);
  }
  // Convert once to ordinary float32 elements; every float16 value is exact.
  const vector = Float32Array.from(new Float16Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength)));
  return {
    id: row.id, vote: row.vote, vector,
    voteTime: row.voted_at == null ? null : timestamp(row.voted_at, `article #${row.id} voted_at`),
    createdTime: timestamp(row.created_at, `article #${row.id} created_at`),
  };
}

/** Entry point exported so the complete readonly path can also be tested in-process. */
export function runKernelShadow(options) {
  const config = loadConfig(options.configPath);
  const parameters = kernelParameters(options.parameters);
  const db = openReadOnlyDb(config.db);
  let storedSpace, provenance, trainingRows, candidateRows, counts, schemaVersion;
  try {
    // Copy metadata and all selected rows from one read snapshot, then release
    // it before the CPU work. Concurrent application writes cannot mix spaces.
    db.exec('BEGIN');
    schemaVersion = db.prepare('PRAGMA user_version').get().user_version;
    storedSpace = db.prepare("SELECT value FROM meta WHERE key='embed_model_text'").get()?.value;
    provenance = embeddingSpace(storedSpace, config);
    counts = db.prepare(`SELECT
      SUM(CASE WHEN vote != 0 THEN 1 ELSE 0 END) AS voted,
      SUM(CASE WHEN vote != 0 AND text_embedding IS NULL THEN 1 ELSE 0 END) AS votedWithoutEmbedding,
      SUM(CASE WHEN vote = 0 AND text_embedding IS NOT NULL THEN 1 ELSE 0 END) AS eligibleCandidates,
      SUM(CASE WHEN vote = 0 AND text_embedding IS NULL THEN 1 ELSE 0 END) AS candidatesWithoutEmbedding
      FROM articles`).get();
    for (const key of Object.keys(counts)) counts[key] ??= 0;
    if (counts.votedWithoutEmbedding) throw new Error(`${counts.votedWithoutEmbedding} voted article(s) lack text embeddings; refusing partial training evidence`);
    const columns = 'id,vote,text_embedding,voted_at,created_at';
    trainingRows = db.prepare(`SELECT ${columns} FROM articles WHERE vote != 0 ORDER BY id`).all();
    if (options.candidateIds.length) {
      const select = db.prepare(`SELECT ${columns} FROM articles WHERE id = ?`);
      candidateRows = options.candidateIds.map((id) => {
        const row = select.get(id);
        if (!row || row.vote !== 0 || row.text_embedding == null) throw new Error(`candidate #${id} must exist, be unvoted and have a text embedding`);
        return row;
      });
    } else {
      const select = `SELECT ${columns} FROM articles WHERE vote = 0 AND text_embedding IS NOT NULL ORDER BY created_at DESC, id DESC`;
      candidateRows = options.limit === null ? db.prepare(select).all() : db.prepare(`${select} LIMIT ?`).all(options.limit);
    }
    db.exec('COMMIT');
  } finally { db.close(); }

  const fingerprint = createHash('sha256').update(JSON.stringify({ schemaVersion, storedSpace }));
  for (const [kind, rows] of [['training', trainingRows], ['candidates', candidateRows]]) {
    fingerprint.update(kind);
    for (const row of rows) {
      fingerprint.update(JSON.stringify([row.id, row.vote, row.voted_at, row.created_at, row.text_embedding.byteLength]));
      fingerprint.update(row.text_embedding);
    }
  }
  const dimensions = config.ollama.embedDimensions ?? null;
  const training = trainingRows.map((row) => decode(row, dimensions));
  const candidates = candidateRows.map((row) => decode(row, dimensions));
  const results = scoreKernel(training, candidates, parameters);
  return {
    tool: 'experimental-local-kernel-shadow-v1', experimental: true, mode: 'readonly',
    parameters, asOf: new Date(parameters.now * 1000).toISOString(),
    snapshot: { schemaVersion, consistentReadTransaction: true, selectedInputsSha256: fingerprint.digest('hex') },
    embeddingSpace: { ...provenance, observedDimensions: training[0]?.vector.length ?? candidates[0]?.vector.length ?? null },
    selection: {
      policy: options.candidateIds.length ? 'explicit-unvoted-ids' : options.limit === null ? 'all-unvoted-with-embedding' : 'latest-unvoted-with-embedding',
      limit: options.candidateIds.length ? null : options.limit,
      candidateOrder: options.candidateIds.length ? 'requested ID order' : 'created_at DESC, id DESC',
      trainingOrder: 'id ASC; preserved for equal-similarity ties',
      ...counts, scoredCandidates: candidates.length,
    },
    validation: { vectorScope: 'all training and selected candidates', normSquaredTolerance: KERNEL_NORM_SQUARED_TOLERANCE, vectorsRenormalized: false },
    interpretation: {
      score: 'Signed smoothed vote signal in [-1,1], not a probability, evaluation metric or production score.',
      support: 'Mass and effectiveNeighbors describe available weight and its concentration, not statistical confidence.',
      limitations: 'No exposure correction, duplicate/event deweighting, calibration or prospective relevance validation. No superiority claim.',
    },
    results,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseKernelShadowArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(HELP);
    else process.stdout.write(`${JSON.stringify(runKernelShadow(options), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`kernel shadow: ${error.message}\n`);
    process.exitCode = 1;
  }
}
