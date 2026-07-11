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

import { cosine, bufToVec } from './enrich.js';

// Votes range -2..+2 ("WOW" votes count double). The Laplace ratio works on
// the weighted magnitudes: SUM(MAX(v,0)) up-weight vs SUM(ABS(v)) total.
const PREF_EXPR = `
  (COALESCE(SUM(MAX(a.vote, 0)), 0) + 1.0)
  / (COALESCE(SUM(ABS(a.vote)), 0) + 2.0)
  * 2 - 1
`;

/** Per-topic stats for the API/UI: preference, votes, article count. */
export function topicPrefs(db) {
  return db.prepare(`
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
}

/** Similarity-weighted vote average of the k nearest voted articles. */
function knnScore(row, voted, k) {
  if (!row.text_embedding || voted.length === 0) return 0;
  const vec = bufToVec(row.text_embedding);
  const nearest = voted
    .filter((v) => v.id !== row.id)
    // vote / 2 normalizes the -2..+2 scale into this signal's -1..+1 range
    .map((v) => ({ sim: Math.max(cosine(vec, v.vec), 0), vote: v.vote / 2 }))
    .sort((x, y) => y.sim - x.sim)
    .slice(0, k);
  const total = nearest.reduce((s, n) => s + n.sim, 0);
  if (total === 0) return 0;
  return nearest.reduce((s, n) => s + n.sim * n.vote, 0) / total;
}

function votedArticles(db) {
  return db.prepare(`
    SELECT id, vote, text_embedding FROM articles
    WHERE vote != 0 AND text_embedding IS NOT NULL
  `).all().map((r) => ({ id: r.id, vote: r.vote, vec: bufToVec(r.text_embedding) }));
}

function scoreParts(row, topicPref, feedPref, voted, weights, knn) {
  const topics = weights.topics * (topicPref ?? 0);
  const embedding = weights.embedding * knnScore(row, voted, knn);
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
 */
export function recomputeScores(db, config) {
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

  const save = db.prepare(SAVE_SCORE);
  db.transaction(() => {
    for (const row of rows) {
      const s = scoreParts(row, topicPref.get(row.id), feedPref.get(row.feed_id), voted, weights, knn);
      save.run(s.topics, s.embedding, s.depth, s.feed, s.total, row.id);
    }
  })();
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
  const s = scoreParts(row, topicPref, feedPref, voted, weights, knn);
  db.prepare(SAVE_SCORE).run(s.topics, s.embedding, s.depth, s.feed, s.total, articleId);
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

/** Run the debounced recompute if (and only if) its due time has passed. */
export function recomputeIfDue(db, config) {
  const due = db.prepare(`
    SELECT 1 FROM meta
    WHERE key = '${RECOMPUTE_DUE_KEY}' AND value <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `).get();
  if (!due) return false;
  recomputeScores(db, config);
  clearScheduledRecompute(db);
  return true;
}

/** Drop any pending debounce marker — e.g. after a full recompute already
 *  ran for another reason (cron's post-classification sweep), which
 *  satisfies whatever a pending vote-debounce was waiting for. */
export function clearScheduledRecompute(db) {
  db.prepare('DELETE FROM meta WHERE key = ?').run(RECOMPUTE_DUE_KEY);
}
