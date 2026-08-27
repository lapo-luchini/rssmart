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
import { markExpectedStall, clearExpectedStall } from './lagWatchdog.js';

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
// With optional recency decay: vote × 2^(-age / halflife) via exp/ln in SQL.
function decayedVoteExpr(alias = 'a', halflifeYears) {
  if (!halflifeYears) return `${alias}.vote`;
  return `${alias}.vote * exp(-ln(2) * (julianday('now') - julianday(COALESCE(${alias}.voted_at, ${alias}.created_at))) / (${halflifeYears} * 365.25))`;
}

function makePrefExpr(halflifeYears) {
  const v = decayedVoteExpr('a', halflifeYears);
  return `
    (COALESCE(SUM(MAX(${v}, 0)), 0) + 1.0)
    / (COALESCE(SUM(ABS(${v})), 0) + 2.0)
    * 2 - 1
  `;
}

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
// Cache for topicPrefs — version key detects vote, enrichment, and
// merge changes so the aggregation query only runs when needed.
let _topicPrefsKey = null;
let _topicPrefsCache = null;

export function topicPrefs(db, maxSuggested, halflifeYears) {
  const state = db.prepare(`
    SELECT COALESCE(SUM(vote != 0), 0) AS voteCount,
           COALESCE(SUM(status = 'enriched'), 0) AS enrichedCount,
           (SELECT COUNT(*) FROM topic_aliases) AS aliasCount
    FROM articles
  `).get();
  const key = `${state.voteCount}:${state.enrichedCount}:${state.aliasCount}:${maxSuggested ?? ''}:${halflifeYears ?? ''}`;

  if (_topicPrefsKey === key) return _topicPrefsCache;

  const decayedVote = decayedVoteExpr('a', halflifeYears);
  const rows = db.prepare(`
    SELECT t.id, t.name,
           COUNT(at.article_id) AS articles,
           COALESCE(SUM(MAX(${decayedVote}, 0)), 0) AS up,
           COALESCE(SUM(MAX(-${decayedVote}, 0)), 0) AS down,
           COALESCE(SUM(MAX(a.vote, 0)), 0) AS up_raw,
           COALESCE(SUM(MAX(-a.vote, 0)), 0) AS down_raw,
           ${makePrefExpr(halflifeYears)} AS pref
    FROM topics t
    LEFT JOIN article_topics at ON at.topic_id = t.id
    LEFT JOIN articles a INDEXED BY idx_articles_id_vote ON a.id = at.article_id
    GROUP BY t.id
    ORDER BY t.name
  `).all();

  // existingTopicNames computed once, not once per row (was a 552-topic
  // N+1: each call re-runs its own topics/article_topics aggregation —
  // ~42ms x 552 rows measured live, ~23s of pure duplicate work).
  const result = !maxSuggested
    ? rows
    : (() => {
        const suggested = new Set(existingTopicNames(db, maxSuggested));
        return rows.map((r) => ({ ...r, suggested: suggested.has(r.name) }));
      })();

  _topicPrefsKey = key;
  _topicPrefsCache = result;
  return result;
}

/**
 * Top-k insertion into a descending-sorted window of `{sims, votes}` at
 * position `insertAt` (the first free slot while filling, the worst rank
 * once full). Reused across every row in a sweep — see DESIGN.md for why
 * the top-k-per-row allocation is dramatically more expensive than this
 * in-place insertion.
 */
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

/**
 * Similarity-weighted average of a filled top-k heap, or null when empty.
 */
function heapAverage(sims, votes, count) {
  let total = 0;
  let weighted = 0;
  for (let i = 0; i < count; i++) {
    total += sims[i];
    weighted += sims[i] * votes[i];
  }
  return total === 0 ? null : weighted / total;
}

function topicOverlap(a, b) {
  for (const t of a) { if (b.has(t)) return true; }
  return false;
}

/**
 * One fused pass over the batcher's pairSims fills every term that derives
 * from them:
 * - up/down kNN heaps (anti-kNN: separate similarity-weighted averages for
 *   upvoted and downvoted articles, combined as up − down by the caller, so
 *   a small cluster of downvoted articles can strongly suppress similar
 *   content even when upvotes vastly outnumber downvotes);
 * - topic-neighbor preference: among voted articles sharing at least one
 *   topic with the article being scored, a similarity-weighted vote average
 *   (captures intra-topic preference differences — e.g. within "security"
 *   you upvote exploit techniques but downvote CVE announcements);
 * - max similarity over all candidates (self included — a voted article is
 *   trivially identical to itself), feeding the exploratory bonus and
 *   novelty.
 * Previously these were four separate O(voted) passes (up filter, down
 * filter, topic overlap, max scan) re-walking the same arrays for every
 * article, with max(pairSims[j], 0) computed up to three times per
 * candidate; fusing them quarters the hot loop's work.
 */
