import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchArticleText, isPrivateAddress } from '../src/fetchpage.js';
import { enrichPending } from '../src/enrich.js';
import { Ollama } from '../src/llm.js';
import { tempDb, startOllamaStub, testConfig } from './helpers.js';

const PARAGRAPH =
  'The quick brown fox jumps over the lazy dog while the committee deliberates ' +
  'at length about the merits of standardized testing infrastructure in modern ' +
  'software projects, and everyone agrees that reproducible fixtures matter. ';

const PAGE = `<!doctype html>
<html><head><title>Big Announcement</title></head>
<body>
  <nav><a href="/">home</a><a href="/about">about</a></nav>
  <article>
    <h1>Big Announcement</h1>
    <p>ZETAFRAME is a revolutionary new framework announced today. ${PARAGRAPH}</p>
    <p>${PARAGRAPH}</p>
    <p>${PARAGRAPH}</p>
  </article>
  <footer>copyright</footer>
  <script>alert('tracking')</script>
</body></html>`;

const FOOTER_PAGE = `<!doctype html>
<html><head><title>Prepatch</title></head>
<body>
  <article><p>Copyright notices and legal information for this site. All rights reserved by their creators. Trademarks belong to their registered owners worldwide.</p></article>
</body></html>`;

function startPageServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/article') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
      } else if (req.url === '/footer-only') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(FOOTER_PAGE);
      } else {
        res.writeHead(404).end('gone');
      }
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      }),
    );
  });
}

test('SSRF guard: private/loopback targets and exotic schemes are refused', async () => {
  const site = await startPageServer();
  try {
    // Default policy blocks the loopback stub; the explicit opt-in allows it.
    assert.equal(await fetchArticleText(`${site.url}/article`), null);
    assert.ok(await fetchArticleText(`${site.url}/article`, { allowPrivate: true }));
    assert.equal(await fetchArticleText('file:///etc/passwd', { allowPrivate: true }), null);
    assert.equal(await fetchArticleText('http://10.0.0.1/x'), null);
    assert.equal(await fetchArticleText('not a url'), null);
  } finally {
    await site.close();
  }

  for (const addr of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1',
                      '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1']) {
    assert.equal(isPrivateAddress(addr), true, `${addr} is private`);
  }
  for (const addr of ['1.1.1.1', '93.184.216.34', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(addr), false, `${addr} is public`);
  }
});

test('fetchArticleText extracts readable content, drops chrome and scripts', async () => {
  const site = await startPageServer();
  try {
    const page = await fetchArticleText(`${site.url}/article`, { allowPrivate: true });
    assert.ok(page.text.includes('ZETAFRAME is a revolutionary new framework'));
    assert.ok(!page.text.includes('copyright'));
    assert.ok(!page.html.includes('<script'));

    assert.equal(await fetchArticleText(`${site.url}/missing`, { allowPrivate: true }), null, '404 -> null');
    assert.equal(await fetchArticleText('http://127.0.0.1:1/x', { allowPrivate: true }), null, 'unreachable -> null');
  } finally {
    await site.close();
  }
});

test('thin RSS entries get their origin page fetched for the LLM; failures fall back', async () => {
  const db = tempDb();
  const site = await startPageServer();
  const stub = await startOllamaStub();
  try {
    db.prepare("INSERT INTO feeds (id, url) VALUES (1, 'http://f')").run();
    const ins = db.prepare(
      'INSERT INTO articles (feed_id, guid, url, title, content, published_at) VALUES (1, ?, ?, ?, ?, ?)',
    );
    // enrichment runs newest-first: 'thin' has the later date so it goes first
    const thin = Number(ins.run('g1', `${site.url}/article`, 'Big Announcement', '<a href="#">Comments</a>', '2026-07-02T00:00:00Z').lastInsertRowid);
    const dead = Number(ins.run('g2', `${site.url}/missing`, 'Gone page', 'Short RSS text only.', '2026-07-01T00:00:00Z').lastInsertRowid);
    // page extraction worse than the feed text (the LWN-footer case):
    // the RSS content must win and no full_content must be stored
    const RSS_ANNOUNCEMENT = 'The 7.2-rc2 kernel prepatch is out for testing. Linus said things look very normal, in line with recent releases and slightly smaller than rc2 was in 7.1, so far so good. '.repeat(2);
    const footer = Number(ins.run('g3', `${site.url}/footer-only`, 'Kernel prepatch', RSS_ANNOUNCEMENT, '2026-06-30T00:00:00Z').lastInsertRowid);

    const config = testConfig();
    const llm = new Ollama({ ...config.ollama, url: stub.url });
    const result = await enrichPending(db, config, llm);
    assert.equal(result.enriched, 3);

    const prompts = stub.calls.chat.map((c) => c.messages.at(-1).content);
    assert.ok(
      prompts[0].includes('ZETAFRAME is a revolutionary new framework'),
      'LLM saw the fetched page text, not the RSS stub',
    );
    assert.ok(prompts[1].includes('Short RSS text only.'), 'fetch failure falls back to RSS text');
    assert.ok(prompts[2].includes('kernel prepatch is out for testing'), 'feed text wins over a worse extraction');
    assert.ok(!prompts[2].includes('Copyright notices'), 'footer extraction not used');

    const rows = db.prepare('SELECT id, full_content FROM articles ORDER BY id').all();
    assert.ok(rows[0].full_content.includes('ZETAFRAME'), 'page content persisted');
    assert.equal(rows[1].full_content, null);
    assert.equal(rows[2].full_content, null, 'worse extraction not persisted');
    assert.equal(rows[0].id, thin);
    assert.equal(rows[1].id, dead);
    assert.equal(rows[2].id, footer);
  } finally {
    await stub.close();
    await site.close();
  }
});
