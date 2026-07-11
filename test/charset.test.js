import { test } from 'node:test';
import assert from 'node:assert/strict';
import { charsetFromContentType, decodeBytes } from '../src/charset.js';

test('charsetFromContentType extracts a charset label, quoted or not', () => {
  assert.equal(charsetFromContentType('text/html; charset=iso-8859-1'), 'iso-8859-1');
  assert.equal(charsetFromContentType('text/html; charset="windows-1252"'), 'windows-1252');
  assert.equal(charsetFromContentType('text/html'), null);
  assert.equal(charsetFromContentType(null), null);
  assert.equal(charsetFromContentType(undefined), null);
});

test('decodeBytes decodes with the given charset, falling back to UTF-8 for unknown labels', () => {
  const bytes = Buffer.from('città però', 'latin1');
  assert.equal(decodeBytes(bytes, 'iso-8859-1'), 'città però');
  assert.equal(decodeBytes(bytes, 'not-a-real-charset'), bytes.toString('utf8'));
  assert.equal(decodeBytes(Buffer.from('plain ascii'), null), 'plain ascii');
});
