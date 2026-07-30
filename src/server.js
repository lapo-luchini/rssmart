import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recomputeOneScore, scheduleRecompute, topicPrefs, invalidateSingleScoreBatcher } from './scoring.js';
import { getReaderContent } from './enrich.js';
import { parseOpml, buildOpml } from './opml.js';
import { ingestAll } from './ingest.js';
import { Ollama } from './llm.js';
import { semanticSearch } from './search.js';
import { decompressText } from './compress.js';
import { proposeTopicMerges, applyTopicMerge } from './topicMerge.js';
import { renderMetrics } from './metrics.js';
import { getDbQueryMs } from './db.js';
import { log } from './log.js';

// Bun ships its own static-file middleware (hono/bun); Node needs
// @hono/node-server's, which resolves relative paths from the process cwd
// rather than this file's location — same reasoning as src/db.js picking
// its SQLite driver per runtime, done once at module load via top-level
// await rather than inside createApp, so createApp itself stays synchronous.
const serveStatic = typeof Bun !== 'undefined'
  ? (await import('hono/bun')).serveStatic
  : (await import('@hono/node-server/serve-static')).serveStatic;

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const ARTICLE_COLUMNS = `
  a.id, a.feed_id, a.url, a.title, a.author, a.published_at, a.summary,
  a.status, a.duplicate_of, a.score, a.vote, a.read_at, a.created_at,
  a.depth, a.score_topics, a.score_embedding, a.score_depth, a.score_feed, a.score_bonus,
  a.enrich_note,
  f.title AS feed_title,
  (SELECT group_concat(t.name, '|') FROM article_topics at
   JOIN topics t ON t.id = at.topic_id
   WHERE at.article_id = a.id) AS topics,
  (SELECT d.title FROM articles d WHERE d.id = a.duplicate_of) AS duplicate_title
`;

function rowToArticle(row) {
  return { ...row, topics: row.topics ? row.topics.split('|') : [] };
}

