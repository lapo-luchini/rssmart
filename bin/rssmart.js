#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { syncFeeds, ingestAll } from '../src/ingest.js';
import { Ollama } from '../src/llm.js';
import { enrichPending } from '../src/enrich.js';
import { recomputeScores } from '../src/scoring.js';
import { createApp } from '../src/server.js';

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
  --help            Show this help
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string' },
    port: { type: 'string' },
    verbose: { type: 'boolean', short: 'v' },
    debug: { type: 'boolean' },
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

  const ingest = await ingestAll(db, config);
  for (const f of ingest.feeds) {
    if (f.error) console.error(`feed ${f.url}: ${f.error}`);
    else info(`feed ${f.url}: ${f.added} new`);
  }
  info(
    `ingest: ${ingest.added} new article(s) from ${ingest.feedsOk} feed(s)` +
      (ingest.feedsFailed ? `, ${ingest.feedsFailed} feed(s) failed` : ''),
  );

  const llm = new Ollama(config.ollama);
  const enrich = await enrichPending(db, config, llm, {
    onItem(item) {
      if (item.error) {
        console.error(`article #${item.id} "${item.title}": ${item.error}`);
        return;
      }
      info(
        `#${item.id} ${item.title} -> [${item.topics.join(', ')}]` +
          (item.duplicateOf ? ` (repeat of #${item.duplicateOf})` : ''),
      );
      if (values.debug) info(`    ${item.summary}`);
    },
  });
  if (enrich.skipped) {
    console.error(`enrich skipped: ${enrich.reason}; articles stay pending`);
  } else {
    info(
      `enrich: ${enrich.enriched} enriched (${enrich.duplicates} duplicate(s)), ${enrich.failed} failed`,
    );
  }

  recomputeScores(db);
  db.close();

  const allFeedsFailed = ingest.feedsFailed > 0 && ingest.feedsOk === 0;
  process.exit(allFeedsFailed ? 1 : 0);
} else {
  const app = createApp(db, config);
  const port = Number(values.port) || config.server.port;
  app.listen(port, config.server.host, () => {
    console.log(`rssmart serving on http://${config.server.host}:${port}`);
  });
}
