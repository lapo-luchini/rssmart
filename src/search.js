import { cosine, bufToVec } from './enrich.js';

/**
 * Rank articles matching a SQL filter by cosine similarity to a natural-
 * language query, embedded with the same model (and query-side task
 * prefix) used to store article vectors. Only articles that already have
 * a text_embedding are candidates — pending/error articles are silently
 * excluded, the same as they are from any other filtered view.
 *
 * Duplicate groups collapse to their best-matching member, mirroring how
 * normal browsing groups by interest score — except here the group's
 * representative is whichever version is the closest textual match, which
 * can differ from the highest-scoring one.
 *
 * Returns entries ({id, similarity}), most relevant first. Brute-force
 * cosine over whatever the filter selects; see DESIGN.md for why this is
 * fine at this project's scale and what to do if it ever isn't.
 */
export async function semanticSearch(db, llm, queryText, { whereSql, params, grouped }) {
  const filterSql = whereSql
    ? `${whereSql} AND a.text_embedding IS NOT NULL`
    : 'WHERE a.text_embedding IS NOT NULL';
  const rows = db.prepare(`
    SELECT a.id, a.duplicate_of, a.text_embedding FROM articles a ${filterSql}
  `).all(...params);
  if (rows.length === 0) return [];

  const queryVec = await llm.embed(queryText, 'query');
  const scored = rows.map((r) => ({
    id: r.id,
    root: r.duplicate_of ?? r.id,
    similarity: cosine(queryVec, bufToVec(r.text_embedding)),
  }));

  if (!grouped) {
    return scored.sort((a, b) => b.similarity - a.similarity);
  }
  const bestPerGroup = new Map();
  for (const s of scored) {
    const current = bestPerGroup.get(s.root);
    if (!current || s.similarity > current.similarity) bestPerGroup.set(s.root, s);
  }
  return [...bestPerGroup.values()].sort((a, b) => b.similarity - a.similarity);
}
