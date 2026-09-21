import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, testConfig } from './helpers.js';
import { createApp } from '../src/server.js';
import { webNavigationUrl } from '../src/html.js';

test('navigation accepts absolute web URLs and rejects active, relative and malformed schemes', () => {
  for (const value of [null, '', '/relative', '//example.invalid/path', 'javascript:alert(1)',
    ' \nJaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'data:text/html,hello',
    'vbscript:msgbox(1)', 'file:///tmp/file', 'https://[invalid']) {
    assert.equal(webNavigationUrl(value), null, String(value));
  }
  assert.equal(webNavigationUrl('https://example.invalid/path?q=1#part'), 'https://example.invalid/path?q=1#part');
  assert.equal(webNavigationUrl(' HTTP://example.invalid '), 'http://example.invalid/');
});

test('article navigation fields and feed website fields are filtered without rewriting stored URLs', async t => {
  const db = tempDb(); t.after(() => db.close());
  db.prepare("INSERT INTO feeds(id,url,html_url) VALUES(1,'https://example.invalid/feed','javascript:alert(1)')").run();
  db.prepare(`INSERT INTO articles(id,feed_id,guid,title,status,url,duplicate_of)
    VALUES(1,1,'a','A','enriched','javascript:alert(1)',NULL),
    (2,1,'b','B','enriched','data:text/html,bad',1),
    (3,1,'c','C','enriched','https://example.invalid/good',NULL)`).run();
  const app = createApp(db, testConfig());
  const get = async path => {
    const response = await app.request(path); assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await get('/api/articles/1')).url, null);
  assert.equal((await get('/api/articles/1/versions'))[0].url, null);
  const rows = (await get('/api/articles?view=all&dupes=1')).articles;
  assert.equal(rows.find(row => row.id===1).url, null);
  assert.equal(rows.find(row => row.id===3).url, 'https://example.invalid/good');
  assert.equal((await get('/api/feeds'))[0].html_url, null);
  assert.equal(db.prepare('SELECT url FROM articles WHERE id=1').get().url, 'javascript:alert(1)');
});
