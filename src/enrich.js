import { stripHtml } from './html.js';
import { fetchArticleText } from './fetchpage.js';

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

function classifyPrompt(existingTopics, title, text, maxInputChars) {
  return `Classify this news article and write a very short preview.

Existing topics: ${existingTopics.length ? existingTopics.join(', ') : '(none yet)'}

Rules:
- "topics": an array of 1 to 3 topics. Strongly prefer topics from the existing list; only if none fit, invent at most one new topic name (1-2 words, lowercase English).
- "summary": a preview of at most 50 words, plain text, factual, same language as the article. Cover the article as a whole, not just its opening.
- "depth": an integer 1-5 rating substance and craft: 5 = deep original reporting or analysis by an author who clearly knows the field, 3 = solid routine coverage, 1 = a thin, low-effort rehash.

Article title: ${title}
Article content: ${sampleText(text, maxInputChars)}

Answer with JSON: {"topics": ["..."], "summary": "...", "depth": 3}`;
}

/**
 * Fit text into budget chars. Long articles keep their head AND tail — a
 * long essay's opening often doesn't name its real subject, its conclusion
 * almost always does.
 */
export function sampleText(text, budget) {
  if (text.length <= budget) return text;
  const head = Math.floor(budget * 0.6);
  const tail = budget - head;
  return `${text.slice(0, head)}\n[... middle of the article omitted ...]\n${text.slice(-tail)}`;
}

/** Context window needed for the prompt (~3 chars/token) plus headroom. */
function contextTokens(maxInputChars) {
  return Math.max(4096, Math.ceil((maxInputChars / 3 + 1000) / 1024) * 1024);
}

