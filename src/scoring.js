// Preference learning: an article's score blends four signals, each in
// [-1, 1] and neutral (0) when it has no data, weighted by config.scoring:
//   topics    — Laplace-smoothed up/down vote ratio of the article's topics
//   embedding — k-NN over voted articles' raw-text embeddings (captures
//               style/genre taste that shared topic names flatten)
//   depth     — LLM substance rating (1-5) mapped to [-1, 1]
//   feed      — the source's own vote ratio
// The persisted score_* columns hold the already-weighted contributions,
// so score = score_topics + score_embedding + score_depth + score_feed.
// Everything derives from votes at recompute time — no training state.

import { bufToVec, existingTopicNames } from './enrich.js';
import { createDotBatcher } from './wasmDot.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// How long recomputeScores works synchronously before handing control back
// to the event loop. Measured live: a full sweep over a real ~6200-article
// archive takes ~48s of near-continuous CPU (the kNN pass dominates); with
// no yielding, that blocks every concurrent request — including a vote's
// HTTP response — for the whole 48s. 150ms keeps the worst-case wait a
// vote might see well under a second, while still keeping the per-chunk
// SQLite transaction long enough that committing thousands of rows doesn't
// turn into thousands of tiny fsyncs.
const DEFAULT_YIELD_MS = 150;

// Votes range -2..+2 ("WOW" votes count double). The Laplace ratio works on
// the weighted magnitudes: SUM(MAX(v,0)) up-weight vs SUM(ABS(v)) total.
const PREF_EXPR = `
  (COALESCE(SUM(MAX(a.vote, 0)), 0) + 1.0)
  / (COALESCE(SUM(ABS(a.vote)), 0) + 2.0)
  * 2 - 1
`;

/**
 * Per-topic stats for the API/UI: preference, votes, article count.
 * `maxSuggested` (falsy = skip) marks each topic `suggested: true/false` -
 * whether it's among the top-`maxSuggested` most-used topics that actually
 * ride in the classification prompt (`existingTopicNames`, same function,
 * same ranking, so this can never drift from what the LLM is really shown).
 * A topic outside that cap can still get used - the model can name it
 * anyway and `normalizeTopics` has no restriction - `suggested: false` just
 * means it isn't *offered* as a suggestion, not that it's unusable.
 */
export function topicPrefs(db, maxSuggested) {
  const rows = db.prepare(`
    SELECT t.id, t.name,
           COUNT(at.article_id) AS articles,
           COALESCE(SUM(MAX(a.vote, 0)), 0) AS up,
           COALESCE(SUM(MAX(-a.vote, 0)), 0) AS down,
           ${PREF_EXPR} AS pref
    FROM topics t
    LEFT JOIN article_topics at ON at.topic_id = t.id
    LEFT JOIN articles a ON a.id = at.article_id
    GROUP BY t.id
    ORDER BY t.name
  `).all();

  if (!maxSuggested) return rows;
  const suggested = new Set(existingTopicNames(db, maxSuggested));
  return rows.map((r) => ({ ...r, suggested: suggested.has(r.name) }));
}

/**
 * Similarity-weighted vote average of the k nearest voted articles.
 * `scratch` is a pair of same-length arrays (>= k) the caller owns and
 * reuses across every row in a sweep - maintaining the top-k highest
 * similarities by insertion into this small sorted-descending window,
 * instead of a filter+map+sort+slice that would allocate a {sim, vote}
 * object per candidate and sort the *entire* voted list on every one of
 * the ~1M row x voted-article pairs a full recompute makes (170 voted x
 * 6200 rows). Insertion is cheap here because most candidates never beat
 * the current k-th best once the window fills, and even the worst case
 * only ever shifts within the k-sized window, never the full voted list.
 * Ties keep voted's original order (matching Array.prototype.sort's
 * stable-sort semantics), since the shift condition is strict (`<`, not
 * `<=`). See DESIGN.md for the measured effect and why plain arrays, not
 * typed ones.
 *
 * `batcher` (see wasmDot.js) supplies every pairwise similarity in
 * `pairSims`, one WASM call per row instead of one JS cosine() call per
 * voted article - see DESIGN.md for why (Float16Array element access is
 * dramatically slower in JS, especially on Bun, than decoding once and
 * computing in compiled code).
 */
