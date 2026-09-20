/**
 * Thin Mastodon API client for fetching the home timeline.
 * Supports both:
 *   - Bearer token (standard Mastodon personal access tokens)
 *   - HTTP Basic Auth (Friendica, which has no user-facing token UI)
 * Friendica's Mastodon-compatible API is also supported via Basic Auth.
 */

import { stripHtml, truncate } from './html.js';

const TIMEOUT_MS = 30_000;
const PAGE_LIMIT = 40;
const DEFAULT_MAX_PAGES = 10;

export class Mastodon {
  constructor({ url, token, username, password } = {}) {
    this.url = url ? url.replace(/\/+$/, '') : '';
    this.token = token || '';
    this.username = username || '';
    this.password = password || '';
  }

  get configured() {
    return !!(this.url && (this.token || (this.username && this.password)));
  }

  get #authHeader() {
    if (this.token) return `Bearer ${this.token}`;
    const b64 = Buffer.from(`${this.username}:${this.password}`).toString('base64');
    return `Basic ${b64}`;
  }

  async #get(path, params = {}) {
    const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
    const res = await fetch(`${this.url}${path}${qs}`, {
      headers: {
        Authorization: this.#authHeader,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Mastodon API ${path} -> ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  /**
   * One raw page of the home timeline (wire order: newest first). Only one
   * of sinceId/min_id may be passed: Mastodon gives since_id precedence,
   * so a walk that should continue upward must not set both.
   */
  async homeTimelinePage(sinceId, minId) {
    const params = { limit: PAGE_LIMIT };
    if (minId) params.min_id = minId;
    else if (sinceId) params.since_id = sinceId;
    return this.#get('/api/v1/timelines/home', params);
  }

  /**
   * Fetch posts immediately newer than sinceId using min_id, bounded by
   * maxPages. Pages arrive newest-first; reversing each page preserves
   * the server's order without comparing opaque status IDs. The final
   * returned post is the exact forward cursor for the next run.
   * Without a cursor, seed from one recent page (no historical backfill).
   * Returns normalized posts oldest-first.
   */
  async homeTimeline(sinceId, { maxPages = DEFAULT_MAX_PAGES } = {}) {
    if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
      throw new RangeError('Mastodon maxPages must be a positive integer');
    }
    if (sinceId != null && (typeof sinceId !== 'string' || !sinceId)) {
      throw new TypeError('Mastodon cursor must be a non-empty string');
    }
    const statuses = [];
    const seen = new Set(sinceId == null ? [] : [sinceId]);
    let minId = sinceId ?? null;
    for (let page = 0; page < maxPages; page++) {
      const batch = await this.homeTimelinePage(null, minId);
      if (!Array.isArray(batch) || batch.some((s) => typeof s?.id !== 'string' || !s.id)) {
        throw new TypeError('Mastodon timeline must contain string status IDs');
      }
      if (!batch.length) break;
      const nextId = batch[0].id; // newest in this page, exactly as serialized
      if (seen.has(nextId)) {
        throw new Error('Mastodon timeline did not advance its cursor');
      }
      const newStatuses = [];
      for (const s of batch) {
        if (!seen.has(s.id)) { seen.add(s.id); newStatuses.push(s); }
      }
      statuses.push(...newStatuses.reverse());
      minId = nextId;
      if (sinceId == null) break;
      // A short page need not mean the end (filters/server-side limits).
      // Continue until an empty page or the per-run page budget.
    }
    return statuses.map((s) => normalize(s, this.url));
  }
}

export function normalize(status, instanceUrl) {
  // Boosts (reblogs) have content='' in the wrapper; the real post is nested.
  const post = status.reblog ?? status;
  const acct = post.account?.acct ?? 'unknown';
  const html = post.content ?? '';
  // Mastodon wraps each paragraph of a toot in its own <p> -- stripping tags
  // to nothing (rather than to a space, like stripHtml does) glues adjacent
  // paragraphs together with no separator at all, e.g. "...or sad</p><p>fMRI
  // scans..." -> "...or sadfMRI scans...". Confirmed live on a synced
  // production DB: a Fediverse post's title came out exactly this way.
  let plain = stripHtml(html);

  // Media-only posts (images/video with no text): synthesize a minimal
  // title and content so the LLM has something to classify.
  if (!plain && post.media_attachments?.length) {
    const media = post.media_attachments.map((m) => m.description || m.type || 'media');
    plain = `[${media.join(', ')}]`;
  }

  return {
    id: status.id,
    guid: `mastodon:${status.id}`,
    url: post.url || post.uri || status.url || `${instanceUrl}/@${acct}/${status.id}`,
    title: truncate(plain, 120) || '(no content)',
    content: html || plain,
    author: post.account?.display_name || acct,
    publishedAt: post.created_at,
  };
}