function normalizeTopics(topics) {
  if (typeof topics === 'string') topics = [topics];
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

/**
 * The text the LLM sees: the origin page's readable content when the RSS
 * entry is too thin (fetched once and stored), the RSS content otherwise.
 */
async function articleText(db, article, enrichCfg) {
  if (article.full_content) return stripHtml(article.full_content);
  const rssText = stripHtml(article.content);
  const { fetchMinChars, allowPrivateFetch } = enrichCfg;
  if (!article.url || !fetchMinChars || rssText.length >= fetchMinChars) {
    return rssText;
  }
  const page = await fetchArticleText(article.url, {
    allowPrivate: allowPrivateFetch,
  });
  if (!page) return rssText;
  // Persist immediately so a later classify failure doesn't refetch.
  db.prepare('UPDATE articles SET full_content = ? WHERE id = ?')
    .run(page.html, article.id);
  return page.text;
}

/** Classify + summarize + embed one article and persist the outcome. */
async function enrichOne(db, llm, article, recent, enrichCfg) {
  const existing = db
    .prepare('SELECT name FROM topics ORDER BY name')
    .all()
    .map((r) => r.name);
  const text = await articleText(db, article, enrichCfg);

  const { maxInputChars } = enrichCfg;
  const reply = await llm.chatJSON(
    SYSTEM,
    classifyPrompt(existing, article.title, text, maxInputChars),
    { numCtx: contextTokens(maxInputChars) },
  );
  // Models occasionally drift on key names ("topic" for "topics").
  const topics = normalizeTopics(reply.topics ?? reply.topic);
  if (topics.length === 0) {
    throw new Error(`unusable LLM reply: ${JSON.stringify(reply).slice(0, 200)}`);
  }
  // At temperature 0 a model that omits the summary will omit it on every
  // retry too — fall back to the article's opening words instead of parking.
  let summary = typeof reply.summary === 'string' ? reply.summary.trim() : '';
  if (!summary) {
    summary = text.split(/\s+/).slice(0, 45).join(' ') || article.title;
  }

  const depthNum = Math.round(Number(reply.depth));
  const depth = depthNum >= 1 && depthNum <= 5 ? depthNum : null;

  // Two embeddings with different jobs: the summary embedding is stylistically
  // uniform (our own voice) and drives duplicate detection; the raw-text
  // embedding keeps the article's own register for similarity-based scoring.
  const vec = await llm.embed(`${article.title}\n${summary}`);
  const textVec = await llm.embed(`${article.title}\n${sampleText(text, 4000)}`);
  const duplicateOf = findDuplicate(vec, article.id, recent, enrichCfg.dupThreshold);

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
      SET summary = ?, embedding = ?, text_embedding = ?, depth = ?,
          duplicate_of = ?, status = 'enriched'
      WHERE id = ?
    `).run(
      summary,
      Buffer.from(vec.buffer),
      Buffer.from(textVec.buffer),
      depth,
      duplicateOf,
      article.id,
    );
  })();

  recent.push({ id: article.id, vec });
  return { topics, summary, depth, duplicateOf, vec };
}

/**
 * Run the LLM pipeline over pending articles: classify topics, write a
 * ~50-word summary, embed, and mark near-duplicates of recent articles.
 * Failures leave the article pending for the next run, up to
 * enrich.maxAttempts, after which it is parked as status='error'.
 *
 * enrich.workers articles are processed concurrently (Ollama overlaps
 * requests) until none are left or opts.deadline (epoch ms) passes —
 * in-flight articles always finish, so the deadline can overshoot by one
 * LLM call per worker. While opts.waitForMore() returns true (e.g.
 * ingestion still running), an empty queue polls instead of exiting, so
 * articles ingested mid-run get enriched in the same run.
 * opts.onItem, if given, is called after each article (LLM calls are slow;
 * this lets the CLI report progress live).
 */
export async function enrichPending(
  db,
  config,
  llm,
  { onItem, deadline, waitForMore, pollMs = 1000 } = {},
) {
  const { maxAttempts, dupWindowDays } = config.enrich;

  if (!(await llm.available())) {
    return { skipped: true, reason: `ollama not reachable at ${llm.url}` };
  }

  // Articles already attempted in this run: a failure stays 'pending' (for
  // the NEXT run) and must not be picked again by this one.
  const tried = [];
  const nextPending = db.prepare(`
    SELECT id, url, title, content, full_content FROM articles
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

  // Queue position for progress display: n = attempted this run, m = n plus
  // what's still pending (m can grow while ingestion adds articles).
  const countPending = db.prepare(`
    SELECT COUNT(*) AS c FROM articles
    WHERE status = 'pending' AND enrich_attempts < ?
      AND id NOT IN (SELECT value FROM json_each(?))
  `);
  // index counts completions (monotonic even with parallel workers);
  // total = claimed + still pending, so it can grow during ingestion.
  let completed = 0;
  const position = () => ({
    index: ++completed,
    total: tried.length + countPending.get(maxAttempts, JSON.stringify(tried)).c,
  });

  const saveFailure = db.prepare(`
    UPDATE articles
    SET enrich_attempts = enrich_attempts + 1,
        status = CASE WHEN enrich_attempts + 1 >= ? THEN 'error' ELSE 'pending' END
    WHERE id = ?
  `);

  const result = { enriched: 0, failed: 0, duplicates: 0, errors: [], timedOut: false };

  // Claiming is synchronous (select + mark in one tick), so concurrent
  // workers can never grab the same article. Note the small concurrency
  // tradeoff: two near-duplicates in flight at the same moment won't see
  // each other's embedding — later repeats are still caught.
  const claimNext = () => {
    const article = nextPending.get(maxAttempts, JSON.stringify(tried));
    if (article) tried.push(article.id);
    return article;
  };
  const remaining = () =>
    countPending.get(maxAttempts, JSON.stringify(tried)).c;

  const processOne = async (article) => {
    try {
      const { topics, summary, depth, duplicateOf } =
        await enrichOne(db, llm, article, recent, config.enrich);
      result.enriched++;
      if (duplicateOf) result.duplicates++;
      onItem?.({ id: article.id, title: article.title, topics, summary, depth, duplicateOf, ...position() });
    } catch (err) {
      saveFailure.run(maxAttempts, article.id);
      result.failed++;
      result.errors.push({ id: article.id, error: err.message });
      onItem?.({ id: article.id, title: article.title, error: err.message, ...position() });
    }
  };

  const worker = async () => {
    while (true) {
      if (deadline && Date.now() >= deadline) {
        // only a real cut-off counts as a timeout, not a drained queue
        if (remaining() > 0) result.timedOut = true;
        return;
      }
      const article = claimNext();
      if (!article) {
        if (!waitForMore?.()) return;
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      await processOne(article);
    }
  };

  const workers = Math.max(1, config.enrich.workers ?? 2);
  await Promise.all(Array.from({ length: workers }, worker));

  return result;
}
