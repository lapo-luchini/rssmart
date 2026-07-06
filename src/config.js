import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import YAML from 'yaml';

const DEFAULTS = {
  db: './data/rssmart.db',
  feeds: [],
  ollama: {
    url: 'http://localhost:11434',
    chatModel: 'llama3.1',
    embedModel: 'nomic-embed-text',
    timeoutMs: 60_000,
  },
  enrich: {
    workers: 2,
    maxAttempts: 5,
    dupThreshold: 0.87,
    dupWindowDays: 14,
    fetchMinChars: 500,
    allowPrivateFetch: false,
    maxInputChars: 32_000,
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
    knn: 20,
    weights: {
      topics: 0.4,
      embedding: 0.3,
      depth: 0.2,
      feed: 0.1,
    },
  },
  server: {
    host: '0.0.0.0',
    port: 8098,
  },
};

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
    ollama: { ...DEFAULTS.ollama, ...user.ollama },
    enrich: { ...DEFAULTS.enrich, ...user.enrich },
    cron: { ...DEFAULTS.cron, ...user.cron },
    scheduler: { ...DEFAULTS.scheduler, ...user.scheduler },
    scoring: {
      ...DEFAULTS.scoring,
      ...user.scoring,
      weights: { ...DEFAULTS.scoring.weights, ...user.scoring?.weights },
    },
    server: { ...DEFAULTS.server, ...user.server },
  };

  config.feeds = (config.feeds ?? []).map((f) =>
    typeof f === 'string' ? { url: f } : f,
  );
  for (const feed of config.feeds) {
    if (!feed.url) throw new Error('every feed needs a "url"');
  }

  config.db = resolve(dirname(resolve(file)), config.db);
  return config;
}
