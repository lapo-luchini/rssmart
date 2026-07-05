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
