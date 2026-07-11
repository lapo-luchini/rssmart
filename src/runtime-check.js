import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { logError, log } from './log.js';

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
);

function parseVersion(v) {
  const [major, minor = 0, patch = 0] = v.replace(/^v/, '').split('.').map(Number);
  return { major, minor, patch };
}

function atLeast(actual, required) {
  const a = parseVersion(actual);
  const r = parseVersion(required.replace(/^>=/, ''));
  if (a.major !== r.major) return a.major > r.major;
  if (a.minor !== r.minor) return a.minor > r.minor;
  return a.patch >= r.patch;
}

/**
 * Embeddings are stored as Float16Array bytes (src/enrich.js's bufToVec,
 * src/llm.js's Ollama.embed) — native Float16Array support is why the
 * project requires Node >=24 (already present in every Bun this project
 * supports). Checked directly rather than just comparing version numbers:
 * the version is a proxy, the typed array is the actual thing that breaks.
 * Missing it isn't recoverable — every embed/search call would throw or,
 * worse, silently store the wrong bytes — so this exits rather than warns.
 */
export function checkRuntime() {
  if (typeof Float16Array === 'undefined') {
    logError(
      'Float16Array is not available in this runtime — rssmart stores embeddings ' +
        `as native float16 and requires Node ${pkg.engines.node} or Bun ${pkg.engines.bun}. ` +
        `Detected: ${typeof Bun !== 'undefined' ? `Bun ${Bun.version}` : `Node ${process.version}`}.`,
    );
    process.exit(1);
  }

  const isBun = typeof Bun !== 'undefined';
  const required = isBun ? pkg.engines.bun : pkg.engines.node;
  const actual = isBun ? Bun.version : process.version;
  if (required && !atLeast(actual, required)) {
    log(
      `warning: running ${isBun ? 'Bun' : 'Node'} ${actual}, but rssmart is only tested on ` +
        `${isBun ? 'Bun' : 'Node'} ${required} — things may not work as expected.`,
    );
  }
}
