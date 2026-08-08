import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, testConfig, startApp } from './helpers.js';
import { createApp } from '../src/server.js';
import { signSession, verifySession, passwordMatches } from '../src/auth.js';

test('signSession/verifySession: a session signed with one password fails against another', () => {
  const token = signSession('correct-horse');
  assert.ok(verifySession('correct-horse', token));
  assert.ok(!verifySession('wrong-password', token));
});

test('verifySession rejects an expired, missing, or malformed token', () => {
  assert.ok(!verifySession('pw', null));
  assert.ok(!verifySession('pw', ''));
  assert.ok(!verifySession('pw', 'not-even-two-parts'));
  const expired = signSession('pw', Date.now() - 1000);
  assert.ok(!verifySession('pw', expired));
});

test('passwordMatches is a plain, non-empty-aware string comparison', () => {
  assert.ok(passwordMatches('secret', 'secret'));
  assert.ok(!passwordMatches('secret', 'Secret'));
  assert.ok(!passwordMatches('secret', ''));
  assert.ok(!passwordMatches('secret', undefined));
});

function cookieFrom(res) {
  const raw = res.headers.get('set-cookie');
  return raw ? raw.split(';')[0] : null;
}

test('auth disabled (empty password): every route works with no cookie at all', async () => {
  const db = tempDb();
  const app = createApp(db, testConfig());
  const server = await startApp(app);
  try {
    const res = await fetch(`${server.url}/api/stats`);
    assert.equal(res.status, 200);
  } finally {
    await server.close();
  }
});

// Everything below shares one server (auth.password set) across tests --
// each individual test's requests all land on the same keep-alive
// connection either way, so there's no isolation cost to sharing it, and
// only one close() pays for however many requests ran against it.
let db;
let server;

before(async () => {
  db = tempDb();
  const app = createApp(db, testConfig({ auth: { password: 'letmein' } }));
  server = await startApp(app);
});

after(async () => {
  await server.close();
});

test('auth enabled: unauthenticated API calls are rejected, page loads redirect to the login page', async () => {
  const api = await fetch(`${server.url}/api/stats`);
  assert.equal(api.status, 401);

  const page = await fetch(`${server.url}/`, { redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login.html');

  // the login page itself must always be reachable, unauthenticated
  const login = await fetch(`${server.url}/login.html`);
  assert.equal(login.status, 200);
});

test('auth enabled: wrong password gets no cookie, correct password logs in and unlocks the API', async () => {
  const wrong = await fetch(`${server.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=nope',
  });
  assert.equal(wrong.status, 302);
  assert.ok(wrong.headers.get('location').includes('/login.html?error=1'));
  assert.equal(cookieFrom(wrong), null, 'no session cookie on a failed login');

  const right = await fetch(`${server.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=letmein',
  });
  assert.equal(right.status, 302);
  assert.equal(right.headers.get('location'), '/');
  const cookie = cookieFrom(right);
  assert.ok(cookie?.startsWith('rssmart_session='));

  const authed = await fetch(`${server.url}/api/stats`, { headers: { cookie } });
  assert.equal(authed.status, 200);

  const loggedOut = await fetch(`${server.url}/logout`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie },
  });
  assert.equal(loggedOut.status, 302);
  const clearedCookie = cookieFrom(loggedOut);
  assert.ok(clearedCookie?.startsWith('rssmart_session='));

  const afterLogout = await fetch(`${server.url}/api/stats`, { headers: { cookie: clearedCookie } });
  assert.equal(afterLogout.status, 401);
});

test('auth enabled: a session cookie signed with a different (old) password is rejected', async () => {
  const staleCookie = `rssmart_session=${signSession('old-password')}`;
  const res = await fetch(`${server.url}/api/stats`, { headers: { cookie: staleCookie } });
  assert.equal(res.status, 401);
});
