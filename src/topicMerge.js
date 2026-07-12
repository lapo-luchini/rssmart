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

Some of these are redundant: literally the same concept, written differently
— a translation, spelling/hyphenation variant, abbreviation, or synonym at
the exact IDENTICAL scope (e.g. "ai" and "artificial-intelligence", or "eu"
and "european-union"). Find genuinely redundant pairs like that and propose
collapsing each "from" topic into one canonical "to" topic.

The test is scope, not casual usage: would merging them ever make an
article's topic broader or narrower than it already was? If yes, do NOT
merge, even if the two names are sometimes used loosely/interchangeably in
general news writing — that kind of casual conflation is exactly the trap,
not a justification. For example: "laptops" and "hardware" are NOT the same
topic (laptops are one specific kind of hardware) — do not merge. "hardware"
and "computing" are NOT the same topic (computing is much broader) — do not
merge. Neither are "artificial intelligence" and "machine learning" (machine
learning is a narrower subfield of AI), nor "information technology" and
"technology" (IT is a subset of the broader field), nor "computer science"
and "computing" (computing is broader) — all of these are broader/narrower
pairs, not synonyms, even though a news article might use them
interchangeably. Also skip anything merely related but conceptually
distinct at the same level (e.g. "sports" and "esports" are NOT the same
topic, nor are "javascript" and "nodejs").

When genuinely unsure whether two topics are identical in scope or a
broader/narrower pair, do not propose the merge — a missed merge costs
nothing, a wrong one silently blends two topics' vote history together.
Prefer the clearer or more commonly used name as the canonical "to". Never
propose merging a topic into itself, and never propose the same "from"
topic in more than one merge.

Critical: the "merges" array must contain ONLY pairs you are actually
proposing. If you consider a pair and decide it should NOT be merged, leave
it out of the array entirely — do not include it with a "reason" explaining
why you're rejecting it. Every single entry in "merges" is treated as an
endorsed proposal, exactly as written, regardless of what its "reason" says.

Answer with JSON: {"merges": [{"from": "...", "to": "...", "reason": "..."}]}`;
}

// Phrases that mean the model's own reason contradicts the merge it just
// proposed (observed live: the model sometimes writes "...skipping merge"
// or "these should remain separate" right in "reason", yet still includes
// the pair in "merges" — the prompt above now tells it not to, but this
// still flags it if a model does it anyway). The LLM call is the expensive
// part of this whole operation, so a flagged proposal is shown, dimmed, for
// the reader's own judgment — never silently discarded: it already cost
// the time to generate, and the reader is the one deciding either way.
const SELF_REJECTION = /\b(skip(ping)?|not (a )?synonyms?|(should|do) not merge|remain separate|keep(ing)? (them |it )?separate|distinct enough)\b/i;

/** Keep every proposal that names two different, real, known topics (drop
 *  any repeat "from" — first proposal for a given "from" wins), flagging
 *  ones whose own reason contradicts the merge rather than dropping them. */
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
    const reason = typeof m.reason === 'string' ? m.reason.trim().slice(0, 200) : '';
    out.push({ from, to, reason, lowConfidence: SELF_REJECTION.test(reason) });
  }
  return out;
}

/**
 * Ask the LLM to find redundant topics among the full vocabulary (not the
 * capped suggestion list enrichOne uses — the long, rarely-used tail is
 * exactly where duplicates accumulate) and propose collapsing each into a
 * canonical survivor. Returns proposals only; nothing is applied.
 * timeoutMs should be generous (see ollama.topicMergeTimeoutMs) — reasoning
 * over the whole vocabulary at once is much slower than classifying one
 * article, and this is a rare, reader-initiated call, not a hot path.
 */
export async function proposeTopicMerges(db, llm, timeoutMs) {
  const topics = existingTopicNames(db, 0);
  if (topics.length < 2) return [];
  const reply = await llm.chatJSON(SYSTEM, mergePrompt(topics), { timeoutMs });
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
