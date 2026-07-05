import Parser from 'rss-parser';
import { sanitizeHtml } from './html.js';

/**
 * Bring the feeds table in line with the config: upsert configured feeds,
 * deactivate feeds that were removed from the config (articles are kept).
 */
export function syncFeeds(db, feeds) {
  const upsert = db.prepare(`
    INSERT INTO feeds (url, title, active) VALUES (?, ?, 1)
    ON CONFLICT (url) DO UPDATE SET
      active = 1,
      title = COALESCE(excluded.title, feeds.title)
  `);
  db.transaction(() => {
    for (const feed of feeds) upsert.run(feed.url, feed.title ?? null);
    const urls = feeds.map((f) => f.url);
    const placeholders = urls.map(() => '?').join(',');
    db.prepare(
      `UPDATE feeds SET active = 0
       WHERE url NOT IN (${placeholders || "''"})`,
    ).run(...urls);
  })();
}

/** Fetch one feed and insert its new items. Returns the new-article count. */
export async function ingestFeed(db, feed, parser) {
  const parsed = await parser.parseURL(feed.url);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO articles
      (feed_id, guid, url, title, author, published_at, content)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let added = 0;
  let skipped = 0;
  db.transaction(() => {
    for (const item of parsed.items ?? []) {
      const guid = item.guid ?? item.id ?? item.link;
      if (!guid || !item.title) {
        skipped++;
        continue;
      }
      const content =
        item['content:encoded'] ?? item.content ?? item.summary ?? '';
      const { changes } = insert.run(
        feed.id,
        String(guid),
        item.link ?? null,
        item.title.trim(),
        item.creator ?? item.author ?? null,
        item.isoDate ?? null,
        sanitizeHtml(content),
      );
      added += changes;
    }
    db.prepare(
      `UPDATE feeds SET
         title = COALESCE(title, ?),
         last_fetched_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
         last_status = 'ok'
       WHERE id = ?`,
    ).run(parsed.title ?? null, feed.id);
  })();

  return { added, skipped };
}

/**
 * Fetch every active feed. One feed failing never aborts the run; the error
 * is recorded on the feed row and in the returned summary.
 */
export async function ingestAll(db, config, { parser } = {}) {
  parser ??= new Parser({ timeout: 30_000 });
  const feeds = db
    .prepare('SELECT id, url, title FROM feeds WHERE active = 1')
    .all();

  const summary = { feedsOk: 0, feedsFailed: 0, added: 0, skipped: 0, errors: [], feeds: [] };
  for (const feed of feeds) {
    try {
      const { added, skipped } = await ingestFeed(db, feed, parser);
      summary.feedsOk++;
      summary.added += added;
      summary.skipped += skipped;
      summary.feeds.push({ url: feed.url, added, skipped });
    } catch (err) {
      summary.feedsFailed++;
      summary.errors.push({ url: feed.url, error: err.message });
      summary.feeds.push({ url: feed.url, error: err.message });
      db.prepare(
        `UPDATE feeds SET
           last_fetched_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
           last_status = ?
         WHERE id = ?`,
      ).run(`error: ${err.message}`.slice(0, 500), feed.id);
    }
  }
  return summary;
}
