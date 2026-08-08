import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'rssmart_session';

// Long-lived on purpose: this is a personal, single-password login (see
// config.example.yaml's auth.password), not a multi-user system with a
// real revocation list -- the only way to invalidate an outstanding
// session is to change the password, since the password is also the
// HMAC signing key below. A mobile/PWA install shouldn't get logged out
// mid-use just because six months have passed, so the window is wide.
export const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;

function hmac(key, message) {
  return createHmac('sha256', key).update(message).digest('hex');
}

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * A session cookie's value is just "<expiresAt>.<hmac>", signed with the
 * configured password itself as the HMAC key -- no separate secret to
 * generate, rotate, or persist across restarts, and changing the password
 * invalidates every outstanding session for free.
 */
export function signSession(password, expiresAt = Date.now() + SESSION_TTL_MS) {
  return `${expiresAt}.${hmac(password, String(expiresAt))}`;
}

export function verifySession(password, token) {
  if (!token) return false;
  const [expiresAt, mac] = token.split('.');
  if (!expiresAt || !mac) return false;
  if (!Number.isFinite(Number(expiresAt)) || Number(expiresAt) < Date.now()) return false;
  return timingSafeStringEqual(mac, hmac(password, expiresAt));
}

export function passwordMatches(configured, provided) {
  return typeof provided === 'string' && timingSafeStringEqual(configured, provided);
}
