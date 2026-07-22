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
    // Matryoshka-style dimension truncation (halves embedding storage on
    // top of the float16 format): opt-in, since not every embedding model
    // supports it. null/omitted asks for the model's native dimension.
    embedDimensions: null,
    // Dedup embeddings (summary-based) use fewer dims — cosine duplicates
    // are detectable at much lower resolution than taste/kNN needs.
    // null/omitted falls back to embedDimensions.
    dedupEmbedDimensions: 64,
    timeoutMs: 60_000,
    // Finding redundant topics (src/topicMerge.js) reasons over the whole
    // topic vocabulary at once, not one short article — a fundamentally
    // slower request than per-article classification, and a rare,
    // reader-initiated one, so it gets a much longer budget than
    // timeoutMs rather than sharing it and risking a spurious abort.
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
    // Hard cap on fetched origin-page text/html, regardless of how well it
    // extracted — a safety net against pages that aren't really one article
    // (e.g. an anchor into a shared listing/archive page), not just a
    // quality heuristic. See fetchArticleText in src/fetchpage.js.
    maxArticleChars: 50_000,
    // The topic vocabulary only grows (nothing merges/retires topics on its
    // own — see docs/scripts for topic-merge tooling), and the full list
    // rides in every classification prompt. Capping what's *suggested* to
    // the classifier bounds that cost regardless of how large the
    // vocabulary gets; it doesn't touch already-tagged articles or stop a
    // topic outside the cap from being reused if the model names it anyway
    // (see existingTopicNames, src/enrich.js). 0 or null shows the full list.
    maxSuggestedTopics: 150,
    // When an article's stripped text is shorter than this and the content
    // contains an external link, rssmart fetches that link, extracts the
    // readable text, and appends it below a `---` separator. Set to 0 to
    // disable. Useful for links shared on the Fediverse or terse RSS items.
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
    // Vote recency decay: older votes contribute less to all vote-derived
    // signals (topic preference, embedding kNN, feed/author record). The
    // halflife is in years; a vote aged one halflife counts half as much.
    // 0 or null disables decay (all votes equal regardless of age).
    voteDecayHalflifeYears: 1.5,
    weights: {
      topics: 0.3,
      embedding: 0.4,
      depth: 0.1,
      feed: 0.2,
    },
    // A vote updates its own article's score instantly (cheap: just that
    // article's topic/feed prefs plus a scan of the — usually small —
    // voted set). The full corpus-wide ripple (every other article's kNN
    // term can shift too) is expensive at scale, so it's debounced: each
    // vote pushes the due time back by this many seconds, and it only
    // actually runs once voting has paused for that long.
    recomputeDebounceSec: 120,
    // "hot" sort blends interest with freshness (à la Hacker News) so an
    // old article can't bury a fresh one just by having a slightly higher
    // score: rank = score - hotDecayPerDay * age_in_days. At the default,
    // a day of age costs 0.05 — enough to cancel a solidly good score
    // (~0.3) within a week, so freshness dominates unless something is
    // genuinely exceptional.
    hotDecayPerDay: 0.05,
  },
  mastodon: {
    url: '',
    token: '',
    username: '',
    password: '',
  },
  server: {
    // Loopback-only by default: this is a personal-use reader with no
    // authentication of its own (see the README's Notes section), so it
    // shouldn't be reachable from outside this machine unless you
    // deliberately choose that. Set to '0.0.0.0' (or a LAN address) only
    // on a network you trust, ideally behind your own reverse proxy/auth.
    host: '127.0.0.1',
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
  return config;
}
