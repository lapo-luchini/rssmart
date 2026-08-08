import Parser from 'rss-parser';
import { sanitizeHtml } from './html.js';
import { charsetFromContentType, decodeBytes } from './charset.js';
import { compressText } from './compress.js';
import { Mastodon } from './mastodon.js';

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
    charsetFromContentType(res.headers.get('content-type')) ??
    /<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(head)?.[1] ??
    'utf-8';
  return decodeBytes(bytes, charset);
}

/**
 * Some feeds glue a headline and a separate dek/subtitle into one <title>
 * via two back-to-back CDATA sections -- syntactically valid XML, but
 * xml2js (which rss-parser uses under the hood) concatenates their text
 * with nothing in between, so "Headline" + "Dek text" comes out as
 * "HeadlineDek text" with the join invisible until you notice a sentence
 * running into the next with no space. Inserting a single space at the
 * CDATA boundary itself, before parsing, fixes exactly that join without
 * risking any of the legitimate camelCase brand names (iPhone, DeepMind,
 * GitHub...) that live inside a single CDATA block untouched.
 */
export function fixAdjacentCdata(xml) {
  return xml.replace(/\]\]>\s*<!\[CDATA\[/g, ']]> <![CDATA[');
}

/** Fetch one feed and insert its new items. Returns the new-article count. */
export async function ingestFeed(db, feed, parser) {
  const parsed = await parser.parseString(fixAdjacentCdata(await fetchFeedXml(feed.url)));

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
      const title = item.title;
      if (!guid || !title || typeof title !== 'string') {
        skipped++;
        continue;
      }
      const content =
        item['content:encoded'] ?? item.content ?? item.summary ?? '';
      const { changes } = insert.run(
        feed.id,
        String(guid),
        httpUrl(item.link),
        title.trim(),
        item.creator ?? item.author ?? null,
        item.isoDate ?? null,
        compressText(sanitizeHtml(content)),
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
 * Fetch one Mastodon timeline (home feed). A single Mastodon account is
 * stored as one feed row with type='mastodon'. Each post becomes an article
 * with the poster's display name as author.
 */
export async function ingestMastodonFeed(db, feed, mastodon) {
  const sinceRow = db.prepare(`
    SELECT guid FROM articles WHERE feed_id = ? ORDER BY id DESC LIMIT 1
  `).get(feed.id);
  const sinceId = sinceRow?.guid?.startsWith('mastodon:')
    ? sinceRow.guid.slice(9)
    : null;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO articles
      (feed_id, guid, url, title, author, published_at, content)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const posts = await mastodon.homeTimeline(sinceId);
  let added = 0;

  db.transaction(() => {
    for (const post of posts) {
      const { changes } = insert.run(
        feed.id,
        post.guid,
        post.url,
        post.title,
        post.author,
        post.publishedAt,
        compressText(sanitizeHtml(post.content)),
      );
      added += changes;
    }
    db.prepare(`
      UPDATE feeds SET
        last_fetched_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
        last_status = 'ok',
        ok_count = ok_count + 1
      WHERE id = ?
    `).run(feed.id);
  })();

  return { added };
}

/**
 * Ensure the Mastodo timeline feed exists in the feeds table.
 * Called once on startup so the scheduler picks it up.
 */
export function syncMastodonFeed(db, config) {
  const m = new Mastodon(config.mastodon ?? {});
  if (!m.configured) return;
  db.prepare(`
    INSERT INTO feeds (url, title, html_url, type, active, fetch_interval_min)
    VALUES (?, 'Fediverse', ?, 'mastodon', 1, 5)
    ON CONFLICT (url) DO UPDATE SET active = 1
  `).run(config.mastodon.url, config.mastodon.url);

  // Update title for existing feed rows that still have the old default
  db.prepare("UPDATE feeds SET title = 'Fediverse' WHERE type = 'mastodon' AND title = 'Mastodon Home Timeline'").run();
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
    .prepare(`SELECT id, url, title, type, fetch_interval_min FROM feeds WHERE active = 1 ${due}`)
    .all();

  const mastodon = new Mastodon(config.mastodon ?? {});

  const summary = { feedsOk: 0, feedsFailed: 0, added: 0, skipped: 0, errors: [], feeds: [] };
  let index = 0;
  for (const feed of feeds) {
    index++;
    try {
      if (feed.type === 'mastodon') {
        if (!mastodon.configured) throw new Error('Mastodon not configured (url + token or username/password required)');
        const { added } = await ingestMastodonFeed(db, feed, mastodon);
        summary.feedsOk++;
        summary.added += added;
        summary.feeds.push({ url: feed.url, added, skipped: 0 });
        scheduleNextFetch(db, feed, config);
        onFeed?.({ url: feed.url, added, index, total: feeds.length });
      } else {
        const { added, skipped } = await ingestFeed(db, feed, parser);
        summary.feedsOk++;
        summary.added += added;
        summary.skipped += skipped;
        summary.feeds.push({ url: feed.url, added, skipped });
        scheduleNextFetch(db, feed, config);
        onFeed?.({ url: feed.url, added, skipped, index, total: feeds.length });
      }
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
