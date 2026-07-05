import Parser from 'rss-parser';
import { sanitizeHtml } from './html.js';

// Feed-provided links end up in <a href> in the UI: allow http(s) only.
const httpUrl = (u) =>
  typeof u === 'string' && /^https?:\/\//i.test(u.trim()) ? u.trim() : null;

/**
 * Seed the feeds table from the config. The DB is the source of truth
 * (feeds are managed from the web UI); config feeds are upserted as a
 * convenience but never deactivate anything.
 */
export function syncFeeds(db, feeds) {
  const upsert = db.prepare(`
    INSERT INTO feeds (url, title) VALUES (?, ?)
    ON CONFLICT (url) DO UPDATE SET
      title = COALESCE(feeds.title, excluded.title)
  `);
  db.transaction(() => {
    for (const feed of feeds) upsert.run(feed.url, feed.title ?? null);
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
        httpUrl(item.link),
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
         html_url = COALESCE(html_url, ?),
         last_fetched_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
         last_status = 'ok',
         ok_count = ok_count + 1
       WHERE id = ?`,
    ).run(parsed.title ?? null, httpUrl(parsed.link), feed.id);
  })();

  return { added, skipped };
}

/**
 * Fetch every active feed. One feed failing never aborts the run; the error
 * is recorded on the feed row and in the returned summary. opts.onFeed, if
 * given, is called as each feed completes (for live CLI progress).
 */
export async function ingestAll(db, config, { parser, onFeed } = {}) {
  parser ??= new Parser({ timeout: 30_000 });
  const feeds = db
    .prepare('SELECT id, url, title FROM feeds WHERE active = 1')
    .all();

  const summary = { feedsOk: 0, feedsFailed: 0, added: 0, skipped: 0, errors: [], feeds: [] };
  let index = 0;
  for (const feed of feeds) {
    index++;
    try {
      const { added, skipped } = await ingestFeed(db, feed, parser);
      summary.feedsOk++;
      summary.added += added;
      summary.skipped += skipped;
      summary.feeds.push({ url: feed.url, added, skipped });
      onFeed?.({ url: feed.url, added, skipped, index, total: feeds.length });
    } catch (err) {
      summary.feedsFailed++;
      summary.errors.push({ url: feed.url, error: err.message });
      summary.feeds.push({ url: feed.url, error: err.message });
      onFeed?.({ url: feed.url, error: err.message, index, total: feeds.length });
      db.prepare(
        `UPDATE feeds SET
           last_fetched_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
           last_status = ?,
           error_count = error_count + 1
         WHERE id = ?`,
      ).run(`error: ${err.message}`.slice(0, 500), feed.id);
    }
  }
  return summary;
}
