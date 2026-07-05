import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
    batchSize: 30,
    maxAttempts: 5,
    dupThreshold: 0.87,
    dupWindowDays: 14,
  },
  server: {
    host: '0.0.0.0',
    port: 8098,
  },
};

/**
 * Load configuration. Precedence: explicit path arg (--config) >
 * RSSMART_CONFIG env var > ./config.json in the current directory.
 * Relative paths inside the config (db) resolve against the config file's
 * directory, so cron jobs work regardless of their working directory.
 */
export function loadConfig(path) {
  const file = path ?? process.env.RSSMART_CONFIG ?? 'config.json';
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read config file "${file}": ${err.message}`);
  }
  let user;
  try {
    user = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config file "${file}" is not valid JSON: ${err.message}`);
  }

  const config = {
    ...DEFAULTS,
    ...user,
    ollama: { ...DEFAULTS.ollama, ...user.ollama },
    enrich: { ...DEFAULTS.enrich, ...user.enrich },
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
