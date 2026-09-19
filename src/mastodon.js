/**
 * Thin Mastodon API client for fetching the home timeline.
 * Supports both:
 *   - Bearer token (standard Mastodon personal access tokens)
 *   - HTTP Basic Auth (Friendica, which has no user-facing token UI)
 * Friendica's Mastodon-compatible API is also supported via Basic Auth.
 */

import { stripHtml } from './html.js';

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

  /** One raw page of the home timeline (wire order: newest first). */
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
   * Fetch the home timeline walking forward page by page (min_id) until we
   * have everything newer than sinceId. A single 40-post page would
   * silently drop the oldest of >40 posts created between runs — and they
   * would be lost permanently, since the next run's since_id derives from
   * the stored guid. maxPages bounds a single run; the next run continues
   * from the stored watermark, so even a maxPages-exhausted run loses
   * nothing permanently. Returns posts oldest-first.
   */
  async homeTimeline(sinceId, { maxPages = DEFAULT_MAX_PAGES } = {}) {
    const statuses = []; // accumulated raw statuses, deduped by id
    const byId = new Map();
    let minId = sinceId ?? null; // null: no filter, plain newest page
    for (let page = 0; page < maxPages; page++) {
      const batch = await this.homeTimelinePage(null, minId);
      if (!batch.length) break;
      for (const s of batch) if (!byId.has(s.id)) { byId.set(s.id, s); statuses.push(s); }
      if (batch.length < PAGE_LIMIT) break;
      // min_id walks upward: the next page covers posts newer than the
      // newest of this batch (Mastodon ids are snowflakes). The walk stops
      // once it reaches the watermark; the whole run stays bounded.
      minId = statuses.reduce((m, s) => Math.max(m, Number(s.id)), minId ? Number(minId) : 0);
      if (sinceId && Number(minId) <= Number(sinceId)) break; // watermark reached defensively
    }
    // oldest-first for the ingest loop; already-stored posts then dedupe
    // via INSERT OR IGNORE guid
    return statuses.sort((a, b) => Number(a.id) - Number(b.id)).map((s) => normalize(s, this.url)).reverse();
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
    title: plain.slice(0, 120) || '(no content)',
    content: html || plain,
    author: post.account?.display_name || acct,
    publishedAt: post.created_at,
  };
}
