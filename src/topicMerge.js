import { existingTopicNames } from './enrich.js';

// Topic merges are never applied automatically: unlike a plain relabel,
// collapsing topic A into topic B retroactively blends their vote history
// (topicPrefs, src/scoring.js, computes a Laplace-smoothed ratio *per
// topic*) — a real change to historical scoring input, not just display
// text. proposeTopicMerges only suggests candidates; applyTopicMerge does
// the actual, irreversible work, and is meant to be called only after a
// reader reviews and approves each one individually.

const SYSTEM = 'You help maintain a tidy topic taxonomy for a news reader. ' +
  'Always answer with a single JSON object and nothing else.';

function mergePrompt(topics) {
  return `Here is the full list of topics currently in use, most-used first:
${topics.join(', ')}

Some of these are redundant: different names for the same underlying concept
(e.g. "ai" and "artificial-intelligence", or "eu" and "european-union").
Find genuinely redundant pairs and propose collapsing each "from" topic into
one canonical "to" topic. Only propose merges you are confident about — skip
anything merely related but conceptually distinct (e.g. "sports" and
"esports" are NOT the same topic, nor are "javascript" and "nodejs"). Prefer
the clearer or more commonly used name as the canonical "to". Never propose
merging a topic into itself, and never propose the same "from" topic in more
than one merge.

Answer with JSON: {"merges": [{"from": "...", "to": "...", "reason": "..."}]}`;
}

/** Keep only proposals that name two different, real, known topics, and
 *  drop any repeat "from" (first proposal for a given "from" wins). */
function normalizeMergeProposals(merges, knownTopics) {
  if (!Array.isArray(merges)) return [];
  const known = new Set(knownTopics.map((t) => t.toLowerCase()));
  const seen = new Set();
  const out = [];
  for (const m of merges) {
    if (!m || typeof m.from !== 'string' || typeof m.to !== 'string') continue;
    const from = m.from.trim().toLowerCase();
    const to = m.to.trim().toLowerCase();
    if (!from || !to || from === to) continue;
    if (!known.has(from) || !known.has(to)) continue;
    if (seen.has(from)) continue;
    seen.add(from);
    out.push({ from, to, reason: typeof m.reason === 'string' ? m.reason.trim().slice(0, 200) : '' });
  }
  return out;
}

/**
 * Ask the LLM to find redundant topics among the full vocabulary (not the
 * capped suggestion list enrichOne uses — the long, rarely-used tail is
 * exactly where duplicates accumulate) and propose collapsing each into a
 * canonical survivor. Returns proposals only; nothing is applied.
 */
export async function proposeTopicMerges(db, llm) {
  const topics = existingTopicNames(db, 0);
  if (topics.length < 2) return [];
  const reply = await llm.chatJSON(SYSTEM, mergePrompt(topics));
  return normalizeMergeProposals(reply.merges, topics);
}

/**
 * Apply one approved merge: every article tagged `fromName` is retagged
 * `toName` instead (an article already tagged with both collapses to one
 * row), `fromName`'s topic is deleted, and the mapping is recorded in
 * topic_aliases so a future classification naming `fromName` again
 * redirects to `toName` automatically (see resolveTopicId, src/enrich.js).
 * Any alias that already pointed at `fromName` is repointed at `toName` too,
 * so a chain of merges (A -> B, later B -> C) still resolves to the final
 * canonical topic. Both names must already exist and be different; throws
 * otherwise rather than silently doing nothing.
 */
export function applyTopicMerge(db, fromName, toName) {
  const from = db.prepare('SELECT id FROM topics WHERE name = ? COLLATE NOCASE').get(fromName);
  const to = db.prepare('SELECT id FROM topics WHERE name = ? COLLATE NOCASE').get(toName);
  if (!from) throw new Error(`unknown topic "${fromName}"`);
  if (!to) throw new Error(`unknown topic "${toName}"`);
  if (from.id === to.id) throw new Error(`"${fromName}" and "${toName}" are the same topic`);

  db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO article_topics (article_id, topic_id)
      SELECT article_id, ? FROM article_topics WHERE topic_id = ?
    `).run(to.id, from.id);
    db.prepare('DELETE FROM article_topics WHERE topic_id = ?').run(from.id);
    db.prepare('UPDATE topic_aliases SET canonical_topic_id = ? WHERE canonical_topic_id = ?')
      .run(to.id, from.id);
    db.prepare(`
      INSERT INTO topic_aliases (alias_name, canonical_topic_id) VALUES (?, ?)
      ON CONFLICT (alias_name) DO UPDATE SET canonical_topic_id = excluded.canonical_topic_id
    `).run(fromName.trim().toLowerCase(), to.id);
    db.prepare('DELETE FROM topics WHERE id = ?').run(from.id);
  })();
}
