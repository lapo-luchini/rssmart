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

/**
 * Adaptive fetch cadence: check a feed about as often as it publishes one
 * article (measured over the last 28 days), clamped to the configured
 * bounds. A silent feed settles at the maximum interval.
 */
export function fetchIntervalMinutes(articlesLast28d, { minIntervalMin, maxIntervalMin }) {
  if (!articlesLast28d) return maxIntervalMin;
  const minutes = (28 * 24 * 60) / articlesLast28d;
  return Math.round(Math.min(Math.max(minutes, minIntervalMin), maxIntervalMin));
}

function scheduleNextFetch(db, feed, config, { failed = false } = {}) {
  let minutes;
  if (feed.fetch_interval_min) {
    minutes = feed.fetch_interval_min; // manual override always wins
  } else if (failed) {
    minutes = Math.min(60, config.scheduler.maxIntervalMin); // retry errors hourly
  } else {
    const { c } = db.prepare(`
      SELECT COUNT(*) AS c FROM articles
      WHERE feed_id = ? AND COALESCE(published_at, created_at) >= datetime('now', '-28 days')
    `).get(feed.id);
    minutes = fetchIntervalMinutes(c, config.scheduler);
  }
  db.prepare(`
    UPDATE feeds
    SET next_fetch_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+' || ? || ' minutes')
    WHERE id = ?
  `).run(minutes, feed.id);
}

/**
 * Fetch feed XML honoring its declared charset. rss-parser's parseURL
 * assumes UTF-8, which turns latin-1 feeds (still common on Italian sites)
 * into U+FFFD mojibake at storage time.
 */
export async function fetchFeedXml(url, timeoutMs = 30_000) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'user-agent': 'rssmart/1.0 (personal RSS reader)',
      accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`Status code ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const head = bytes.subarray(0, 512).toString('latin1');
  const charset =
    /charset=["']?([\w-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1] ??
    /<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(head)?.[1] ??
    'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return bytes.toString('utf8'); // unknown label: best effort
  }
}

/** Fetch one feed and insert its new items. Returns the new-article count. */
export async function ingestFeed(db, feed, parser) {
  const parsed = await parser.parseString(await fetchFeedXml(feed.url));

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
 * Fetch active feeds. One feed failing never aborts the run; the error is
 * recorded on the feed row and in the returned summary. opts.onFeed, if
 * given, is called as each feed completes (for live CLI progress).
 * opts.dueOnly restricts the run to feeds whose adaptive next_fetch_at has
 * passed; every fetch (either way) reschedules the feed.
 */
export async function ingestAll(db, config, { parser, onFeed, dueOnly = false } = {}) {
  parser ??= new Parser({ timeout: 30_000 });
  const due = dueOnly
    ? "AND (next_fetch_at IS NULL OR next_fetch_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
    : '';
  const feeds = db
    .prepare(`SELECT id, url, title, fetch_interval_min FROM feeds WHERE active = 1 ${due}`)
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
      scheduleNextFetch(db, feed, config);
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
      scheduleNextFetch(db, feed, config, { failed: true });
    }
  }
  return summary;
}
