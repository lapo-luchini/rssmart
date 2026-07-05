// Minimal OPML support: enough to exchange subscription lists with other
// feed readers. Parsing is attribute-based (no DOM) — OPML in the wild is
// flat outline elements with xmlUrl attributes.

const decode = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');

const encode = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Extract {url, title} feeds from an OPML document. */
export function parseOpml(xml) {
  const feeds = [];
  const seen = new Set();
  for (const m of String(xml).matchAll(/<outline\b[^>]*?xmlUrl\s*=\s*"([^"]+)"[^>]*>/gi)) {
    const url = decode(m[1]).trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const title = /(?:\btitle|\btext)\s*=\s*"([^"]*)"/i.exec(m[0])?.[1];
    const htmlUrl = /\bhtmlUrl\s*=\s*"([^"]*)"/i.exec(m[0])?.[1];
    feeds.push({
      url,
      title: title ? decode(title) : undefined,
      htmlUrl: htmlUrl ? decode(htmlUrl) : undefined,
    });
  }
  return feeds;
}

/** Build an OPML document from feed rows ({url, title, html_url}). */
export function buildOpml(feeds) {
  const outlines = feeds
    .map((f) =>
      `    <outline type="rss" text="${encode(f.title ?? f.url)}" xmlUrl="${encode(f.url)}"` +
      (f.html_url ? ` htmlUrl="${encode(f.html_url)}"` : '') +
      '/>')
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>rssmart subscriptions</title></head>
  <body>
${outlines}
  </body>
</opml>
`;
}
