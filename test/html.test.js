import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripHtml, sanitizeHtml, truncate } from '../src/html.js';

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
  assert.equal(stripHtml('<img src="x.png" alt="joke" title="extra">'), '[image: joke] [image title: extra]');
  // ...but a title that merely duplicates alt adds no second marker
  assert.equal(stripHtml('<img src="x.png" alt="joke" title="joke">'), '[image: joke]');
  assert.equal(stripHtml('<img src="x.png" alt="Joke" title="joke">'), '[image: Joke]');
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

test('truncate cuts at code points, never inside a surrogate pair', () => {
  const emoji = '🙂'; // one code point, two UTF-16 code units (a surrogate pair)
  const text = 'ab' + emoji + 'cd';
  // a naive slice(0, 3) ends with the lone high surrogate -> U+FFFD garbage,
  // and JSON.stringify emits an invalid escape for it
  const cut = truncate(text, 3);
  assert.equal(cut, 'ab');
  assert.ok(!JSON.stringify(cut).match(/\\uD[89A-F]/), 'no lone surrogates in JSON');
  // untouched when short enough or ending exactly on a pair boundary
  assert.equal(truncate(text, 4), 'ab' + emoji);
  assert.equal(truncate('abc', 10), 'abc');
  assert.equal(truncate(text, 2), 'ab', 'no high surrogate to trim, plain slice');
  // astral emoji + zwj sequences also end cleanly (dropping a trailing lone
  // surrogate is the requirement; cutting between ZWJ members is allowed)
  const family = '👩‍👩‍👧‍👦'; // several joined code points, all astral
  const cut2 = truncate('xx' + family, 3);
  assert.equal(cut2, 'xx', 'a pair at the cut is dropped whole');
  const cut3 = truncate('x' + family, 1 + family.length);
  assert.equal(cut3, 'x' + family, 'a boundary inside the sequence keeps it whole');
});

