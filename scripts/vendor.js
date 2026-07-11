// Fetches the pinned Vue browser build directly, rather than depending on
// the npm "vue" package. vue's own package.json depends on
// @vue/server-renderer (SSR, unused here — no server-side rendering),
// which pulls in @vue/compiler-sfc (SFC compilation, unused — no .vue
// files, no bundler), @vue/compiler-core/-dom/-ssr, @babel/parser and
// @babel/types: ~28MB of node_modules for code no path in this project
// ever reaches, since only this one self-contained browser build file is
// used. Verified against a pinned SHA-256 so a compromised CDN can't
// silently swap in different code for a file that runs in every visitor's
// browser. Skips the fetch entirely if the file's already vendored and
// verified, so a normal reinstall doesn't need network access.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VUE_VERSION = '3.5.39';
const SHA256 = '8fc5f1a672693f8b91112155461b0f121c47ea2386b91f7de64e2b39f14241bd';
const url = `https://cdn.jsdelivr.net/npm/vue@${VUE_VERSION}/dist/vue.esm-browser.prod.js`;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'public', 'vendor', 'vue.esm-browser.prod.js');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

if (existsSync(dest) && sha256(readFileSync(dest)) === SHA256) {
  console.log('vue.esm-browser.prod.js already vendored and verified, skipping fetch');
  process.exit(0);
}

mkdirSync(dirname(dest), { recursive: true });
const res = await fetch(url);
if (!res.ok) {
  throw new Error(`failed to fetch ${url}: ${res.status} ${res.statusText}`);
}
const buf = Buffer.from(await res.arrayBuffer());
const actual = sha256(buf);
if (actual !== SHA256) {
  throw new Error(
    `vue.esm-browser.prod.js checksum mismatch: expected ${SHA256}, got ${actual} — ` +
      'refusing to install unverified frontend code',
  );
}
writeFileSync(dest, buf);
console.log(`vendored vue.esm-browser.prod.js (v${VUE_VERSION}) -> public/vendor/, checksum verified`);
