import { ingestAll } from './ingest.js';
import { enrichPending } from './enrich.js';
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
        log(`scheduler: ${r.added} new article(s) from ${r.feedsOk} feed(s)` +
          (r.feedsFailed ? `, ${r.feedsFailed} failed` : ''));
      }
    } catch (err) {
      console.error('scheduler fetch:', err.message);
    } finally {
      fetching = false;
    }
  };

  let enriching = false;
  const enrichTick = async () => {
    if (enriching) return;
    enriching = true;
    try {
      const { c } = db.prepare(`
        SELECT COUNT(*) AS c FROM articles
        WHERE status = 'pending' AND enrich_attempts < ?
      `).get(config.enrich.maxAttempts);
      if (c > 0 && acquireLease(db, owner)) {
        try {
          const r = await enrichPending(db, config, llm, {
            deadline: Date.now() + batchMs,
            onItem: () => acquireLease(db, owner), // heartbeat per article
          });
          if (r.enriched || r.failed) {
            recomputeScores(db, config);
            log(`scheduler: classified ${r.enriched} article(s)` +
              (r.failed ? `, ${r.failed} failed` : ''));
          }
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
