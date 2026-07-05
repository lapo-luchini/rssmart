import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchArticleText } from '../src/fetchpage.js';
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

function startPageServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/article') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
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

test('fetchArticleText extracts readable content, drops chrome and scripts', async () => {
  const site = await startPageServer();
  try {
    const page = await fetchArticleText(`${site.url}/article`);
    assert.ok(page.text.includes('ZETAFRAME is a revolutionary new framework'));
    assert.ok(!page.text.includes('copyright'));
    assert.ok(!page.html.includes('<script'));

    assert.equal(await fetchArticleText(`${site.url}/missing`), null, '404 -> null');
    assert.equal(await fetchArticleText('http://127.0.0.1:1/x'), null, 'unreachable -> null');
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
      'INSERT INTO articles (feed_id, guid, url, title, content) VALUES (1, ?, ?, ?, ?)',
    );
    const thin = Number(ins.run('g1', `${site.url}/article`, 'Big Announcement', '<a href="#">Comments</a>').lastInsertRowid);
    const dead = Number(ins.run('g2', `${site.url}/missing`, 'Gone page', 'Short RSS text only.').lastInsertRowid);

    const config = testConfig();
    const llm = new Ollama({ ...config.ollama, url: stub.url });
    const result = await enrichPending(db, config, llm);
    assert.equal(result.enriched, 2);

    const prompts = stub.calls.chat.map((c) => c.messages.at(-1).content);
    assert.ok(
      prompts[0].includes('ZETAFRAME is a revolutionary new framework'),
      'LLM saw the fetched page text, not the RSS stub',
    );
    assert.ok(prompts[1].includes('Short RSS text only.'), 'fetch failure falls back to RSS text');

    const rows = db.prepare('SELECT id, full_content FROM articles ORDER BY id').all();
    assert.ok(rows[0].full_content.includes('ZETAFRAME'), 'page content persisted');
    assert.equal(rows[1].full_content, null);
    assert.equal(rows[0].id, thin);
    assert.equal(rows[1].id, dead);
  } finally {
    await stub.close();
    await site.close();
  }
});
