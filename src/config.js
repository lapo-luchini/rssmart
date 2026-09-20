import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import YAML from 'yaml';

/**
 * Schema maps every expected config key to its type. Objects recurse.
 * The '?' suffix marks a field as nullable (null is acceptable).
 * This is the single source of truth — config.example.yaml is the
 * documented template that matches this schema.
 */
const SCHEMA = {
  db: 'string',
  ollama: {
    url: 'string',
    chatModel: 'string',
    embedModel: 'string',
    embedDimensions: 'number?',
    dedupEmbedModel: 'string?',
    dedupEmbedDimensions: 'number?',
    embedPrefixes: { document: 'string', query: 'string' },
    timeoutMs: 'number',
    topicMergeTimeoutMs: 'number',
    apiKey: 'string',
  },
  enrich: {
    workers: 'number',
    maxAttempts: 'number',
    dupThreshold: 'number',
    dupWindowDays: 'number',
    fetchMinChars: 'number',
    allowPrivateFetch: 'boolean',
    maxInputChars: 'number',
    maxArticleChars: 'number',
    maxSuggestedTopics: 'number?',
    linkExpandMaxChars: 'number',
  },
  cron: { maxRunMs: 'number' },
  scheduler: {
    enabled: 'boolean',
    minIntervalMin: 'number',
    maxIntervalMin: 'number',
  },
  scoring: {
    knn: 'number',
    voteDecayHalflifeYears: 'number?',
    weights: { topics: 'number', embedding: 'number', depth: 'number', feed: 'number' },
    recomputeDebounceSec: 'number',
    hotDecayPerDay: 'number',
  },
  triage: {
    roundRobinWindowDays: 'number',
  },
  mastodon: {
    url: 'string',
    token: 'string',
    username: 'string',
    password: 'string',
  },
  server: {
    host: 'string',
    port: 'number',
    metricsAllowFrom: 'string?',
  },
  auth: {
    password: 'string',
  },
};

// Semantic domains are checked at startup, before allocating kNN arrays,
// starting workers or scheduling timers. Zero retains its existing disable/
// neutral meaning where supported; fractional durations in days/years and
// intervals in minutes remain valid. Counts fit JavaScript array lengths;
// millisecond timers also stay below the runtime's signed 32-bit limit.
const count = (min = 0) => ({ integer: true, min, max: 0xffffffff });
const timer = { integer: true, min: 1, max: 0x7fffffff };
const nonnegative = { min: 0 };
const NUMERIC_DOMAINS = {
  'ollama.embedDimensions': count(1),
  'ollama.dedupEmbedDimensions': count(1),
  'ollama.timeoutMs': timer,
  'ollama.topicMergeTimeoutMs': timer,
  'enrich.workers': count(1),
  'enrich.maxAttempts': count(1),
  'enrich.dupThreshold': { min: -1, max: 1 },
  'enrich.dupWindowDays': nonnegative,
  'enrich.fetchMinChars': count(),
  'enrich.maxInputChars': count(1),
  'enrich.maxArticleChars': count(1),
  'enrich.maxSuggestedTopics': count(),
  'enrich.linkExpandMaxChars': count(),
  'cron.maxRunMs': { integer: true, min: 0, max: Number.MAX_SAFE_INTEGER },
  'scheduler.minIntervalMin': { min: 0, exclusiveMin: true },
  'scheduler.maxIntervalMin': { min: 0, exclusiveMin: true },
  'scoring.knn': count(),
  'scoring.voteDecayHalflifeYears': nonnegative,
  'scoring.weights.topics': nonnegative,
  'scoring.weights.embedding': nonnegative,
  'scoring.weights.depth': nonnegative,
  'scoring.weights.feed': nonnegative,
  'scoring.recomputeDebounceSec': nonnegative,
  'scoring.hotDecayPerDay': nonnegative,
  'triage.roundRobinWindowDays': nonnegative,
  'server.port': { integer: true, min: 0, max: 65535 },
};

function numericError(value, domain) {
  if (!Number.isFinite(value)) return 'must be finite';
  if (!domain) return null;
  if (domain.integer && !Number.isSafeInteger(value)) return 'must be a safe integer';
  if (value < domain.min || (domain.exclusiveMin && value === domain.min) || value > (domain.max ?? Infinity)) {
    return `must be ${domain.exclusiveMin ? '>' : '>='} ${domain.min}` +
      (domain.max === undefined ? '' : ` and <= ${domain.max}`);
  }
  return null;
}

