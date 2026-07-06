#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { syncFeeds, ingestAll } from '../src/ingest.js';
import { Ollama } from '../src/llm.js';
import { enrichPending } from '../src/enrich.js';
import { recomputeScores } from '../src/scoring.js';
import { createApp } from '../src/server.js';
import { startScheduler } from '../src/scheduler.js';
import { acquireLease, releaseLease } from '../src/lease.js';

const USAGE = `Usage: rssmart <mode> [options]

Modes:
  cron    Fetch feeds, classify/summarize new articles via Ollama, exit.
  serve   Start the web UI + API server.

Options:
  --config <path>   Config file (default: $RSSMART_CONFIG or ./config.yaml)
  --port <n>        Override server port (serve mode)
  -v, --verbose     Cron mode: report progress (default is silent on success,
                    errors on stderr — safe for real cron)
  --debug           Like --verbose, plus generated summaries
  --max-run <min>   Cron mode: override the time budget, in minutes
                    (0 = no limit, e.g. for a long backfill run)
  --all-feeds       Cron mode: fetch every active feed, ignoring the
                    adaptive per-feed schedule
  --help            Show this help
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string' },
    port: { type: 'string' },
    verbose: { type: 'boolean', short: 'v' },
    debug: { type: 'boolean' },
    'max-run': { type: 'string' },
    'all-feeds': { type: 'boolean' },
    help: { type: 'boolean' },
  },
});

const mode = positionals[0];
if (values.help || !['cron', 'serve'].includes(mode)) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 2);
}

const config = loadConfig(values.config);
const db = openDb(config.db);

if (mode === 'cron') {
  // Cron etiquette: silent on success, errors on stderr. --verbose/--debug
  // narrate progress for manual runs.
  const verbose = values.verbose || values.debug;
  const info = (...args) => verbose && console.log(...args);

  syncFeeds(db, config.feeds);

  // Ingest (network-bound) and enrichment (Ollama-bound) run concurrently.
  // The whole run has a time budget; whatever enrichment doesn't finish
  // stays pending for the next run. Ingestion always covers every feed.
  if (values['max-run'] !== undefined) {
    const minutes = Number(values['max-run']);
    if (!Number.isFinite(minutes) || minutes < 0) {
      console.error(`invalid --max-run "${values['max-run']}": minutes required (0 = no limit)`);
      process.exit(2);
    }
    config.cron.maxRunMs = minutes === 0 ? null : minutes * 60_000;
  }
  const deadline = config.cron.maxRunMs ? Date.now() + config.cron.maxRunMs : undefined;
  let ingestDone = false;

  const ingestPromise = ingestAll(db, config, {
    dueOnly: !values['all-feeds'],
    onFeed(f) {
      if (f.error) console.error(`[${f.index}/${f.total}] feed ${f.url}: ${f.error}`);
      else info(`[${f.index}/${f.total}] feed ${f.url}: ${f.added} new`);
    },
  }).finally(() => {
    ingestDone = true;
  });

  // A serve process with the internal scheduler (or another cron run) may
  // already be classifying; the lease keeps the queue single-consumer.
  const owner = `cron-${process.pid}`;
  const llm = new Ollama(config.ollama);
  const enrichPromise = !acquireLease(db, owner)
    ? Promise.resolve({ skipped: true, reason: 'another rssmart process holds the classification lease' })
    : enrichPending(db, config, llm, {
    deadline,
    waitForMore: () => !ingestDone,
    onItem(item) {
      acquireLease(db, owner); // heartbeat
      if (item.error) {
        console.error(`[${item.index}/${item.total}] article #${item.id} "${item.title}": ${item.error}`);
        return;
      }
      info(
        `[${item.index}/${item.total}] #${item.id} ${item.title} -> [${item.topics.join(', ')}]` +
          (item.depth ? ` depth ${item.depth}/5` : '') +
          (item.duplicateOf ? ` (repeat of #${item.duplicateOf})` : ''),
      );
      if (values.debug) info(`    ${item.summary}`);
    },
  });
  const [ingest, enrich] = await Promise.all([ingestPromise, enrichPromise]);
  releaseLease(db, owner);

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  info(
    `ingest: ${plural(ingest.added, 'new article')} from ${plural(ingest.feedsOk, 'feed')}` +
      (ingest.feedsFailed ? `, ${plural(ingest.feedsFailed, 'feed')} failed` : ''),
  );
  if (enrich.skipped) {
    // a held lease is normal coexistence with a serve scheduler, not an error
    if (/lease/.test(enrich.reason)) info(`enrich skipped: ${enrich.reason}`);
    else console.error(`enrich skipped: ${enrich.reason}; articles stay pending`);
  } else {
    info(
      `enrich: ${enrich.enriched} enriched (${plural(enrich.duplicates, 'duplicate')}), ${enrich.failed} failed` +
        (enrich.timedOut ? ' — time budget reached, the rest next run' : ''),
    );
  }

  recomputeScores(db, config);
  db.close();

  const allFeedsFailed = ingest.feedsFailed > 0 && ingest.feedsOk === 0;
  process.exit(allFeedsFailed ? 1 : 0);
} else {
  const app = createApp(db, config);
  const port = Number(values.port) || config.server.port;
  app.listen(port, config.server.host, () => {
    console.log(`rssmart serving on http://${config.server.host}:${port}`);
  });
  if (config.scheduler.enabled) {
    startScheduler(db, config, { log: console.log });
    console.log('internal scheduler active: fetching due feeds, classifying pending articles');
  }
}
