import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripHtml, sanitizeHtml } from '../src/html.js';

test('stripHtml turns <img alt> into text so image-only posts keep their content', () => {
  assert.equal(stripHtml('<img src="x.png" alt="The joke">'), '[image: The joke]');
  assert.equal(stripHtml('<p>before</p><img src="x.png" alt="comic strip"><p>after</p>'), 'before [image: comic strip] after');
  // alt missing or empty -> bare placeholder
  assert.equal(stripHtml('<img src="x.png">'), '[image]');
  assert.equal(stripHtml('<img src="x.png" alt="">'), '[image]');
  assert.equal(stripHtml('<img src="x.png" alt="   ">'), '[image]');
});

test('stripHtml falls back to the title attribute when alt is empty', () => {
  assert.equal(stripHtml('<img src="x.png" alt="" title="hover joke">'), '[image: hover joke]');
  assert.equal(stripHtml('<img src="x.png" title="only title">'), '[image: only title]');
  // alt wins when both exist (xkcd pattern: alt = joke, title = extra)
  assert.equal(stripHtml('<img src="x.png" alt="joke" title="extra">'), '[image: joke]');
});

test('stripHtml handles attribute quoting styles, entities and length caps in alt text', () => {
  assert.equal(stripHtml("<img src='x.png' alt='single quoted'>"), '[image: single quoted]');
  assert.equal(stripHtml('<img src=x.png alt=unquoted>'), '[image: unquoted]');
  assert.equal(stripHtml('<img src="x.png" alt="tom &amp; jerry">'), '[image: tom & jerry]');
  assert.equal(stripHtml('<img src="x.png" alt="  spaced\n\tout  ">'), '[image: spaced out]');
  const long = 'a'.repeat(500);
  assert.equal(stripHtml(`<img src="x.png" alt="${long}">`), `[image: ${'a'.repeat(300)}]`);
});

test('stripHtml keeps one marker per image and leaves non-image markup alone', () => {
  assert.equal(
    stripHtml('<img src="a.png" alt="one"> text <img src="b.png" alt="two">'),
    '[image: one] text [image: two]',
  );
  assert.equal(stripHtml('<p>hello <b>world</b></p>'), 'hello world');
  // images inside stripped active content vanish entirely, like the block
  assert.equal(stripHtml('<script><img src="x.png" alt="evil"></script>ok'), 'ok');
  // stored HTML is untouched: placeholders only exist in the text extraction
  assert.equal(sanitizeHtml('<img src="x.png" alt="kept">'), '<img src="x.png" alt="kept">');
});
