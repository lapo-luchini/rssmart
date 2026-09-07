import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describeFromDisk } from '../src/gitmeta.js';

// The no-binary reader must reproduce `git describe --tags --long` exactly
// (abbrev pinned to 7 for determinism). Both sides degrade to '' when git
// metadata is unavailable, so the test also passes on gitless machines.
test('describeFromDisk matches git describe --tags --long', () => {
  const expected = execFileSync('git', ['describe', '--tags', '--long', '--abbrev=7'], {
    encoding: 'utf8',
    cwd: process.cwd(),
  }).trim();
  assert.equal(describeFromDisk(process.cwd()), expected);
});

test('describeFromDisk survives a working tree without .git', () => {
  assert.equal(describeFromDisk('/tmp'), '');
});
