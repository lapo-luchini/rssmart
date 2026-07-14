/**
 * Thin Mastodon API client for fetching the home timeline.
 * Uses a personal access token, no OAuth dance.
 * Friendica's Mastodon-compatible API is also supported.
 */

const TIMEOUT_MS = 30_000;
const PAGE_LIMIT = 40;

export class Mastodon {
  constructor({ url, token } = {}) {
    this.url = url ? url.replace(/\/+$/, '') : '';
    this.token = token || '';
  }

  get configured() {
    return !!(this.url && this.token);
  }

  async #get(path, params = {}) {
    const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
    const res = await fetch(`${this.url}${path}${qs}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
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
   * Returns an array of normalized post objects:
   *   { id, guid, url, title, content, author, publishedAt }
   * Pass sinceId to get only posts newer than that ID.
   */
  async homeTimeline(sinceId) {
    const params = { limit: PAGE_LIMIT };
    if (sinceId) params.since_id = sinceId;
    // Fetch oldest-first so INSERT OR IGNORE works correctly
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