function knnTerms(pairSims, voted, rowId, k, scratches, rowTopics, topicMap) {
  const up = scratches.up;
  const down = scratches.down;
  let upCount = 0;
  let downCount = 0;
  let simSum = 0;
  let weightedSum = 0;
  let maxSim = 0;

  for (let j = 0; j < voted.length; j++) {
    const raw = pairSims[j];
    if (raw > maxSim) maxSim = raw;
    const v = voted[j];
    if (v.id === rowId || raw <= 0) continue;
    const vote = v.vote;
    if (vote > 0) {
      if (upCount < k) {
        insertDescending(up.sims, up.votes, upCount, raw, vote / 2);
        upCount++;
      } else if (raw > up.sims[k - 1]) {
        insertDescending(up.sims, up.votes, k - 1, raw, vote / 2);
      }
    } else {
      if (downCount < k) {
        insertDescending(down.sims, down.votes, downCount, raw, -vote / 2);
        downCount++;
      } else if (raw > down.sims[k - 1]) {
        insertDescending(down.sims, down.votes, k - 1, raw, -vote / 2);
      }
    }
    if (rowTopics) {
      const vTopics = topicMap.get(v.id);
      if (vTopics && topicOverlap(rowTopics, vTopics)) {
        simSum += raw;
        weightedSum += raw * (vote / 2);
      }
    }
  }

  return {
    up: heapAverage(up.sims, up.votes, upCount),
    down: heapAverage(down.sims, down.votes, downCount),
    topicNeighbor: simSum > 0 ? weightedSum / simSum : null,
    maxSim,
  };
}

function votedArticles(db, halflifeYears) {
  const rows = db.prepare(`
    SELECT id, vote, text_embedding, COALESCE(voted_at, created_at) AS vote_time
    FROM articles
    WHERE vote != 0 AND text_embedding IS NOT NULL
  `).all();

  if (!halflifeYears) {
    return rows.map((r) => ({ id: r.id, vote: r.vote, vec: bufToVec(r.text_embedding) }));
  }

  const now = Date.now();
  const ln2OverHalflifeMs = Math.LN2 / (halflifeYears * 365.25 * 86400000);
  return rows.map((r) => {
    const age = now - new Date(r.vote_time).getTime();
    const decay = age > 0 ? Math.exp(-ln2OverHalflifeMs * age) : 1;
    return { id: r.id, vote: r.vote * decay, vec: bufToVec(r.text_embedding) };
  });
}

function makeKnnScratches(k) {
  return {
    up: { sims: new Array(k), votes: new Array(k) },
    down: { sims: new Array(k), votes: new Array(k) },
  };
}

/**
 * Exploratory bonus: articles whose embedding is far from all voted
 * articles get a small positive lift (0.05). This prevents the system
 * from only ever surfacing content similar to what you already know,
 * helping serendipitous discovery on unvoted topics or styles.
 */
function exploratoryBonus(maxSim) {
  return maxSim < 0.3 ? 0.05 : 0;
}

// A null batcher when there's no voted set to compare against - knnScore's
// own `voted.length === 0` guard means it's never actually dereferenced,
// but avoids creating (and needing to free) an empty WASM batcher.
function makeVotedBatcher(voted, reuse) {
  if (voted.length === 0) return null;
  return createDotBatcher(voted.map((v) => v.vec), voted[0].vec.length, reuse);
}

// Cache for recomputeOneScore: reuses the voted set and WASM batcher across
// consecutive calls, keyed by db instance (not a single global) so unrelated
// test databases never share state. Marked stale via `dirty` (not freed
// outright) when a vote changes the set — the previous design (a hard
// clearSingleScoreBatcher() called right before every rebuild) froze then
// nulled the batcher first, so every single vote paid for a fresh WASM
// alloc_f32 instead of recycling the still-live buffer. Keeping it alive
// until the next rebuild lets createDotBatcher's `reuse` path recycle it as
// intended, avoiding fragmenting WASM linear memory over long-running serve
// sessions.
const _singleScoreCaches = new WeakMap(); // db -> { batcher, voted, halflife, dirty }