/**
 * Validate a config object against SCHEMA. All keys in the schema are
 * required (the user copies config.example.yaml as a starting point).
 * Extra keys are warned as likely typos. Wrong types throw.
 */
function validateConfig(config, schema = SCHEMA, path = 'config') {
  const errors = [];
  const warnings = [];

  for (const [key, spec] of Object.entries(schema)) {
    const full = `${path}.${key}`;
    const val = config[key];

    if (!(key in config)) {
      // keys marked with ? are truly optional: omit them and the consuming
      // code falls back (e.g. dedupEmbedModel -> embedModel) — a config
      // written for an older version keeps working across deploys
      if (typeof spec === 'object' || !spec.endsWith('?')) {
        errors.push(`${full}: missing key (copy from config.example.yaml)`);
      }
      continue;
    }

    if (typeof spec === 'object') {
      if (val === null || typeof val !== 'object' || Array.isArray(val)) {
        errors.push(`${full}: expected an object, got ${Array.isArray(val) ? 'array' : val === null ? 'null' : typeof val}`);
        continue;
      }
      const [errs, warns] = validateConfig(val, spec, full);
      errors.push(...errs);
      warnings.push(...warns);
      for (const uk of Object.keys(val)) {
        if (!(uk in spec)) warnings.push(`${full}.${uk}: unknown key (typo? not in schema)`);
      }
    } else {
      const nullable = spec.endsWith('?');
      const expected = nullable ? spec.slice(0, -1) : spec;
      if (val === undefined) {
        errors.push(`${full}: missing key (copy from config.example.yaml)`);
      } else if (val === null) {
        if (!nullable) errors.push(`${full}: expected ${expected}, got null`);
      } else if (typeof val !== expected) {
        errors.push(`${full}: expected ${expected}, got ${typeof val}`);
      } else if (expected === 'number') {
        const error = numericError(val, NUMERIC_DOMAINS[full.slice('config.'.length)]);
        if (error) errors.push(`${full}: ${error}`);
      }
    }
  }

  // Warn on unknown keys in this scope
  for (const uk of Object.keys(config)) {
    if (!(uk in schema)) warnings.push(`${path}.${uk}: unknown key (typo? not in schema)`);
  }

  return [errors, warnings];
}

/**
 * Load configuration. The config file must contain every required key in
 * the schema (copy config.example.yaml to start); keys marked with `?` are
 * optional — omit them and the consuming code falls back (e.g.
 * dedupEmbedModel -> embedModel). No other defaults are merged — the
 * example file IS the default.
 * Relative paths (db) resolve against the config file's directory.
 */
export function loadConfig(path) {
  const file = path ?? process.env.RSSMART_CONFIG ?? 'config.yaml';
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read config file "${file}": ${err.message}`);
  }
  let config;
  try {
    config = YAML.parse(raw);
  } catch (err) {
    throw new Error(`config file "${file}" is not valid YAML: ${err.message}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`config file "${file}" must contain a YAML mapping`);
  }

  const [errors, warnings] = validateConfig(config);
  if (Number.isFinite(config.scheduler?.minIntervalMin) && Number.isFinite(config.scheduler?.maxIntervalMin) &&
      config.scheduler.minIntervalMin > config.scheduler.maxIntervalMin) {
    errors.push('config.scheduler.minIntervalMin: must be <= config.scheduler.maxIntervalMin');
  }
  const weights = Object.keys(SCHEMA.scoring.weights).map((key) => config.scoring?.weights?.[key]);
  if (weights.length && weights.every((value) => typeof value === 'number') &&
      !Number.isFinite(weights.reduce((sum, value) => sum + value, 0))) {
    errors.push('config.scoring.weights: the sum must be finite');
  }
  for (const w of warnings) console.warn(`config: ${w}`);
  if (errors.length) {
    throw new Error(`config validation failed:\n  ${errors.join('\n  ')}`);
  }

  config.db = resolve(dirname(resolve(file)), config.db);
  return config;
}
