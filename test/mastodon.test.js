import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/mastodon.js';

test('normalize keeps a space between a toot\'s separately-<p>-wrapped paragraphs', () => {
  // The real shape reported live: a Fediverse post whose title came out
  // "...or sadfMRI scans..." because stripping tags to nothing (rather than
  // to a space) glued two adjacent <p> paragraphs together.
  const status = {
    id: '7491435',
    created_at: '2026-08-10T15:05:28.000Z',
    content: "<p>Dogs can tell if you're scared or sad</p><p>fMRI scans show happiness, fear, anger, and sadness have distinct brain activity patterns.</p>",
    account: { acct: 'someone@example.social', display_name: 'Someone' },
  };
  const out = normalize(status, 'https://example.social');
  const joined = "Dogs can tell if you're scared or sad fMRI scans show happiness, fear, anger, and sadness have distinct brain activity patterns.";
  assert.equal(out.title, joined.slice(0, 120));
  assert.ok(!out.title.includes('sadfMRI'), 'paragraphs must not run together');
});

test('normalize unwraps a boost to the original post', () => {
  const status = {
    id: 'wrapper-1',
    content: '',
    account: { acct: 'booster' },
    reblog: {
      content: '<p>Original toot</p>',
      url: 'https://example.social/@author/1',
      account: { acct: 'author', display_name: 'Author' },
      created_at: '2026-08-10T00:00:00.000Z',
    },
  };
  const out = normalize(status, 'https://example.social');
  assert.equal(out.title, 'Original toot');
  assert.equal(out.author, 'Author');
  assert.equal(out.url, 'https://example.social/@author/1');
});

test('normalize synthesizes a title/content for a media-only post', () => {
  const status = {
    id: 'media-1',
    content: '',
    account: { acct: 'photographer' },
    media_attachments: [{ type: 'image', description: 'a sunset over the sea' }],
  };
  const out = normalize(status, 'https://example.social');
  assert.equal(out.title, '[a sunset over the sea]');
  assert.equal(out.content, '[a sunset over the sea]');
});

test('normalize falls back to a placeholder for a truly empty post', () => {
  const status = { id: 'empty-1', content: '', account: { acct: 'nobody' } };
  const out = normalize(status, 'https://example.social');
  assert.equal(out.title, '(no content)');
});
