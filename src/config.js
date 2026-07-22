import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import YAML from 'yaml';

const DEFAULTS = {
  db: './data/rssmart.db',
  ollama: {
    url: 'http://localhost:11434',
    chatModel: 'gemma4:12b-it-qat',
    embedModel: 'nomic-embed-text',
    embedPrefixes: { document: '', query: '' },
    embedDimensions: null,
    dedupEmbedDimensions: 64,
    timeoutMs: 60_000,
    topicMergeTimeoutMs: 300_000,
  },
  enrich: {
    workers: 2,
    maxAttempts: 5,
    dupThreshold: 0.87,
    dupWindowDays: 14,
    fetchMinChars: 500,
    allowPrivateFetch: false,
    maxInputChars: 32_000,
    maxArticleChars: 50_000,
    maxSuggestedTopics: 150,
    linkExpandMaxChars: 400,
  },
  cron: {
    maxRunMs: 300_000,
  },
  scheduler: {
    enabled: true,
    minIntervalMin: 15,
    maxIntervalMin: 1440,
  },
  scoring: {
    knn: 30,
    voteDecayHalflifeYears: 1.5,
    weights: {
      topics: 0.3,
      embedding: 0.4,
      depth: 0.1,
      feed: 0.2,
    },
    recomputeDebounceSec: 120,
    hotDecayPerDay: 0.05,
  },
  mastodon: {
    url: '',
    token: '',
    username: '',
    password: '',
  },
  server: {
    host: '127.0.0.1',
    port: 8098,
  },
};

/**
 * Schema for validation: maps each config key to its expected type and,
 * for objects, the expected sub-keys. Used both to detect unknown keys
 * (typos in the wrong section) and to validate types.
 */
const SCHEMA = {
  db: 'string',
  ollama: {
    url: 'string',
    chatModel: 'string',
    embedModel: 'string',
    embedPrefixes: { document: 'string', query: 'string' },
    embedDimensions: 'number?',
    dedupEmbedDimensions: 'number?',
    timeoutMs: 'number',
    topicMergeTimeoutMs: 'number',
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
};

/**
 * Validate config against SCHEMA. Warns on unknown keys (likely typos),
 * throws on wrong types for required fields. The '?' suffix marks a field
 * as nullable (null is acceptable).
 */
function validateConfig(config, schema = SCHEMA, path = 'config') {
  const errors = [];
  const warnings = [];

  for (const [key, spec] of Object.entries(schema)) {
    const full = `${path}.${key}`;
    const val = config[key];

    if (val === undefined) continue; // optional, covered by defaults
    if (spec === null) continue; // accept anything

    if (typeof spec === 'object') {
      // Nested object: recurse, and check for unknown keys
      if (val === null || typeof val !== 'object' || Array.isArray(val)) {
        errors.push(`${full}: expected an object, got ${Array.isArray(val) ? 'array' : typeof val}`);
        continue;
      }
      const [errs, warns] = validateConfig(val, spec, full);
      errors.push(...errs);
      warnings.push(...warns);
      for (const uk of Object.keys(val)) {
        if (!(uk in spec)) warnings.push(`${full}.${uk}: unknown key (typo? not in schema)`);
      }
    } else {
      // Leaf: check type
      const nullable = spec.endsWith('?');
      const expected = nullable ? spec.slice(0, -1) : spec;
      if (val === null) {
        if (!nullable) errors.push(`${full}: expected ${expected}, got null`);
      } else if (typeof val !== expected) {
        // Booleans are not numbers in this check
        if (expected === 'number' && typeof val === 'boolean') {
          errors.push(`${full}: expected ${expected}, got boolean`);
        } else if (expected !== 'number' || typeof val !== 'number') {
          errors.push(`${full}: expected ${expected}, got ${typeof val}`);
        }
      }
    }
  }

  return [errors, warnings];
}

/**
 * Load configuration. Precedence: explicit path arg (--config) >
 * RSSMART_CONFIG env var > ./config.yaml in the current directory.
 * YAML is a superset of JSON, so a JSON config file also loads fine.
 * Relative paths inside the config (db) resolve against the config file's
 * directory, so cron jobs work regardless of their working directory.
 */
export function loadConfig(path) {
  const file = path ?? process.env.RSSMART_CONFIG ?? 'config.yaml';
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read config file "${file}": ${err.message}`);
  }
  let user;
  try {
    user = YAML.parse(raw);
  } catch (err) {
    throw new Error(`config file "${file}" is not valid YAML: ${err.message}`);
  }
  if (!user || typeof user !== 'object') {
    throw new Error(`config file "${file}" must contain a YAML mapping`);
  }

  const config = {
    ...DEFAULTS,
    ...user,
    ollama: {
      ...DEFAULTS.ollama,
      ...user.ollama,
      embedPrefixes: {
        ...DEFAULTS.ollama.embedPrefixes,
        ...user.ollama?.embedPrefixes,
      },
    },
    enrich: { ...DEFAULTS.enrich, ...user.enrich },
    cron: { ...DEFAULTS.cron, ...user.cron },
    scheduler: { ...DEFAULTS.scheduler, ...user.scheduler },
    mastodon: { ...DEFAULTS.mastodon, ...user.mastodon },
    scoring: {
      ...DEFAULTS.scoring,
      ...user.scoring,
      weights: { ...DEFAULTS.scoring.weights, ...user.scoring?.weights },
    },
    server: { ...DEFAULTS.server, ...user.server },
  };

  config.db = resolve(dirname(resolve(file)), config.db);

  // Validate against schema: unknown keys warn, wrong types throw.
  const [errors, warnings] = validateConfig(config);
  for (const w of warnings) console.warn(`config: ${w}`);
  if (errors.length) {
    throw new Error(`config validation failed:\n  ${errors.join('\n  ')}`);
  }

  return config;
}
