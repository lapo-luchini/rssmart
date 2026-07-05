import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recomputeScores, topicPrefs } from './scoring.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const ARTICLE_COLUMNS = `
  a.id, a.feed_id, a.url, a.title, a.author, a.published_at, a.summary,
  a.status, a.duplicate_of, a.score, a.vote, a.read_at, a.created_at,
  f.title AS feed_title,
  (SELECT group_concat(t.name, '|') FROM article_topics at
   JOIN topics t ON t.id = at.topic_id
   WHERE at.article_id = a.id) AS topics
`;

function rowToArticle(row) {
  return { ...row, topics: row.topics ? row.topics.split('|') : [] };
}

export function createApp(db, config) {
  const app = express();
  app.use(express.json());

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
      SELECT ${ARTICLE_COLUMNS}, a.content
      FROM articles a JOIN feeds f ON f.id = a.feed_id
      WHERE a.id = ?
    `).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(rowToArticle(row));
  });

  app.post('/api/articles/:id/vote', (req, res) => {
    const vote = req.body?.vote;
    if (![-1, 0, 1].includes(vote)) {
      return res.status(400).json({ error: 'vote must be -1, 0 or 1' });
    }
    const { changes } = db
      .prepare('UPDATE articles SET vote = ? WHERE id = ?')
      .run(vote, req.params.id);
    if (!changes) return res.status(404).json({ error: 'not found' });
    recomputeScores(db);
    const row = db
      .prepare('SELECT id, vote, score FROM articles WHERE id = ?')
      .get(req.params.id);
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

  app.get('/api/feeds', (_req, res) => {
    res.json(db.prepare(`
      SELECT f.id, f.url, f.title, f.active, f.last_fetched_at, f.last_status,
             COUNT(a.id) AS articles,
             SUM(a.read_at IS NULL) AS unread
      FROM feeds f LEFT JOIN articles a ON a.feed_id = f.id
      GROUP BY f.id ORDER BY f.title
    `).all());
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