function knnScore(row, voted, k, scratch, batcher) {
  if (!row.text_embedding || voted.length === 0 || k === 0) return 0;
  const vec = bufToVec(row.text_embedding);
  const pairSims = batcher.query(vec);
  const { sims, votes } = scratch;
  let count = 0;

  for (let j = 0; j < voted.length; j++) {
    const v = voted[j];
    if (v.id === row.id) continue;
    const sim = Math.max(pairSims[j], 0);
    if (count < k) {
      insertDescending(sims, votes, count, sim, v.vote / 2);
      count++;
    } else if (sim > sims[k - 1]) {
      insertDescending(sims, votes, k - 1, sim, v.vote / 2);
    }
  }

  let total = 0;
  let weighted = 0;
  for (let i = 0; i < count; i++) {
    total += sims[i];
    weighted += sims[i] * votes[i];
  }
  return total === 0 ? 0 : weighted / total;
}

// Shift sim/vote into sims/votes' descending-sorted [0, insertAt] window,
// overwriting whatever was at insertAt (the first free slot while filling,
// the worst-ranked slot once full - either way, the entry being replaced).
function insertDescending(sims, votes, insertAt, sim, vote) {
  let i = insertAt - 1;
  while (i >= 0 && sims[i] < sim) {
    sims[i + 1] = sims[i];
    votes[i + 1] = votes[i];
    i--;
  }
  sims[i + 1] = sim;
  votes[i + 1] = vote;
}

function votedArticles(db) {
  return db.prepare(`
    SELECT id, vote, text_embedding FROM articles
    WHERE vote != 0 AND text_embedding IS NOT NULL
  `).all().map((r) => ({ id: r.id, vote: r.vote, vec: bufToVec(r.text_embedding) }));
}

function makeKnnScratch(k) {
  return { sims: new Array(k), votes: new Array(k) };
}

// A null batcher when there's no voted set to compare against - knnScore's
// own `voted.length === 0` guard means it's never actually dereferenced,
// but avoids creating (and needing to free) an empty WASM batcher.
function makeVotedBatcher(voted) {
  if (voted.length === 0) return null;
  return createDotBatcher(voted.map((v) => v.vec), voted[0].vec.length);
}

function scoreParts(row, topicPref, feedPref, voted, weights, knn, scratch, batcher) {
  const topics = weights.topics * (topicPref ?? 0);
  const embedding = weights.embedding * knnScore(row, voted, knn, scratch, batcher);
  const depth = weights.depth * (row.depth ? (row.depth - 3) / 2 : 0);
  const feed = weights.feed * (feedPref ?? 0);
  return { topics, embedding, depth, feed, total: topics + embedding + depth + feed };
}

const SAVE_SCORE = `
  UPDATE articles
  SET score_topics = ?, score_embedding = ?, score_depth = ?, score_feed = ?, score = ?
  WHERE id = ?
`;

/**
 * Recompute every article's score. Expensive — O(articles × votes) — since
 * one new vote can shift any article's kNN term, not just the voted one.
 * Called after classification batches (fresh depth/topics need scoring) and
 * by the debounced vote-driven recompute (see recomputeIfDue below); never
 * synchronously from the vote request itself — see DESIGN.md.
 *
 * Async and chunked: processes rows in bursts of at most `yieldEveryMs` of
 * wall-clock work, each burst its own SQLite transaction, awaiting a
 * `setTimeout(0)` between bursts so the event loop (and any concurrent
 * request, e.g. a vote) gets a turn — see DESIGN.md for the ~48s measurement
 * that made this necessary. `topicPref`/`feedPref`/`voted` are snapshotted
 * once up front, same as before chunking; a vote that lands mid-run won't
 * be reflected until the *next* recompute (its own instant recomputeOneScore
 * still applies immediately, and may be transiently overwritten by a
 * still-in-flight sweep's stale value until then — accepted, self-correcting
 * tradeoff, documented in DESIGN.md).
 */