function getSingleScoreBatcher(db, halflifeYears) {
  let state = _singleScoreCaches.get(db);
  if (!state) {
    state = { batcher: null, voted: null, halflife: null, dirty: false };
    _singleScoreCaches.set(db, state);
  }
  if (!state.batcher || state.halflife !== halflifeYears || state.dirty) {
    const old = state.batcher;
    state.voted = votedArticles(db, halflifeYears);
    state.batcher = makeVotedBatcher(state.voted, old);
    state.halflife = halflifeYears;
    state.dirty = false;
  }
  return { voted: state.voted, batcher: state.batcher };
}

/** Mark the cached voted set stale after a vote — rebuilt lazily on the next
 *  recomputeOneScore call, reusing the still-live WASM buffer instead of
 *  freeing it up front. */
export function invalidateSingleScoreBatcher(db) {
  const state = _singleScoreCaches.get(db);
  if (state) state.dirty = true;
}

function scoreParts(row, topicPref, feedPref, authorPref, voted, weights, knn, scratches, batcher, topicMap) {
  // One batcher query + one fused pass fill the embedding kNN, the
  // topic-neighbor term, and the exploratory bonus/novelty below.
  let embedding = 0;
  let topicNeighbor = null;
  let bonus = 0;
  // How different this article is from everything voted on so far (1 -
  // highest similarity to any voted article) -- null, not 0, when there's
  // no basis for a real answer (no embedding yet, or nothing voted at all
  // to compare against), so an "explore" sort can tell "actually novel"
  // apart from "unknown" instead of treating both the same.
  let novelty = null;

  if (row.text_embedding && voted.length > 0) {
    const vec = bufToVec(row.text_embedding);
    const pairSims = batcher.query(vec);
    const rowTopics = topicMap.get(row.id);
    const terms = knnTerms(pairSims, voted, row.id, knn, scratches,
      rowTopics && rowTopics.size > 0 ? rowTopics : null, topicMap);
    // k = 0 leaves both heaps empty -> both averages null -> 0.
    const combined = (terms.up ?? 0) - (terms.down ?? 0);
    embedding = weights.embedding * Math.max(-1, Math.min(1, combined));
    topicNeighbor = terms.topicNeighbor;
    bonus = exploratoryBonus(terms.maxSim);
    novelty = 1 - terms.maxSim;
  }

  // Topic signal: blend aggregate preference (from the article's topic
  // labels) with the embedding-weighted preference of same-topic voted
  // articles. Within a broad topic like "security" this separates
  // sub-categories you feel differently about.
  const topicBase = topicPref ?? 0;
  const blendedTopic = topicNeighbor != null
    ? topicBase * 0.7 + topicNeighbor * 0.3
    : topicBase;
  const topics = weights.topics * blendedTopic;

  const depth = weights.depth * (row.depth ? (row.depth - 3) / 2 : 0);

  // Feed and author are blended when both exist: 70% source record,
  // 30% author record.
  let feed = weights.feed * (feedPref ?? 0);
  if (authorPref != null && row.author) {
    feed = feed * 0.7 + weights.feed * authorPref * 0.3;
  }

  // Exploratory bonus lifts unfamiliar content above the noise floor.
  const total = topics + embedding + depth + feed + bonus;

  return { topics, embedding, depth, feed, bonus, novelty, total };
}

