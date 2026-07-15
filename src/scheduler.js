import { ingestAll, syncMastodonFeed } from './ingest.js';
import { enrichPending, reembedMissing } from './enrich.js';
import { recomputeOneScore, recomputeIfDue } from './scoring.js';
import { Ollama } from './llm.js';
import { acquireLease, releaseLease } from './lease.js';
import { logError } from './log.js';

/**
 * The serve-internal scheduler: independent loops so a deep classification
 * backlog never starves feed fetching, and neither blocks vote responses.
 *  - fetch loop: fetches whichever feeds are due (adaptive per-feed cadence)
 *  - enrich loop: drains pending articles in one-minute batches, holding the
 *    enrichment lease so an external cron/backfill run and this process
 *    never classify the same queue twice (whoever grabs the lease first
 *    wins; the other skips and retries later)
 *  - score loop: checks (cheaply) whether a debounced full-corpus recompute
 *    is due after recent votes, and runs it (expensive) only then — see
 *    scheduleRecompute/recomputeIfDue in scoring.js and DESIGN.md
 * Returns a stop() function.
 */
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function startScheduler(db, config, {
  log = () => {},
  fetchEveryMs = 60_000,
  enrichEveryMs = 15_000,
  scoreEveryMs = 15_000,
  batchMs = 60_000,
} = {}) {
  const owner = `serve-${process.pid}`;
  const llm = new Ollama(config.ollama);
  syncMastodonFeed(db, config);

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
      if (r.added > 0) classifierWorkPending = -1;
    } catch (err) {
      logError('scheduler fetch:', err.message);
    } finally {
      fetching = false;
    }
  };

  let classifierWorkPending = -1; // -1 = unknown, 0 = none, >0 = count
  const hasClassifierWork = () => {
    if (classifierWorkPending < 0) {
      classifierWorkPending = db.prepare(`
        SELECT COUNT(*) AS c FROM articles
        WHERE (status = 'pending' AND enrich_attempts < ?)
           OR (status = 'enriched' AND (embedding IS NULL OR text_embedding IS NULL))
      `).get(config.enrich.maxAttempts).c;
    }
    return classifierWorkPending > 0;
  };

  // One lease-guarded batch: re-embed vectors missing in the current
  // embedding space first, then classify pending articles.
  const classifyBatch = async () => {
    const started = Date.now();
    const deadline = started + batchMs;
    const heartbeat = () => acquireLease(db, owner);

    const re = await reembedMissing(db, config, llm, { deadline, onItem: heartbeat });
    if (re.reembedded) log(`scheduler: re-embedded ${plural(re.reembedded, 'article')}`);

    // A newly-classified article needs its own score computed (fresh
    // depth/topics didn't exist before), but nothing about *other*
    // articles' scores changes: scoring is entirely vote-driven, and an
    // unvoted article (every article straight out of classification)
    // contributes nothing to any topic/feed preference aggregate.
    // recomputeOneScore per classified article is therefore exactly as
    // correct here as a full recomputeScores() sweep, not an
    // approximation — and unlike it, doesn't block the event loop for
    // the ~48s a full recompute takes against a real ~6k-article archive
    // (measured live), which used to make every concurrent request,
    // including a vote, hang until this batch's recompute finished.
    const classifiedIds = [];
    const r = await enrichPending(db, config, llm, {
      deadline,
      onItem: (item) => {
        heartbeat();
        if (!item.error) classifiedIds.push(item.id);
      },
    });
    for (const id of classifiedIds) recomputeOneScore(db, config, id);
    if (r.enriched || r.failed) {
      const avg = (Date.now() - started) / (r.enriched + r.failed) / 1000;
      log(`scheduler: classified ${plural(r.enriched, 'article')} (avg ${avg.toFixed(1)}s each)` +
        (r.failed ? `, ${r.failed} failed` : ''));
    }
    classifierWorkPending = -1; // invalidate after batch
  };

  let enriching = false;
  let enrichStartedAt = 0;
  const enrichTick = async () => {
    if (enriching) return;
    enriching = true;
    enrichStartedAt = Date.now();
    try {
      if (!hasClassifierWork()) return;
      if (!acquireLease(db, owner)) {
        log('scheduler enrich: enrichment lease held by another process');
        return;
      }
      try {
        await classifyBatch();
      } finally {
        releaseLease(db, owner);
      }
    } catch (err) {
      logError('scheduler enrich:', err.message);
    } finally {
      enriching = false;
      enrichStartedAt = 0;
    }
  };

  // Independent watchdog: if a batch runs longer than 2× batchMs, force-reset
  // enriching so the next timer tick can start fresh. The old batch may still
  // be running in the background but its finally block will set enriching to
  // false harmlessly (already reset by the watchdog).
  const enrichWatchdog = setInterval(() => {
    if (enriching && enrichStartedAt && Date.now() - enrichStartedAt > batchMs * 2) {
      logError('scheduler enrich watchdog: batch stuck for ' + ((Date.now() - enrichStartedAt) / 1000).toFixed(0) + 's — force reset');
      enriching = false;
    }
  }, enrichEveryMs);

  // recomputeIfDue's full sweep now yields periodically (see scoring.js) so
  // it never blocks concurrent requests for its whole ~48s, but it's still
  // one long-running async job — this guard just stops scoreEveryMs ticks
  // from starting a second overlapping sweep while one is already in flight.
  let scoring = false;
  const scoreTick = async () => {
    if (scoring) return;
    scoring = true;
    try {
      const result = await recomputeIfDue(db, config);
      if (result) {
        log(`scheduler: recomputed ${plural(result.count, 'score')} in ` +
          `${(result.ms / 1000).toFixed(1)}s (debounced after recent votes)`);
      }
    } catch (err) {
      logError('scheduler score:', err.message);
    } finally {
      scoring = false;
    }
  };

  const timers = [
    setInterval(fetchTick, fetchEveryMs),
    setInterval(enrichTick, enrichEveryMs),
    setInterval(scoreTick, scoreEveryMs),
    enrichWatchdog,
  ];
  for (const t of timers) t.unref?.();
  fetchTick();
  enrichTick();
  scoreTick();

  return () => timers.forEach(clearInterval);
}
