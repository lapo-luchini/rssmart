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

/** Recompute the materialized score components from current votes. */
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
  const voted = rows
    .filter((r) => r.vote !== 0 && r.text_embedding)
    .map((r) => ({ id: r.id, vote: r.vote, vec: bufToVec(r.text_embedding) }));

  const save = db.prepare(`
    UPDATE articles
    SET score_topics = ?, score_embedding = ?, score_depth = ?, score_feed = ?,
        score = ?
    WHERE id = ?
  `);
  db.transaction(() => {
    for (const row of rows) {
      const topics = weights.topics * (topicPref.get(row.id) ?? 0);
      const embedding = weights.embedding * knnScore(row, voted, knn);
      const depth = weights.depth * (row.depth ? (row.depth - 3) / 2 : 0);
      const feed = weights.feed * (feedPref.get(row.feed_id) ?? 0);
      save.run(topics, embedding, depth, feed,
        topics + embedding + depth + feed, row.id);
    }
  })();
}
