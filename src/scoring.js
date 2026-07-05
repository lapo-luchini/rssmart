// Preference learning: a topic's preference is a Laplace-smoothed ratio of
// up/down votes over the articles carrying that topic, mapped to [-1, 1]
// (0 = no signal). An article's score is the mean preference of its topics.
// Everything derives from votes at query/recompute time — no training state.

const PREF_EXPR = `
  (COALESCE(SUM(a.vote = 1), 0) + 1.0)
  / (COALESCE(SUM(a.vote = 1), 0) + COALESCE(SUM(a.vote = -1), 0) + 2.0)
  * 2 - 1
`;

/** Recompute the materialized articles.score column from current votes. */
export function recomputeScores(db) {
  db.exec(`
    WITH tp AS (
      SELECT at.topic_id AS topic_id, ${PREF_EXPR} AS pref
      FROM article_topics at
      JOIN articles a ON a.id = at.article_id
      GROUP BY at.topic_id
    )
    UPDATE articles SET score = COALESCE(
      (SELECT AVG(tp.pref)
       FROM article_topics at2
       JOIN tp ON tp.topic_id = at2.topic_id
       WHERE at2.article_id = articles.id),
      0
    )
  `);
}

/** Per-topic stats for the API/UI: preference, votes, article count. */
export function topicPrefs(db) {
  return db.prepare(`
    SELECT t.id, t.name,
           COUNT(at.article_id) AS articles,
           COALESCE(SUM(a.vote = 1), 0) AS up,
           COALESCE(SUM(a.vote = -1), 0) AS down,
           ${PREF_EXPR} AS pref
    FROM topics t
    LEFT JOIN article_topics at ON at.topic_id = t.id
    LEFT JOIN articles a ON a.id = at.article_id
    GROUP BY t.id
    ORDER BY t.name
  `).all();
}
