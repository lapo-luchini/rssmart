// Vendor KaTeX (rendered math, e.g. "$x_i$") into public/vendor/katex/.
// Vendor pattern copied from scripts/vendor.js: fetch the pinned npm
// tarball once, verify its SHA-256 (so a compromised CDN can't silently
// swap in different code that runs in every visitor's browser), then
// extract exactly the files the reader needs: the ESM build, the
// auto-render extension (its relative `import katex from '../katex.mjs'`
// keeps working), the stylesheet and the woff2 font files (KaTeX's
// modern first-choice font format; browsers that speak woff2 never
// request the .woff/.ttf fallbacks). Vendored files are overwritten on
// each run of this script, so bumping the version is: change VERSION +
// SHA256 here, run once. `npm test` doesn't touch it; reinstalls don't
// need network access (the committed files stay in place).

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const KATEX_VERSION = '0.18.9';
const TARBALL_SHA256 = '78174318fa53363e4321ac3c10b39d3598aaa73a92dc75362eb08b16f6705782';
const url = `https://registry.npmjs.org/katex/-/katex-${KATEX_VERSION}.tgz`;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'public', 'vendor', 'katex');

const files = {
  'package/dist/katex.mjs': 'katex.mjs',
  'package/dist/katex.min.css': 'katex.min.css',
  'package/dist/contrib/auto-render.mjs': 'contrib/auto-render.mjs',
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Re-vendor only when something is missing: normal reinstalls (the
// vendored files are gitignored like Vue's) run this after every
// npm install, offline-capable once the vendored copy exists.
function vendoredComplete() {
  try {
    for (const rel of Object.values(files)) {
      if (!existsSync(join(dest, rel))) return false;
    }
    return readdirSync(join(dest, 'fonts')).some((f) => f.endsWith('.woff2'));
  } catch {
    return false;
  }
}

function extract(tgz) {
  const tmp = join(tmpdir(), `rssmart-katex-${Date.now()}`);
  mkdirSync(join(tmp, 'dist', 'contrib'), { recursive: true });
  // Member list: the three code/css files plus every woff2 font.
  const list = spawnSync('tar', ['-tz'], { input: tgz });
  if (list.status !== 0) throw new Error(`tar list failed: ${list.stderr?.toString()}`);
  const fonts = list.stdout.toString().split('\n').filter((n) => n.startsWith('package/dist/fonts/') && n.endsWith('.woff2'));
  const members = [...Object.keys(files), ...fonts];
  const res = spawnSync('tar', ['-xz', '-C', tmp, ...members], { input: tgz, maxBuffer: 1 << 30 });
  if (res.status !== 0) throw new Error(`tar extract failed: ${res.stderr?.toString()}`);
  for (const [src, rel] of Object.entries(files)) {
    const out = join(dest, rel);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, readFileSync(join(tmp, src)));
  }
  const fontDest = join(dest, 'fonts');
  mkdirSync(fontDest, { recursive: true });
  for (const font of fonts) {
    const name = font.slice('package/dist/fonts/'.length);
    writeFileSync(join(fontDest, name), readFileSync(join(tmp, font)));
  }
  rmSync(tmp, { recursive: true, force: true });
}

if (vendoredComplete()) {
  console.log('katex already vendored, skipping fetch');
  process.exit(0);
}

const res = await fetch(url);
if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status} ${res.statusText}`);
const tgz = Buffer.from(await res.arrayBuffer());
const actual = sha256(tgz);
if (actual !== TARBALL_SHA256) {
  throw new Error(`katex tarball checksum mismatch: expected ${TARBALL_SHA256}, got ${actual} — refusing to install unverified frontend code`);
}
extract(tgz);
console.log(`vendored katex ${KATEX_VERSION} -> public/vendor/katex/ (tarball checksum verified)`);
