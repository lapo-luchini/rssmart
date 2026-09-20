import cleanHtml from 'sanitize-html';

// Feed HTML is untrusted even in a personal reader. Parse markup and use
// explicit tag, attribute and URL allowlists; regexes cannot model HTML's
// entity decoding or malformed-attribute recovery.

const DANGEROUS_BLOCKS =
  /<(script|style|iframe|object|embed|form)\b[\s\S]*?<\/\1\s*>/gi;
const HTML_POLICY = {
  allowedTags: [...cleanHtml.defaults.allowedTags, 'img', 'details', 'summary'],
  allowedAttributes: {
    '*': ['title', 'lang', 'dir'],
    a: ['href', { name: 'target', values: ['_blank', '_self'] }, 'rel'],
    img: ['src', 'srcset', 'alt', 'title', 'width', 'height', 'loading'],
    td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan', 'scope'],
    ol: ['start', 'reversed', 'type'], li: ['value'],
    time: ['datetime'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, rel: 'noopener noreferrer' },
    }),
  },
};

/** Remove active content from feed HTML, keeping formatting tags. */
export function sanitizeHtml(html) {
  if (!html) return '';
  return cleanHtml(String(html), HTML_POLICY);
}

/**
 * Truncate by code points, not UTF-16 code units: a plain slice() can cut
 * a string in the middle of a surrogate pair (e.g. emoji at the cut), the
 * remainder becoming lone surrogates that render as � and, worse, emit
 * invalid JSON when the text reaches an LLM prompt. Long count = max code
 * units minus one when the cut lands between a high and its low surrogate.
 */
export function truncate(str, max) {
  if (typeof str !== 'string' || str.length <= max) return str;
  let cut = str.slice(0, max);
  const last = cut.codePointAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
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
  const desc = truncate(alt || title, MAX_IMG_TEXT);
  if (!desc) return '[image]';
  let out = `[image: ${desc}]`;
  // Feeds almost always set at most one of the two (measured on this
  // archive: ~715 alt-only vs 3 both, two of those identical), so the
  // second attribute is usually absent or a duplicate. When it does carry
  // different text (Oglaf: alt = caption, title = a separate gag), it is
  // real extra signal — keep it.
  if (alt && title && title.toLowerCase() !== alt.toLowerCase()) {
    out += ` [image title: ${truncate(title, MAX_IMG_TEXT)}]`;
  }
  return out;
}