const SAVE_SCORE = `
  UPDATE articles
  SET score_topics = ?, score_embedding = ?, score_depth = ?, score_feed = ?, score_bonus = ?, score_novelty = ?, score = ?
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
  // Annotates (never silences) any watchdog stall log line that fires
  // during this sweep -- including the unchunked setup below, still a
  // real single-block cost -- so a reader sees it's the known, bounded
  // recompute cost, not a signal to go investigate a new regression.
  markExpectedStall('recomputing scores');
  try {
    const { weights, knn, voteDecayHalflifeYears: halflife } = config.scoring;

    const pref = makePrefExpr(halflife);

    const topicPref = new Map(db.prepare(`
      WITH tp AS (
        SELECT at.topic_id AS topic_id, ${pref} AS pref
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
      SELECT a.feed_id AS id, ${pref} AS pref
      FROM articles a GROUP BY a.feed_id
    `).all().map((r) => [r.id, r.pref]));

    const authorPref = new Map(db.prepare(`
      SELECT a.author AS name, ${pref} AS pref
      FROM articles a
      WHERE a.author IS NOT NULL AND a.author != ''
      GROUP BY a.author
    `).all().map((r) => [r.name, r.pref]));

    const rows = db.prepare(
      'SELECT id, feed_id, vote, depth, text_embedding, author FROM articles',
    ).all();
    const voted = votedArticles(db, halflife);
    const scratches = makeKnnScratches(knn);

    // Load article-to-topics mapping for topic-neighbor scoring.
    const topicMap = new Map();
    for (const r of db.prepare(`
      SELECT at.article_id, t.name FROM article_topics at
      JOIN topics t ON t.id = at.topic_id
    `).all()) {
      let s = topicMap.get(r.article_id);
      if (!s) { s = new Set(); topicMap.set(r.article_id, s); }
      s.add(r.name);
    }

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
            const s = scoreParts(row, topicPref.get(row.id), feedPref.get(row.feed_id),
              authorPref.get(row.author), voted, weights, knn, scratches, batcher, topicMap);
            save.run(s.topics, s.embedding, s.depth, s.feed, s.bonus, s.novelty, s.total, row.id);
          } while (i < rows.length && performance.now() - chunkStart < yieldEveryMs);
        })();
        if (i < rows.length) await sleep(0);
      }
    } finally {
      batcher?.free();
    }
    return { count: rows.length, ms: performance.now() - start };
  } finally {
    clearExpectedStall();
  }
}

/**
 * Recompute a single article's own score — cheap, scoped queries only
 * (this article's topics, its feed, the — usually small — voted set), no
 * full-corpus scan. Gives instant feedback on the article you just voted
 * on, while the ripple to every *other* article's score is debounced (see
 * recomputeIfDue).
 */
export function recomputeOneScore(db, config, articleId) {
  const { weights, knn, voteDecayHalflifeYears: halflife } = config.scoring;
  const pref = makePrefExpr(halflife);

  const row = db.prepare(
    'SELECT id, feed_id, depth, text_embedding, author FROM articles WHERE id = ?',
  ).get(articleId);
  if (!row) return;

  const topicPref = db.prepare(`
    SELECT AVG(pref) AS pref FROM (
      SELECT at.topic_id AS topic_id, ${pref} AS pref
      FROM article_topics at
      JOIN articles a ON a.id = at.article_id
      WHERE at.topic_id IN (SELECT topic_id FROM article_topics WHERE article_id = ?)
      GROUP BY at.topic_id
    )
  `).get(articleId).pref;

  const feedPref = db.prepare(`
    SELECT ${pref} AS pref FROM articles a WHERE a.feed_id = ?
  `).get(row.feed_id).pref;

  let authorPref = null;
  if (row.author) {
    const r = db.prepare(`SELECT ${pref} AS pref FROM articles a WHERE a.author = ?`).get(row.author);
    if (r) authorPref = r.pref;
  }

  const { voted, batcher } = getSingleScoreBatcher(db, halflife);

  // Build topic map for topic-neighbor scoring — batch load voted article topics.
  const topicMap = new Map();
  const rowTopics = db.prepare(`
    SELECT t.name FROM article_topics at JOIN topics t ON t.id = at.topic_id WHERE at.article_id = ?
  `).all(articleId).map((r) => r.name);
  topicMap.set(articleId, new Set(rowTopics));
  const votedIds = voted.filter((v) => v.id !== articleId).map((v) => v.id);
  if (votedIds.length) {
    for (const r of db.prepare(`
      SELECT at.article_id, t.name FROM article_topics at
      JOIN topics t ON t.id = at.topic_id
      WHERE at.article_id IN (${votedIds.map(() => '?').join(',')})
    `).all(...votedIds)) {
      let s = topicMap.get(r.article_id);
      if (!s) { s = new Set(); topicMap.set(r.article_id, s); }
      s.add(r.name);
    }
  }
  const s = scoreParts(row, topicPref, feedPref, authorPref, voted, weights, knn, makeKnnScratches(knn), batcher, topicMap);
  db.prepare(SAVE_SCORE).run(s.topics, s.embedding, s.depth, s.feed, s.bonus, s.novelty, s.total, articleId);
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
