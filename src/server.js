import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recomputeOneScore, scheduleRecompute, topicPrefs } from './scoring.js';
import { parseOpml, buildOpml } from './opml.js';
import { ingestAll } from './ingest.js';
import { Ollama } from './llm.js';
import { semanticSearch } from './search.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const ARTICLE_COLUMNS = `
  a.id, a.feed_id, a.url, a.title, a.author, a.published_at, a.summary,
  a.status, a.duplicate_of, a.score, a.vote, a.read_at, a.created_at,
  a.depth, a.score_topics, a.score_embedding, a.score_depth, a.score_feed,
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
    where.push('(a.title LIKE ? OR a.summary LIKE ? OR a.content LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
}

// Newest first is the universal tiebreaker/secondary key for every sort.
const BY_DATE = 'COALESCE(a.published_at, a.created_at) DESC';

/**
 * Translate list-endpoint query params into SQL; returns {error} on bad
 * input. skipTextFilter omits the title/summary/content LIKE clause —
 * used for semantic search, which ranks by meaning instead and would
 * otherwise also demand a literal text match.
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
  if (!['hot', 'score', 'date'].includes(sortKey)) {
    return { error: `unknown sort "${sort}"` };
  }

  // "hot" blends interest with freshness (à la Hacker News) so an old
  // article can't outrank a fresh one on score alone; computed at query
  // time from published_at, so it's always current with no stored/stale
  // column. orderParams must be spliced in right after the WHERE params —
  // it's the only sort with a bound value of its own.
  const orderBy = { hot: 'a.score - ? * (julianday(\'now\') - julianday(COALESCE(a.published_at, a.created_at))) DESC, ' + BY_DATE,
    score: 'a.score DESC, ' + BY_DATE,
    date: BY_DATE }[sortKey];
  const orderParams = sortKey === 'hot' ? [config.scoring.hotDecayPerDay] : [];

  return {
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
    params,
    orderParams,
    grouped: dupes !== '1', // default: bundle repeats, show best of each group
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

export function createApp(db, config) {
  const app = express();
  app.use(express.json({ limit: '2mb' })); // OPML imports ride in JSON
  const llm = new Ollama(config.ollama);

  app.get('/api/articles', async (req, res) => {
    const q = (req.query.q ?? '').trim();
    const isSemantic = req.query.semantic === '1' && q;

    const query = articleQuery(req.query, config, { skipTextFilter: isSemantic });
    if (query.error) return res.status(400).json({ error: query.error });
    const { whereSql, params, orderParams, grouped, orderBy, lim, off } = query;

    if (isSemantic) {
      let ranked;
      try {
        ranked = await semanticSearch(db, llm, q, { whereSql, params, grouped });
      } catch (err) {
        return res.status(502).json({ error: `semantic search unavailable: ${err.message}` });
      }
      return res.json({
        total: ranked.length,
        articles: fetchInRankOrder(db, ranked.slice(off, off + lim)),
      });
    }

    // Grouped mode: one card per duplicate group — its best-scoring member
    // among the articles matching the filters.
    const source = grouped
      ? `(SELECT a.*, ROW_NUMBER() OVER (
            PARTITION BY COALESCE(a.duplicate_of, a.id)
            ORDER BY a.score DESC, COALESCE(a.published_at, a.created_at) DESC, a.id DESC
          ) AS rn
          FROM articles a ${whereSql}) a
          JOIN feeds f ON f.id = a.feed_id
          WHERE a.rn = 1`
      : `articles a JOIN feeds f ON f.id = a.feed_id ${whereSql}`;

    const rows = db.prepare(`
      SELECT ${ARTICLE_COLUMNS}, ${VERSIONS_COL}
      FROM ${source} ORDER BY ${orderBy} LIMIT ? OFFSET ?
    `).all(...params, ...orderParams, lim, off);

    const { total } = db.prepare(grouped
      ? `SELECT COUNT(*) AS total FROM (
           SELECT 1 FROM articles a ${whereSql}
           GROUP BY COALESCE(a.duplicate_of, a.id))`
      : `SELECT COUNT(*) AS total FROM articles a ${whereSql}`
    ).get(...params);

    res.json({ total, articles: rows.map(rowToArticle) });
  });

  app.get('/api/articles/:id/versions', (req, res) => {
    const row = db
      .prepare('SELECT COALESCE(duplicate_of, id) AS root FROM articles WHERE id = ?')
      .get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    const rows = db.prepare(`
      SELECT ${ARTICLE_COLUMNS}
      FROM articles a JOIN feeds f ON f.id = a.feed_id
      WHERE COALESCE(a.duplicate_of, a.id) = ? AND a.id != ?
      ORDER BY a.score DESC, COALESCE(a.published_at, a.created_at) DESC
    `).all(row.root, req.params.id);
    res.json(rows.map(rowToArticle));
  });

  app.get('/api/articles/:id', (req, res) => {
    const row = db.prepare(`
      SELECT ${ARTICLE_COLUMNS}, COALESCE(a.full_content, a.content) AS content
      FROM articles a JOIN feeds f ON f.id = a.feed_id
      WHERE a.id = ?
    `).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(rowToArticle(row));
  });

  app.post('/api/articles/:id/vote', (req, res) => {
    const vote = req.body?.vote;
    if (!Number.isInteger(vote) || vote < -2 || vote > 2) {
      return res.status(400).json({ error: 'vote must be an integer from -2 to 2' });
    }
    // Casting a real vote (not retracting one) implies the article was
    // read — you can't rate what you haven't seen. Retraction (vote = 0)
    // leaves read_at alone: it doesn't mean you un-read it.
    const { changes } = db.prepare(`
      UPDATE articles
      SET vote = ?,
          read_at = CASE WHEN ? != 0 THEN COALESCE(read_at, strftime('%Y-%m-%dT%H:%M:%SZ','now')) ELSE read_at END
      WHERE id = ?
    `).run(vote, vote, req.params.id);
    if (!changes) return res.status(404).json({ error: 'not found' });
    // Instant, cheap: this article's own score only. The full-corpus
    // ripple (this vote can shift any other article's kNN term) is
    // debounced — see DESIGN.md — rather than blocking this response.
    recomputeOneScore(db, config, req.params.id);
    scheduleRecompute(db, config.scoring.recomputeDebounceSec);
    const row = db.prepare(`
      SELECT id, vote, read_at, score,
             score_topics, score_embedding, score_depth, score_feed
      FROM articles WHERE id = ?
    `).get(req.params.id);
    res.json(row);
  });

  // Re-queue an article for classification, optionally with a persistent
  // reader note the LLM must take into account. Jumps the queue.
  app.post('/api/articles/:id/reclassify', (req, res) => {
    const note = req.body?.note;
    if (note !== undefined && typeof note !== 'string') {
      return res.status(400).json({ error: 'note must be a string' });
    }
    // full_content is cleared so the source text is re-fetched and
    // re-judged too — reclassify doubles as "try this article again".
    const { changes } = db.prepare(`
      UPDATE articles
      SET status = 'pending', enrich_attempts = 0, enrich_priority = 1,
          full_content = NULL,
          enrich_note = COALESCE(NULLIF(TRIM(?), ''), enrich_note)
      WHERE id = ?
    `).run(note ?? '', req.params.id);
    if (!changes) return res.status(404).json({ error: 'not found' });
    const row = db
      .prepare('SELECT id, status, enrich_note FROM articles WHERE id = ?')
      .get(req.params.id);
    res.json(row);
  });

  app.get('/api/guidelines', (_req, res) => {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'guidelines'").get();
    res.json({ text: row?.value ?? '' });
  });

  app.put('/api/guidelines', (req, res) => {
    const text = req.body?.text;
    if (typeof text !== 'string') {
      return res.status(400).json({ error: 'text must be a string' });
    }
    if (text.trim()) {
      db.prepare(`
        INSERT INTO meta (key, value) VALUES ('guidelines', ?)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value
      `).run(text.trim());
    } else {
      db.prepare("DELETE FROM meta WHERE key = 'guidelines'").run();
    }
    res.json({ text: text.trim() });
  });

  app.post('/api/articles/:id/read', (req, res) => {
    const read = req.body?.read;
    if (typeof read !== 'boolean') {
      return res.status(400).json({ error: 'read must be a boolean' });
    }
    const { changes } = db.prepare(`
      UPDATE articles
      SET read_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%SZ','now') END
      WHERE id = ?
    `).run(read ? 1 : 0, req.params.id);
    if (!changes) return res.status(404).json({ error: 'not found' });
    const row = db
      .prepare('SELECT id, read_at FROM articles WHERE id = ?')
      .get(req.params.id);
    res.json(row);
  });

  app.get('/api/topics', (_req, res) => {
    res.json(topicPrefs(db));
  });

  const feedList = () => db.prepare(`
    SELECT f.id, f.url, f.title, f.html_url, f.active, f.last_fetched_at, f.last_status,
           f.next_fetch_at, f.fetch_interval_min,
           f.ok_count, f.error_count,
           COUNT(a.id) AS articles,
           COALESCE(SUM(a.read_at IS NULL), 0) AS unread,
           AVG(CASE WHEN a.vote != 0 THEN a.vote END) AS avg_vote,
           COALESCE(SUM(a.vote != 0), 0) AS votes,
           ROUND(COUNT(CASE WHEN COALESCE(a.published_at, a.created_at)
                                 >= datetime('now', '-28 days') THEN 1 END) / 4.0, 1)
             AS per_week
    FROM feeds f LEFT JOIN articles a ON a.feed_id = f.id
    GROUP BY f.id ORDER BY f.active DESC, COALESCE(f.title, f.url)
  `).all();

  const upsertFeed = db.prepare(`
    INSERT INTO feeds (url, title, html_url, active) VALUES (?, ?, ?, 1)
    ON CONFLICT (url) DO UPDATE SET
      active = 1,
      title = COALESCE(feeds.title, excluded.title),
      html_url = COALESCE(feeds.html_url, excluded.html_url)
  `);

  app.get('/api/feeds', (_req, res) => {
    res.json(feedList());
  });

  app.post('/api/feeds', (req, res) => {
    const { url, title } = req.body ?? {};
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
      return res.status(400).json({ error: 'url must start with http(s)://' });
    }
    upsertFeed.run(url.trim(), title?.trim() || null, null);
    res.status(201).json(feedList().find((f) => f.url === url.trim()));
  });

  app.patch('/api/feeds/:id', (req, res) => {
    const active = req.body?.active;
    if (typeof active !== 'boolean') {
      return res.status(400).json({ error: 'active must be a boolean' });
    }
    const { changes } = db
      .prepare('UPDATE feeds SET active = ? WHERE id = ?')
      .run(active ? 1 : 0, req.params.id);
    if (!changes) return res.status(404).json({ error: 'not found' });
    res.json(feedList().find((f) => f.id === Number(req.params.id)));
  });

  app.post('/api/feeds/import', (req, res) => {
    const opml = req.body?.opml;
    if (typeof opml !== 'string' || !opml.trim()) {
      return res.status(400).json({ error: 'opml must be a non-empty string' });
    }
    const found = parseOpml(opml);
    db.transaction(() => {
      for (const feed of found) {
        upsertFeed.run(feed.url, feed.title ?? null, feed.htmlUrl ?? null);
      }
    })();
    res.json({ found: found.length });
  });

  // Kick a full fetch (ignoring the adaptive schedule) in the background.
  let refreshing = null;
  app.post('/api/refresh', (_req, res) => {
    refreshing ??= ingestAll(db, config, { dueOnly: false }).finally(() => {
      refreshing = null;
    });
    res.status(202).json({ started: true });
  });

  app.get('/api/feeds.opml', (_req, res) => {
    const feeds = db
      .prepare('SELECT url, title, html_url FROM feeds WHERE active = 1 ORDER BY title')
      .all();
    res.type('text/x-opml').send(buildOpml(feeds));
  });

  app.get('/api/stats', (_req, res) => {
    res.json(db.prepare(`
      SELECT COUNT(*) AS total,
             COALESCE(SUM(read_at IS NULL), 0) AS unread,
             COALESCE(SUM(status = 'pending'), 0) AS pending,
             COALESCE(SUM(status = 'error'), 0) AS errors,
             COALESCE(SUM(duplicate_of IS NOT NULL), 0) AS duplicates
      FROM articles
    `).get());
  });

  app.use(express.static(PUBLIC_DIR));
  return app;
}
