import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { sanitizeHtml } from './html.js';

const MAX_REDIRECTS = 5;

/** Loopback, link-local, private (RFC 1918/4193), CGNAT, unspecified. */
export function isPrivateAddress(addr) {
  if (isIP(addr) === 4) {
    const o = addr.split('.').map(Number);
    return (
      o[0] === 0 ||
      o[0] === 10 ||
      o[0] === 127 ||
      (o[0] === 100 && o[1] >= 64 && o[1] <= 127) ||
      (o[0] === 169 && o[1] === 254) ||
      (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
      (o[0] === 192 && o[1] === 168)
    );
  }
  const a = addr.toLowerCase();
  return (
    a === '::' ||
    a === '::1' ||
    a.startsWith('fe8') || a.startsWith('fe9') ||
    a.startsWith('fea') || a.startsWith('feb') ||
    a.startsWith('fc') || a.startsWith('fd') ||
    a.startsWith('::ffff:')
  );
}

/**
 * SSRF guard: article URLs come from third-party feed content, so unless
 * allowPrivate is set they must be http(s) and must not resolve to an
 * internal address. (Residual risk: DNS rebinding between this check and
 * the connect — acceptable for a personal reader; a paranoid deployment
 * should firewall the process instead.)
 */
async function isAllowedUrl(url, allowPrivate) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (allowPrivate) return true;

  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return !isPrivateAddress(host);
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

/** Fetch with manual redirects, re-validating the target on every hop. */
async function guardedFetch(url, { timeoutMs, allowPrivate }) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await isAllowedUrl(current, allowPrivate))) return null;
    let res;
    try {
      res = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': 'rssmart/1.0 (personal RSS reader)' },
      });
    } catch {
      return null;
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) return null;
      current = new URL(location, current).href;
      continue;
    }
    return res.ok ? res : null;
  }
  return null;
}

/**
 * Fetch an article's origin page and extract its readable content
 * (Firefox reader mode via @mozilla/readability). Returns
 * { html, text } or null when the page can't be fetched or parsed —
 * callers fall back to the RSS-provided content.
 */
export async function fetchArticleText(
  url,
  { timeoutMs = 20_000, allowPrivate = false } = {},
) {
  const res = await guardedFetch(url, { timeoutMs, allowPrivate });
  if (!res) return null;
  const type = res.headers.get('content-type') ?? '';
  if (type && !type.includes('html')) return null;

  try {
    const dom = new JSDOM(await res.text(), { url });
    const article = new Readability(dom.window.document).parse();
    if (!article?.textContent?.trim()) return null;
    return {
      title: article.title?.trim() || null,
      html: sanitizeHtml(article.content),
      text: article.textContent.replace(/\s+/g, ' ').trim(),
    };
  } catch {
    return null;
  }
}
