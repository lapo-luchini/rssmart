import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { sanitizeHtml } from './html.js';

/**
 * Fetch an article's origin page and extract its readable content
 * (Firefox reader mode via @mozilla/readability). Returns
 * { html, text } or null when the page can't be fetched or parsed —
 * callers fall back to the RSS-provided content.
 */
export async function fetchArticleText(url, { timeoutMs = 20_000 } = {}) {
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'rssmart/1.0 (personal RSS reader)' },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const type = res.headers.get('content-type') ?? '';
  if (type && !type.includes('html')) return null;

  try {
    const dom = new JSDOM(await res.text(), { url });
    const article = new Readability(dom.window.document).parse();
    if (!article?.textContent?.trim()) return null;
    return {
      html: sanitizeHtml(article.content),
      text: article.textContent.replace(/\s+/g, ' ').trim(),
    };
  } catch {
    return null;
  }
}