// Hono's c.req.json() throws on an empty/invalid body; every route here
// treats a missing body as "no fields provided" (matching Express's
// req.body?.field pattern on an empty req.body), so fall back to {}.
async function jsonBody(c) {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

// topic/feed/text filters: none of these validate input, they just narrow
// the result set, so they carry no early-return branches of their own.
function pushMatchFilters(where, params, { topic, feedId, q, skipTextFilter }) {
  if (topic) {
    where.push(`EXISTS (SELECT 1 FROM article_topics at
      JOIN topics t ON t.id = at.topic_id
      WHERE at.article_id = a.id AND t.name = ? COLLATE NOCASE)`);
    params.push(topic);
  }
  if (feedId) {
    where.push('a.feed_id = ?');
    params.push(Number(feedId));
  }
  if (q && !skipTextFilter) {
    // content isn't searchable here: it's stored brotli-compressed (see
    // src/compress.js), so a SQL LIKE can't match inside it — semantic
    // search (which embeds a meaningful sample of the full text, see
    // enrichOne's text_embedding) is the way to search full-body content.
    where.push('(a.title LIKE ? OR a.summary LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
}

// Newest first is the universal tiebreaker/secondary key for every sort.
const BY_DATE = 'COALESCE(a.published_at, a.created_at) DESC';

// Triage-only round-robin: interleave feeds by recency-within-feed instead
// of draining one feed's whole backlog before moving to the next — an
// adaptive per-feed check cadence means one feed can dump many articles at
// once, otherwise producing long same-source runs in a plain date sort.
// Bounded to feeds that have posted within config.triage.roundRobinWindowDays:
// a feed that's gone quiet doesn't need (and doesn't deserve) a guaranteed
// early slot just because its one leftover article is technically "rank 1"
// for itself — it sorts in on date like everything else, after every active
// feed's ranked content, via the large ELSE sentinel below.
function dateRoundRobinSql(windowDays) {
  return `
  CASE
    WHEN fl.latest >= datetime('now', '-${windowDays} days')
    THEN ROW_NUMBER() OVER (PARTITION BY a.feed_id ORDER BY COALESCE(a.published_at, a.created_at) DESC)
    ELSE 1000000
  END,
  ${BY_DATE}
`;
}

// Feeds a.feed_id joins against — each feed's own latest post, computed
// once (GROUP BY feed_id, ~hundreds of feeds) instead of the correlated
// MAX subquery this replaced (once per candidate *article*, ~thousands —
// measured live at ~7-8s against a ~13k-article corpus, each iteration a
// real index seek, not a scan, but there were just too many of them).
// Only joined in when sort=date-rr actually needs it (see articleQuery's
// extraJoin) — every other sort ignores fl entirely.
const FEED_LATEST_JOIN = `
  LEFT JOIN (
    SELECT feed_id, MAX(COALESCE(published_at, created_at)) AS latest
    FROM articles GROUP BY feed_id
  ) fl ON fl.feed_id = a.feed_id
`;

/**
 * Translate list-endpoint query params into SQL; returns {error} on bad
 * input. skipTextFilter omits the title/summary LIKE clause — used for
 * semantic search, which ranks by meaning instead and would otherwise
 * also demand a literal text match.
 */
function articleQuery(query, config, { skipTextFilter = false } = {}) {
  const {
    view = 'interesting', topic, feed_id: feedId, q, sort, status,
    dupes = '0', limit = '50', offset = '0',
  } = query;

  const where = [];
  const params = [];

  if (view === 'interesting' || view === 'unread') {
    where.push('a.read_at IS NULL');
  } else if (view !== 'all') {
    return { error: `unknown view "${view}"` };
  }
  if (status) {
    if (!['pending', 'enriched', 'error'].includes(status)) {
      return { error: `unknown status "${status}"` };
    }
    where.push('a.status = ?');
    params.push(status);
  }
  pushMatchFilters(where, params, { topic, feedId, q, skipTextFilter });

  const sortKey = sort ?? (view === 'interesting' ? 'hot' : 'date');
  if (!['hot', 'score', 'date', 'date-rr'].includes(sortKey)) {
    return { error: `unknown sort "${sort}"` };
  }

  // "hot" blends interest with freshness (à la Hacker News) so an old
  // article can't outrank a fresh one on score alone; computed at query
  // time from published_at, so it's always current with no stored/stale
  // column. orderParams must be spliced in right after the WHERE params —
  // it's the only sort with a bound value of its own.
  const orderBy = { hot: 'a.score - ? * (julianday(\'now\') - julianday(COALESCE(a.published_at, a.created_at))) DESC, ' + BY_DATE,
    score: 'a.score DESC, ' + BY_DATE,
    date: BY_DATE,
    'date-rr': dateRoundRobinSql(config.triage.roundRobinWindowDays) }[sortKey];
  const orderParams = sortKey === 'hot' ? [config.scoring.hotDecayPerDay] : [];

  return {
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
    params,
    orderParams,
    grouped: dupes !== '1', // default: bundle repeats, show best of each group
    extraJoin: sortKey === 'date-rr' ? FEED_LATEST_JOIN : '',
    orderBy,
    lim: Math.min(Math.max(Number(limit) || 50, 1), 200),
    off: Math.max(Number(offset) || 0, 0),
  };
}

// Total members of an article's duplicate group (root + repeats).
const VERSIONS_COL = `
  (SELECT COUNT(*) FROM articles d
   WHERE COALESCE(d.duplicate_of, d.id) = COALESCE(a.duplicate_of, a.id)) AS versions
`;

// Fetch full article rows for a ranked list of ids, in that same order.
// Semantic search ranks in JS (cosine, not SQL-sortable), so the rows
// pulled back by `id IN (...)` need reordering to match.
function fetchInRankOrder(db, ranked) {
  if (ranked.length === 0) return [];
  const ids = ranked.map((r) => r.id);
  const rows = db.prepare(`
    SELECT ${ARTICLE_COLUMNS}, ${VERSIONS_COL}
    FROM articles a JOIN feeds f ON f.id = a.feed_id
    WHERE a.id IN (${ids.map(() => '?').join(',')})
  `).all(...ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ranked.map((r) => ({ ...rowToArticle(byId.get(r.id)), similarity: r.similarity }));
}

export function createApp(db, config, commitHash) {
  const app = new Hono();
  // Per-request timing: wall-clock vs cumulative SQLite query time (see
  // db.js's getDbQueryMs) for every API call — the same evidence that
  // pinned /api/stats' full-table-scan cost down to the exact query,
  // now on tap for whichever endpoint gets slow next. Registered first
  // so it wraps bodyLimit too (a 413 still gets logged).
  app.use('/api/*', async (c, next) => {
    const wallStart = performance.now();
    const dbStart = getDbQueryMs();
    await next();
    const wallMs = performance.now() - wallStart;
    const dbMs = getDbQueryMs() - dbStart;
    log(`${c.req.method} ${c.req.path} ${c.res.status} wall=${wallMs.toFixed(0)}ms db=${dbMs.toFixed(0)}ms`);
  });
  app.use('/api/*', bodyLimit({
    maxSize: 2 * 1024 * 1024, // OPML imports ride in JSON
    onError: (c) => c.json({ error: 'request body too large' }, 413),
  }));
  const llm = new Ollama(config.ollama);

  app.get('/api/articles', async (c) => {
    const query = c.req.query();
    const q = (query.q ?? '').trim();
    const isSemantic = query.semantic === '1' && q;

    const parsed = articleQuery(query, config, { skipTextFilter: isSemantic });
    if (parsed.error) return c.json({ error: parsed.error }, 400);
    const { whereSql, params, orderParams, grouped, extraJoin, orderBy, lim, off } = parsed;

    if (isSemantic) {
      let ranked;
      try {
        ranked = await semanticSearch(db, llm, q, { whereSql, params, grouped });
      } catch (err) {
        return c.json({ error: `semantic search unavailable: ${err.message}` }, 502);
      }
      return c.json({
        total: ranked.length,
        articles: fetchInRankOrder(db, ranked.slice(off, off + lim)),
      });
    }

    // Narrow-then-widen: pick the winning ids using only the columns
    // ranking/grouping/ORDER BY actually need (score, published_at,
    // created_at, feed_id), deferring ARTICLE_COLUMNS/VERSIONS_COL's wide
    // fetch (BLOB-backed columns, 3 correlated subqueries) to just the
    // already-LIMITed result instead of every row matching the filter.
    // Measured live against ~11k matching rows: ~2.5s -> ~200-250ms.
    // `orderBy` is reused verbatim for both the winners CTE and the final
    // ORDER BY — safe because both `ranked`/`articles` provide the same
    // columns it references (score, published_at, created_at, feed_id).
    const winnersSql = grouped
      ? `WITH ranked AS (
           SELECT a.id, a.score, a.published_at, a.created_at, a.feed_id,
                  ROW_NUMBER() OVER (
                    PARTITION BY COALESCE(a.duplicate_of, a.id)
                    ORDER BY a.score DESC, COALESCE(a.published_at, a.created_at) DESC, a.id DESC
                  ) AS rn
           FROM articles a ${whereSql}
         )
         SELECT id FROM ranked a ${extraJoin} WHERE a.rn = 1
         ORDER BY ${orderBy} LIMIT ? OFFSET ?`
      : `SELECT a.id FROM articles a ${extraJoin} ${whereSql}
         ORDER BY ${orderBy} LIMIT ? OFFSET ?`;

    const rows = db.prepare(`
      WITH winners AS (${winnersSql})
      SELECT ${ARTICLE_COLUMNS}, ${VERSIONS_COL}
      FROM winners
      JOIN articles a ON a.id = winners.id
      JOIN feeds f ON f.id = a.feed_id
      ${extraJoin}
      ORDER BY ${orderBy}
    `).all(...params, ...orderParams, lim, off, ...orderParams);

    const { total } = db.prepare(grouped
      ? `SELECT COUNT(*) AS total FROM (
           SELECT 1 FROM articles a ${whereSql}
           GROUP BY COALESCE(a.duplicate_of, a.id))`
      : `SELECT COUNT(*) AS total FROM articles a ${whereSql}`
    ).get(...params);

    return c.json({ total, articles: rows.map(rowToArticle) });
  });

  app.get('/api/articles/:id/versions', (c) => {
    const id = c.req.param('id');
    const row = db
      .prepare('SELECT COALESCE(duplicate_of, id) AS root FROM articles WHERE id = ?')
      .get(id);
    if (!row) return c.json({ error: 'not found' }, 404);
    const rows = db.prepare(`
      SELECT ${ARTICLE_COLUMNS}
      FROM articles a JOIN feeds f ON f.id = a.feed_id
      WHERE COALESCE(a.duplicate_of, a.id) = ? AND a.id != ?
      ORDER BY a.score DESC, COALESCE(a.published_at, a.created_at) DESC
    `).all(row.root, id);
    return c.json(rows.map(rowToArticle));
  });

  app.get('/api/articles/:id', (c) => {
    const id = c.req.param('id');
    const row = db.prepare(`
      SELECT ${ARTICLE_COLUMNS}, COALESCE(a.full_content, a.content) AS content
      FROM articles a JOIN feeds f ON f.id = a.feed_id
      WHERE a.id = ?
    `).get(id);
    if (!row) return c.json({ error: 'not found' }, 404);
    row.content = decompressText(row.content);
    return c.json(rowToArticle(row));
  });

  // The in-page reader overlay's content: the fullest readable text we
  // have, fetching the origin page on demand (and caching a win into
  // full_content) rather than settling for a possibly-truncated RSS
  // teaser. See getReaderContent's doc comment for the "keep only if it
  // beats the feed's own text" guard.
  app.get('/api/articles/:id/reader', async (c) => {
    const id = c.req.param('id');
    const article = db.prepare(
      'SELECT id, url, content, full_content FROM articles WHERE id = ?',
    ).get(id);
    if (!article) return c.json({ error: 'not found' }, 404);
    try {
      const { html, source } = await getReaderContent(db, article, config);
      return c.json({ html, source });
    } catch (err) {
      return c.json({ error: `could not load article content: ${err.message}` }, 502);
    }
  });

  app.post('/api/articles/:id/vote', async (c) => {
    const id = c.req.param('id');
    const vote = (await jsonBody(c))?.vote;
    if (!Number.isInteger(vote) || vote < -2 || vote > 2) {
      return c.json({ error: 'vote must be an integer from -2 to 2' }, 400);
    }
    // Casting a real vote (not retracting one) implies the article was
    // read — you can't rate what you haven't seen. Retraction (vote = 0)
    // leaves read_at alone: it doesn't mean you un-read it.
    const { changes } = db.prepare(`
      UPDATE articles
      SET vote = ?,
          read_at = CASE WHEN ? != 0 THEN COALESCE(read_at, strftime('%Y-%m-%dT%H:%M:%SZ','now')) ELSE read_at END,
          voted_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?
    `).run(vote, vote, id);
    if (!changes) return c.json({ error: 'not found' }, 404);
    // Instant, cheap: this article's own score only. The full-corpus
    // ripple (this vote can shift any other article's kNN term) is
    // debounced — see DESIGN.md — rather than blocking this response.
    invalidateSingleScoreBatcher(db); // voted set changed — rebuilt lazily, reusing the WASM buffer
    recomputeOneScore(db, config, id);
    scheduleRecompute(db, config.scoring.recomputeDebounceSec);
    const row = db.prepare(`
      SELECT id, vote, read_at, voted_at, score,
             score_topics, score_embedding, score_depth, score_feed, score_bonus
      FROM articles WHERE id = ?
    `).get(id);
    return c.json(row);
  });

  // Re-queue an article for classification, optionally with a persistent
  // reader note the LLM must take into account. Jumps the queue.
  app.post('/api/articles/:id/reclassify', async (c) => {
    const id = c.req.param('id');
    const note = (await jsonBody(c))?.note;
    if (note !== undefined && typeof note !== 'string') {
      return c.json({ error: 'note must be a string' }, 400);
    }
    // full_content is cleared so the source text is re-fetched and
    // re-judged too — reclassify doubles as "try this article again".
    const { changes } = db.prepare(`
      UPDATE articles
      SET status = 'pending', enrich_attempts = 0, enrich_priority = 1,
          full_content = NULL,
          enrich_note = COALESCE(NULLIF(TRIM(?), ''), enrich_note)
      WHERE id = ?
    `).run(note ?? '', id);
    if (!changes) return c.json({ error: 'not found' }, 404);
    const row = db
      .prepare('SELECT id, status, enrich_note FROM articles WHERE id = ?')
      .get(id);
    return c.json(row);
  });

  app.get('/api/guidelines', (c) => {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'guidelines'").get();
    return c.json({ text: row?.value ?? '' });
  });

  app.put('/api/guidelines', async (c) => {
    const text = (await jsonBody(c))?.text;
    if (typeof text !== 'string') {
      return c.json({ error: 'text must be a string' }, 400);
    }
    if (text.trim()) {
      db.prepare(`
        INSERT INTO meta (key, value) VALUES ('guidelines', ?)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value
      `).run(text.trim());
    } else {
      db.prepare("DELETE FROM meta WHERE key = 'guidelines'").run();
    }
    return c.json({ text: text.trim() });
  });

  app.post('/api/articles/:id/read', async (c) => {
    const id = c.req.param('id');
    const read = (await jsonBody(c))?.read;
    if (typeof read !== 'boolean') {
      return c.json({ error: 'read must be a boolean' }, 400);
    }
    const { changes } = db.prepare(`
      UPDATE articles
      SET read_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%SZ','now') END
      WHERE id = ?
    `).run(read ? 1 : 0, id);
    if (!changes) return c.json({ error: 'not found' }, 404);
    const row = db
      .prepare('SELECT id, read_at FROM articles WHERE id = ?')
      .get(id);
    return c.json(row);
  });

  app.get('/api/topics', (c) => {
    return c.json(topicPrefs(db, config.enrich.maxSuggestedTopics, config.scoring.voteDecayHalflifeYears));
  });

  // Propose-only: nothing is applied until the reader approves each merge
  // individually via POST /api/topics/merge (see src/topicMerge.js — a
  // merge blends historical vote data per topic, not just a label).
  app.post('/api/topics/propose-merges', async (c) => {
    try {
      const merges = await proposeTopicMerges(db, llm, config.ollama.topicMergeTimeoutMs);
      return c.json({ merges });
    } catch (err) {
      return c.json({ error: `topic-merge proposal unavailable: ${err.message}` }, 502);
    }
  });

  app.post('/api/topics/merge', async (c) => {
    const { from, to } = (await jsonBody(c)) ?? {};
    if (typeof from !== 'string' || typeof to !== 'string' || !from.trim() || !to.trim()) {
      return c.json({ error: 'from and to must be non-empty strings' }, 400);
    }
    try {
      applyTopicMerge(db, from, to);
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
    return c.json(topicPrefs(db, config.enrich.maxSuggestedTopics, config.scoring.voteDecayHalflifeYears));
  });

  let feedListKey = null;
  let feedListCache = null;
  const feedList = () => {
    const state = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM feeds) AS feedCount,
        COALESCE((SELECT SUM(active) FROM feeds), 0) AS activeSum,
        (SELECT COUNT(*) FROM articles) AS articleCount,
        COALESCE((SELECT SUM(vote != 0) FROM articles), 0) AS voteCount,
        COALESCE((SELECT SUM(read_at IS NULL) FROM articles), 0) AS unreadCount,
        COALESCE((SELECT SUM(ok_count + error_count) FROM feeds), 0) AS fetchTotal
    `).get();
    const key = `${state.feedCount}:${state.activeSum}:${state.articleCount}:${state.voteCount}:${state.unreadCount}:${state.fetchTotal}`;
    if (feedListKey === key) return feedListCache;
    feedListKey = key;
    feedListCache = db.prepare(`
      SELECT f.id, f.url, f.title, f.html_url, f.type, f.active, f.last_fetched_at, f.last_status,
             f.next_fetch_at, f.fetch_interval_min,
             f.ok_count, f.error_count,
             COUNT(a.id) AS articles,
             COUNT(CASE WHEN a.read_at IS NULL THEN a.id END) AS unread,
             AVG(CASE WHEN a.vote != 0 THEN a.vote END) AS avg_vote,
             COALESCE(SUM(a.vote != 0), 0) AS votes,
             ROUND(COUNT(CASE WHEN COALESCE(a.published_at, a.created_at)
                                   >= datetime('now', '-28 days') THEN 1 END) / 4.0, 1)
               AS per_week
      FROM feeds f LEFT JOIN articles a ON a.feed_id = f.id
      GROUP BY f.id ORDER BY f.active DESC, COALESCE(f.title, f.url)
    `).all();
    return feedListCache;
  };

  const upsertFeed = db.prepare(`
    INSERT INTO feeds (url, title, html_url, active) VALUES (?, ?, ?, 1)
    ON CONFLICT (url) DO UPDATE SET
      active = 1,
      title = COALESCE(feeds.title, excluded.title),
      html_url = COALESCE(feeds.html_url, excluded.html_url)
  `);

  app.get('/api/feeds', (c) => {
    return c.json(feedList());
  });

  app.post('/api/feeds', async (c) => {
    const { url, title } = (await jsonBody(c)) ?? {};
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
      return c.json({ error: 'url must start with http(s)://' }, 400);
    }
    upsertFeed.run(url.trim(), title?.trim() || null, null);
    return c.json(feedList().find((f) => f.url === url.trim()), 201);
  });

  app.patch('/api/feeds/:id', async (c) => {
    const id = c.req.param('id');
    const active = (await jsonBody(c))?.active;
    if (typeof active !== 'boolean') {
      return c.json({ error: 'active must be a boolean' }, 400);
    }
    const { changes } = db
      .prepare('UPDATE feeds SET active = ? WHERE id = ?')
      .run(active ? 1 : 0, id);
    if (!changes) return c.json({ error: 'not found' }, 404);
    return c.json(feedList().find((f) => f.id === Number(id)));
  });

  app.post('/api/feeds/import', async (c) => {
    const opml = (await jsonBody(c))?.opml;
    if (typeof opml !== 'string' || !opml.trim()) {
      return c.json({ error: 'opml must be a non-empty string' }, 400);
    }
    const found = parseOpml(opml);
    db.transaction(() => {
      for (const feed of found) {
        upsertFeed.run(feed.url, feed.title ?? null, feed.htmlUrl ?? null);
      }
    })();
    return c.json({ found: found.length });
  });

  // Kick a full fetch (ignoring the adaptive schedule) in the background.
  let refreshing = null;
  app.post('/api/refresh', (c) => {
    refreshing ??= ingestAll(db, config, { dueOnly: false }).finally(() => {
      refreshing = null;
    });
    return c.json({ started: true }, 202);
  });

  app.get('/api/feeds.opml', (c) => {
    const feeds = db
      .prepare('SELECT url, title, html_url FROM feeds WHERE active = 1 ORDER BY title')
      .all();
    return c.body(buildOpml(feeds), 200, { 'Content-Type': 'text/x-opml' });
  });

  app.get('/api/stats', (c) => {
    return c.json(db.prepare(`
      SELECT COUNT(*) AS total,
             COALESCE(SUM(read_at IS NULL), 0) AS unread,
             COALESCE(SUM(status = 'pending'), 0) AS pending,
             COALESCE(SUM(status = 'error'), 0) AS errors,
             COALESCE(SUM(duplicate_of IS NOT NULL), 0) AS duplicates
      FROM articles
    `).get());
  });

  app.get('/api/version', (c) => {
    return c.json({ commit: commitHash || 'unknown' });
  });

  // Not under /api — Prometheus's default scrape_config expects /metrics
  // at the root, unauthenticated (matching this app's existing no-auth
  // posture; see server.host's own doc comment in config.example.yaml).
  app.get('/metrics', (c) => {
    return c.body(renderMetrics(db, config, commitHash), 200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    });
  });

  app.use('*', serveStatic({ root: PUBLIC_DIR }));
  return app;
}
