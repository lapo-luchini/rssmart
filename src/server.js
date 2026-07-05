import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recomputeScores, topicPrefs } from './scoring.js';
import { parseOpml, buildOpml } from './opml.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const ARTICLE_COLUMNS = `
  a.id, a.feed_id, a.url, a.title, a.author, a.published_at, a.summary,
  a.status, a.duplicate_of, a.score, a.vote, a.read_at, a.created_at,
  a.depth, a.score_topics, a.score_embedding, a.score_depth, a.score_feed,
  f.title AS feed_title,
  (SELECT group_concat(t.name, '|') FROM article_topics at
   JOIN topics t ON t.id = at.topic_id
   WHERE at.article_id = a.id) AS topics,
  (SELECT d.title FROM articles d WHERE d.id = a.duplicate_of) AS duplicate_title
`;

function rowToArticle(row) {
  return { ...row, topics: row.topics ? row.topics.split('|') : [] };
}

export function createApp(db, config) {
  const app = express();
  app.use(express.json({ limit: '2mb' })); // OPML imports ride in JSON

  app.get('/api/articles', (req, res) => {
    const {
      view = 'interesting',
      topic,
      feed_id: feedId,
      q,
      sort,
      dupes = '0',
      limit = '50',
      offset = '0',
    } = req.query;

    const where = [];
    const params = [];

    if (view === 'interesting' || view === 'unread') {
      where.push('a.read_at IS NULL');
    } else if (view !== 'all') {
      return res.status(400).json({ error: `unknown view "${view}"` });
    }
    if (dupes !== '1') where.push('a.duplicate_of IS NULL');
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
    if (q) {
      where.push('(a.title LIKE ? OR a.summary LIKE ? OR a.content LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like);
    }

    const sortKey = sort ?? (view === 'interesting' ? 'score' : 'date');
    const orderBy =
      sortKey === 'score'
        ? 'a.score DESC, COALESCE(a.published_at, a.created_at) DESC'
        : 'COALESCE(a.published_at, a.created_at) DESC';
    if (!['score', 'date'].includes(sortKey)) {
      return res.status(400).json({ error: `unknown sort "${sort}"` });
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const off = Math.max(Number(offset) || 0, 0);

    const rows = db.prepare(`
      SELECT ${ARTICLE_COLUMNS}
      FROM articles a JOIN feeds f ON f.id = a.feed_id
      ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?
    `).all(...params, lim, off);

    const { total } = db.prepare(`
      SELECT COUNT(*) AS total FROM articles a ${whereSql}
    `).get(...params);

    res.json({ total, articles: rows.map(rowToArticle) });
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
    const { changes } = db
      .prepare('UPDATE articles SET vote = ? WHERE id = ?')
      .run(vote, req.params.id);
    if (!changes) return res.status(404).json({ error: 'not found' });
    recomputeScores(db, config);
    const row = db.prepare(`
      SELECT id, vote, score,
             score_topics, score_embedding, score_depth, score_feed
      FROM articles WHERE id = ?
    `).get(req.params.id);
    res.json(row);
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
    SELECT f.id, f.url, f.title, f.active, f.last_fetched_at, f.last_status,
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
    INSERT INTO feeds (url, title, active) VALUES (?, ?, 1)
    ON CONFLICT (url) DO UPDATE SET
      active = 1, title = COALESCE(feeds.title, excluded.title)
  `);

  app.get('/api/feeds', (_req, res) => {
    res.json(feedList());
  });

  app.post('/api/feeds', (req, res) => {
    const { url, title } = req.body ?? {};
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
      return res.status(400).json({ error: 'url must start with http(s)://' });
    }
    upsertFeed.run(url.trim(), title?.trim() || null);
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
      for (const feed of found) upsertFeed.run(feed.url, feed.title ?? null);
    })();
    res.json({ found: found.length });
  });

  app.get('/api/feeds.opml', (_req, res) => {
    const feeds = db
      .prepare('SELECT url, title FROM feeds WHERE active = 1 ORDER BY title')
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
