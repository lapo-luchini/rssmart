import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { sanitizeHtml } from '../src/html.js';
import { tempDb, testConfig } from './helpers.js';
import { createApp } from '../src/server.js';
import { compressText } from '../src/compress.js';

function inspect(html) {
  // This DOM is a parser oracle only; the sanitizer does not use happy-dom.
  const window = new Window({ settings: {
    disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true,
    disableCSSFileLoading: true, disableIframePageLoading: true,
  } });
  window.document.body.innerHTML = html;
  return window;
}

test('HTML allowlist rejects encoded protocols, malformed handlers and active namespaces', () => {
  const dirty = `<a href="java&#x73;cript:globalThis.poc=1">link</a>
    <a href="jav&#9;ascript:globalThis.poc=2">tab</a>
    <img/onerror="globalThis.poc=3" src=x>
    <svg><a xlink:href="javascript:alert(1)">svg</a></svg>
    <math><mtext><img src=x onerror=alert(1)></mtext></math>
    <iframe srcdoc="<script>alert(1)</script>"></iframe>
    <form><input name=location></form><script>alert(1)</script>
    <img src="data:image/svg+xml,<svg onload=alert(1)>" style="position:fixed">
    <div id=app onclick=alert(1)>text</div>`;
  const safe = sanitizeHtml(dirty);
  const window = inspect(safe);
  assert.equal(window.document.querySelector('script,style,iframe,object,embed,form,input,svg,math'), null);
  for (const element of window.document.querySelectorAll('*')) {
    for (const attr of element.attributes) {
      assert.ok(!/^on/i.test(attr.name));
      assert.ok(!['style','id','srcdoc','xlink:href','name'].includes(attr.name));
      if (['src','href'].includes(attr.name)) assert.ok(!/^(javascript|vbscript|data):/i.test(attr.value.replace(/[\s\x00-\x1f]/g,'')));
    }
  }
  assert.equal(sanitizeHtml(safe), safe, 'sanitizing cached output is idempotent');
  window.close();
});

test('HTML allowlist preserves readable formatting, image descriptions and safe links', () => {
  const window = inspect(sanitizeHtml(`<h2>Title</h2><p>A <strong>bold</strong> paragraph.</p>
    <pre><code>x &lt; y</code></pre><table><tr><th scope=col>A</th><td colspan=2>B</td></tr></table>
    <img src="https://example.invalid/a.png" alt="comic joke" title="extra joke" width=500>
    <a href="https://example.invalid/read" target=_blank>Read</a>`));
  assert.equal(window.document.querySelector('code').textContent, 'x < y');
  assert.equal(window.document.querySelector('img').alt, 'comic joke');
  assert.equal(window.document.querySelector('img').title, 'extra joke');
  assert.equal(window.document.querySelector('td').getAttribute('colspan'), '2');
  assert.equal(window.document.querySelector('a').rel, 'noopener noreferrer');
  window.close();
});

test('article detail and reader sanitize legacy persisted markup at the final HTML boundary', async t => {
  const db = tempDb(); t.after(() => db.close());
  db.prepare("INSERT INTO feeds(id,url) VALUES(1,'https://example.invalid/feed')").run();
  const dirty = '<p>Text</p><img/onerror="globalThis.poc=1" src=x><a href="java&#x73;cript:alert(1)">link</a>';
  db.prepare(`INSERT INTO articles(id,feed_id,guid,title,status,content,full_content)
    VALUES(1,1,'legacy','Legacy','enriched',?,?)`).run(compressText(dirty),compressText(dirty));
  const app = createApp(db,testConfig());
  for (const path of ['/api/articles/1','/api/articles/1/reader']) {
    const response = await app.request(path);
    assert.equal(response.status,200);
    const result = await response.json();
    const html = result.html ?? result.content;
    const window = inspect(html);
    assert.equal(window.document.querySelector('img').hasAttribute('onerror'),false);
    assert.equal(window.document.querySelector('a').hasAttribute('href'),false);
    window.close();
  }
});