export async function recomputeScores(db, config, { yieldEveryMs = DEFAULT_YIELD_MS } = {}) {
  const start = performance.now();
  const { weights, knn } = config.scoring;

  const topicPref = new Map(db.prepare(`
    WITH tp AS (
      SELECT at.topic_id AS topic_id, ${PREF_EXPR} AS pref
      FROM article_topics at
      JOIN articles a ON a.id = at.article_id
      GROUP BY at.topic_id
    )
    SELECT at2.article_id AS id, AVG(tp.pref) AS pref
    FROM article_topics at2
    JOIN tp ON tp.topic_id = at2.topic_id
    GROUP BY at2.article_id
  `).all().map((r) => [r.id, r.pref]));

  const feedPref = new Map(db.prepare(`
    SELECT a.feed_id AS id, ${PREF_EXPR} AS pref
    FROM articles a GROUP BY a.feed_id
  `).all().map((r) => [r.id, r.pref]));

  const rows = db.prepare(
    'SELECT id, feed_id, vote, depth, text_embedding FROM articles',
  ).all();
  const voted = votedArticles(db);
  const scratch = makeKnnScratch(knn);
  const batcher = makeVotedBatcher(voted);

  try {
    const save = db.prepare(SAVE_SCORE);
    let i = 0;
    while (i < rows.length) {
      const chunkStart = performance.now();
      db.transaction(() => {
        // do/while: always process at least one row per chunk before
        // checking the time budget, so yieldEveryMs=0 (or any value too
        // small to survive a single row) can't spin forever without i ever
        // advancing.
        do {
          const row = rows[i++];
          const s = scoreParts(row, topicPref.get(row.id), feedPref.get(row.feed_id), voted, weights, knn, scratch, batcher);
          save.run(s.topics, s.embedding, s.depth, s.feed, s.total, row.id);
        } while (i < rows.length && performance.now() - chunkStart < yieldEveryMs);
      })();
      if (i < rows.length) await sleep(0);
    }
  } finally {
    batcher?.free();
  }
  return { count: rows.length, ms: performance.now() - start };
}

/**
 * Recompute a single article's own score — cheap, scoped queries only
 * (this article's topics, its feed, the — usually small — voted set), no
 * full-corpus scan. Gives instant feedback on the article you just voted
 * on, while the ripple to every *other* article's score is debounced (see
 * recomputeIfDue).
 */
export function recomputeOneScore(db, config, articleId) {
  const { weights, knn } = config.scoring;

  const row = db.prepare(
    'SELECT id, feed_id, depth, text_embedding FROM articles WHERE id = ?',
  ).get(articleId);
  if (!row) return;

  const topicPref = db.prepare(`
    SELECT AVG(pref) AS pref FROM (
      SELECT at.topic_id AS topic_id, ${PREF_EXPR} AS pref
      FROM article_topics at
      JOIN articles a ON a.id = at.article_id
      WHERE at.topic_id IN (SELECT topic_id FROM article_topics WHERE article_id = ?)
      GROUP BY at.topic_id
    )
  `).get(articleId).pref;

  const feedPref = db.prepare(`
    SELECT ${PREF_EXPR} AS pref FROM articles a WHERE a.feed_id = ?
  `).get(row.feed_id).pref;

  const voted = votedArticles(db);
  const batcher = makeVotedBatcher(voted);
  try {
    const s = scoreParts(row, topicPref, feedPref, voted, weights, knn, makeKnnScratch(knn), batcher);
    db.prepare(SAVE_SCORE).run(s.topics, s.embedding, s.depth, s.feed, s.total, articleId);
  } finally {
    batcher?.free();
  }
}

const RECOMPUTE_DUE_KEY = 'score_recompute_due_at';

/**
 * Debounce a full recompute: push its due time `delaySec` into the future.
 * Persisted in the DB (not a JS timer) so a pending recompute survives an
 * app restart — whenever it's next checked (recomputeIfDue), overdue work
 * just runs immediately instead of being silently lost.
 */
export function scheduleRecompute(db, delaySec) {
  db.prepare(`
    INSERT INTO meta (key, value) VALUES ('${RECOMPUTE_DUE_KEY}',
      strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+' || ? || ' seconds'))
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `).run(delaySec);
}

/**
 * Run the debounced recompute if (and only if) its due time has passed.
 * Returns false if nothing was due, or recomputeScores' own { count, ms }
 * result if it ran.
 */
export async function recomputeIfDue(db, config, opts) {
  const due = db.prepare(`
    SELECT 1 FROM meta
    WHERE key = '${RECOMPUTE_DUE_KEY}' AND value <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `).get();
  if (!due) return false;
  const result = await recomputeScores(db, config, opts);
  clearScheduledRecompute(db);
  return result;
}

/** Drop any pending debounce marker — e.g. after a full recompute already
 *  ran for another reason (cron's post-classification sweep), which
 *  satisfies whatever a pending vote-debounce was waiting for. */
export function clearScheduledRecompute(db) {
  db.prepare('DELETE FROM meta WHERE key = ?').run(RECOMPUTE_DUE_KEY);
}
