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
  },
  auth: {
    password: 'string',
  },
};

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
      errors.push(`${full}: missing key (copy from config.example.yaml)`);
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
 * Load configuration. The config file is mandatory and must contain every
 * key in the schema (copy config.example.yaml to start). No defaults are
 * merged — the example file IS the default.
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
  if (!config || typeof config !== 'object') {
    throw new Error(`config file "${file}" must contain a YAML mapping`);
  }

  const [errors, warnings] = validateConfig(config);
  for (const w of warnings) console.warn(`config: ${w}`);
  if (errors.length) {
    throw new Error(`config validation failed:\n  ${errors.join('\n  ')}`);
  }

  config.db = resolve(dirname(resolve(file)), config.db);
  return config;
}