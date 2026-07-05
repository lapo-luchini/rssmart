// Copies browser builds of frontend dependencies out of node_modules so the
// frontend never depends on a CDN. Runs on npm install (postinstall).
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'public', 'vendor');
mkdirSync(dest, { recursive: true });
copyFileSync(
  join(root, 'node_modules', 'vue', 'dist', 'vue.esm-browser.prod.js'),
  join(dest, 'vue.esm-browser.prod.js'),
);
console.log('vendored vue.esm-browser.prod.js -> public/vendor/');
