import { ingestAll } from './ingest.js';
import { enrichPending, reembedMissing } from './enrich.js';
import { recomputeScores } from './scoring.js';
import { Ollama } from './llm.js';
import { acquireLease, releaseLease } from './lease.js';

/**
 * The serve-internal scheduler: two independent loops so a deep
 * classification backlog never starves feed fetching.
 *  - fetch loop: fetches whichever feeds are due (adaptive per-feed cadence)
 *  - enrich loop: drains pending articles in one-minute batches, holding the
 *    enrichment lease so an external cron/backfill run and this process
 *    never classify the same queue twice (whoever grabs the lease first
 *    wins; the other skips and retries later)
 * Returns a stop() function.
 */
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function startScheduler(db, config, {
  log = () => {},
  fetchEveryMs = 60_000,
  enrichEveryMs = 15_000,
  batchMs = 60_000,
} = {}) {
  const owner = `serve-${process.pid}`;
  const llm = new Ollama(config.ollama);

  let fetching = false;
  const fetchTick = async () => {
    if (fetching) return;
    fetching = true;
    try {
      const r = await ingestAll(db, config, { dueOnly: true });
      if (r.feedsOk + r.feedsFailed > 0) {
        log(`scheduler: ${plural(r.added, 'new article')} from ${plural(r.feedsOk, 'feed')}` +
          (r.feedsFailed ? `, ${r.feedsFailed} failed` : ''));
      }
    } catch (err) {
      console.error('scheduler fetch:', err.message);
    } finally {
      fetching = false;
    }
  };

  const hasClassifierWork = () => db.prepare(`
    SELECT COUNT(*) AS c FROM articles
    WHERE (status = 'pending' AND enrich_attempts < ?)
       OR (status = 'enriched' AND (embedding IS NULL OR text_embedding IS NULL))
  `).get(config.enrich.maxAttempts).c > 0;

  // One lease-guarded batch: re-embed vectors missing in the current
  // embedding space first, then classify pending articles.
  const classifyBatch = async () => {
    const started = Date.now();
    const deadline = started + batchMs;
    const heartbeat = () => acquireLease(db, owner);

    const re = await reembedMissing(db, config, llm, { deadline, onItem: heartbeat });
    if (re.reembedded) log(`scheduler: re-embedded ${plural(re.reembedded, 'article')}`);

    const r = await enrichPending(db, config, llm, { deadline, onItem: heartbeat });
    if (r.enriched || r.failed) {
      recomputeScores(db, config);
      const avg = (Date.now() - started) / (r.enriched + r.failed) / 1000;
      log(`scheduler: classified ${plural(r.enriched, 'article')} (avg ${avg.toFixed(1)}s each)` +
        (r.failed ? `, ${r.failed} failed` : ''));
    }
  };

  let enriching = false;
  const enrichTick = async () => {
    if (enriching) return;
    enriching = true;
    try {
      if (hasClassifierWork() && acquireLease(db, owner)) {
        try {
          await classifyBatch();
        } finally {
          releaseLease(db, owner);
        }
      }
    } catch (err) {
      console.error('scheduler enrich:', err.message);
    } finally {
      enriching = false;
    }
  };

  const timers = [
    setInterval(fetchTick, fetchEveryMs),
    setInterval(enrichTick, enrichEveryMs),
  ];
  for (const t of timers) t.unref?.();
  fetchTick();
  enrichTick();

  return () => timers.forEach(clearInterval);
}
