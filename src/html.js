// Minimal HTML hygiene for feed-provided markup. This is a personal-use
// reader, not a hostile-input boundary: we strip active content (scripts,
// event handlers, javascript: URLs) and keep basic formatting.

const DANGEROUS_BLOCKS =
  /<(script|style|iframe|object|embed|form)\b[\s\S]*?<\/\1\s*>/gi;
const DANGEROUS_SELF = /<(script|style|iframe|object|embed|form)\b[^>]*\/?>/gi;
const EVENT_ATTRS = /\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_URLS = /\s(href|src)\s*=\s*(["']?)\s*javascript:[^"'\s>]*\2/gi;

/** Remove active content from feed HTML, keeping formatting tags. */
export function sanitizeHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(DANGEROUS_BLOCKS, '')
    .replace(DANGEROUS_SELF, '')
    .replace(EVENT_ATTRS, '')
    .replace(JS_URLS, ' $1=""');
}

/** Reduce HTML to plain text (for LLM prompts and embeddings). */
export function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(DANGEROUS_BLOCKS, ' ')
    .replace(/<img\b[^>]*>/gi, imgText)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Image-only posts (webcomic feeds, photo blogs) previously reduced to
// nothing at all here — the whole <img> tag vanished with every other tag —
// so the LLM had no raw material for the summary and the dedup embedding
// saw near-identical text for every episode of a series. Recover the image's
// own description into the text stream: alt, falling back to title (xkcd
// puts the joke in alt, the extra hover quip in title; some feeds only set
// one). Without either, a bare [image] placeholder at least marks the post
// as an image post.
const MAX_IMG_TEXT = 300;
const ATTR_RE = (name) =>
  new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');

function imgText(tag) {
  const attr = (name) => {
    const m = ATTR_RE(name).exec(tag);
    const v = m ? (m[2] ?? m[3] ?? m[4] ?? '') : '';
    return v
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  };
  const alt = attr('alt');
  const title = attr('title');
  const desc = (alt || title).slice(0, MAX_IMG_TEXT);
  if (!desc) return '[image]';
  let out = `[image: ${desc}]`;
  // Feeds almost always set at most one of the two (measured on this
  // archive: ~715 alt-only vs 3 both, two of those identical), so the
  // second attribute is usually absent or a duplicate. When it does carry
  // different text (Oglaf: alt = caption, title = a separate gag), it is
  // real extra signal — keep it.
  if (alt && title && title.toLowerCase() !== alt.toLowerCase()) {
    out += ` [image title: ${title.slice(0, MAX_IMG_TEXT)}]`;
  }
  return out;
}
