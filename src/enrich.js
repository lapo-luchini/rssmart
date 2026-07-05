import { stripHtml } from './html.js';

export function cosine(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function bufToVec(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

const SYSTEM = 'You are a news classification assistant. Always answer with a single JSON object and nothing else.';

function classifyPrompt(existingTopics, title, text) {
  return `Classify this news article and write a very short preview.

Existing topics: ${existingTopics.length ? existingTopics.join(', ') : '(none yet)'}

Rules:
- "topics": an array of 1 to 3 topics. Strongly prefer topics from the existing list; only if none fit, invent at most one new topic name (1-2 words, lowercase English).
- "summary": a preview of at most 50 words, plain text, factual, same language as the article.

Article title: ${title}
Article content: ${text.slice(0, 2000)}

Answer with JSON: {"topics": ["..."], "summary": "..."}`;
}

function normalizeTopics(topics) {
  if (!Array.isArray(topics)) return [];
  return [...new Set(
    topics
      .filter((t) => typeof t === 'string')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0 && t.length <= 40),
  )].slice(0, 3);
}

function findDuplicate(vec, articleId, recent, threshold) {
  let duplicateOf = null;
  let best = threshold;
  for (const other of recent) {
    if (other.id === articleId) continue;
    const sim = cosine(vec, other.vec);
    if (sim >= best) {
      best = sim;
      duplicateOf = other.id;
    }
  }
  return duplicateOf;
}

/** Classify + summarize + embed one article and persist the outcome. */
async function enrichOne(db, llm, article, recent, dupThreshold) {
  const existing = db
    .prepare('SELECT name FROM topics ORDER BY name')
    .all()
    .map((r) => r.name);
  const text = stripHtml(article.content);

  const reply = await llm.chatJSON(
    SYSTEM,
    classifyPrompt(existing, article.title, text),
  );
  const topics = normalizeTopics(reply.topics);
  const summary = typeof reply.summary === 'string' ? reply.summary.trim() : '';
  if (topics.length === 0 || !summary) {
    throw new Error(`unusable LLM reply: ${JSON.stringify(reply).slice(0, 200)}`);
  }

  const vec = await llm.embed(`${article.title}\n${summary}`);
  const duplicateOf = findDuplicate(vec, article.id, recent, dupThreshold);

  const insertTopic = db.prepare(
    'INSERT INTO topics (name) VALUES (?) ON CONFLICT (name) DO UPDATE SET name = name RETURNING id',
  );
  const linkTopic = db.prepare(
    'INSERT OR IGNORE INTO article_topics (article_id, topic_id) VALUES (?, ?)',
  );
  db.transaction(() => {
    for (const name of topics) {
      const { id: topicId } = insertTopic.get(name);
      linkTopic.run(article.id, topicId);
    }
    db.prepare(`
      UPDATE articles
      SET summary = ?, embedding = ?, duplicate_of = ?, status = 'enriched'
      WHERE id = ?
    `).run(summary, Buffer.from(vec.buffer), duplicateOf, article.id);
  })();

  recent.push({ id: article.id, vec });
  return { topics, summary, duplicateOf, vec };
}

/**
 * Run the LLM pipeline over pending articles: classify topics, write a
 * ~50-word summary, embed, and mark near-duplicates of recent articles.
 * Failures leave the article pending for the next run, up to
 * enrich.maxAttempts, after which it is parked as status='error'.
 *
 * Articles are drained one at a time until none are left or opts.deadline
 * (epoch ms) passes — the current article always finishes, so the deadline
 * can overshoot by one LLM call. While opts.waitForMore() returns true
 * (e.g. ingestion still running), an empty queue polls instead of exiting,
 * so articles ingested mid-run get enriched in the same run.
 * opts.onItem, if given, is called after each article (LLM calls are slow;
 * this lets the CLI report progress live).
 */
export async function enrichPending(
  db,
  config,
  llm,
  { onItem, deadline, waitForMore, pollMs = 1000 } = {},
) {
  const { maxAttempts, dupThreshold, dupWindowDays } = config.enrich;

  if (!(await llm.available())) {
    return { skipped: true, reason: `ollama not reachable at ${llm.url}` };
  }

  // Articles already attempted in this run: a failure stays 'pending' (for
  // the NEXT run) and must not be picked again by this one.
  const tried = [];
  const nextPending = db.prepare(`
    SELECT id, title, content FROM articles
    WHERE status = 'pending' AND enrich_attempts < ?
      AND id NOT IN (SELECT value FROM json_each(?))
    ORDER BY id LIMIT 1
  `);

  // Embeddings of recent, already-enriched articles for duplicate detection.
  const recent = db.prepare(`
    SELECT id, embedding FROM articles
    WHERE embedding IS NOT NULL
      AND created_at >= datetime('now', ?)
  `).all(`-${dupWindowDays} days`)
    .map((r) => ({ id: r.id, vec: bufToVec(r.embedding) }));

  const saveFailure = db.prepare(`
    UPDATE articles
    SET enrich_attempts = enrich_attempts + 1,
        status = CASE WHEN enrich_attempts + 1 >= ? THEN 'error' ELSE 'pending' END
    WHERE id = ?
  `);

  const result = { enriched: 0, failed: 0, duplicates: 0, errors: [], timedOut: false };

  while (true) {
    if (deadline && Date.now() >= deadline) {
      result.timedOut = true;
      break;
    }
    const article = nextPending.get(maxAttempts, JSON.stringify(tried));
    if (!article) {
      if (waitForMore?.()) {
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      break;
    }
    tried.push(article.id);

    try {
      const { topics, summary, duplicateOf } =
        await enrichOne(db, llm, article, recent, dupThreshold);
      result.enriched++;
      if (duplicateOf) result.duplicates++;
      onItem?.({ id: article.id, title: article.title, topics, summary, duplicateOf });
    } catch (err) {
      saveFailure.run(maxAttempts, article.id);
      result.failed++;
      result.errors.push({ id: article.id, error: err.message });
      onItem?.({ id: article.id, title: article.title, error: err.message });
    }
  }

  return result;
}
