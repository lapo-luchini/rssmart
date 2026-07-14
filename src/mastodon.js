/**
 * Thin Mastodon API client for fetching the home timeline.
 * Supports both:
 *   - Bearer token (standard Mastodon personal access tokens)
 *   - HTTP Basic Auth (Friendica, which has no user-facing token UI)
 * Friendica's Mastodon-compatible API is also supported via Basic Auth.
 */

const TIMEOUT_MS = 30_000;
const PAGE_LIMIT = 40;

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
   * Fetch the home timeline, oldest-first for backfill.
   * Pass sinceId to get only posts newer than that ID.
   */
  async homeTimeline(sinceId) {
    const params = { limit: PAGE_LIMIT };
    if (sinceId) params.since_id = sinceId;
    const posts = await this.#get('/api/v1/timelines/home', params);
    return posts.map((s) => normalize(s, this.url)).reverse();
  }
}

function normalize(status, instanceUrl) {
  const acct = status.account?.acct ?? 'unknown';
  const html = status.content ?? '';
  const plain = html.replace(/<[^>]*>/g, '').trim();

  return {
    id: status.id,
    guid: `mastodon:${status.id}`,
    url: status.url || `${instanceUrl}/@${acct}/${status.id}`,
    title: plain.slice(0, 120) || '(no content)',
    content: html,
    author: status.account?.display_name || acct,
    publishedAt: status.created_at,
  };
}
