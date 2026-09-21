import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { describeFromDisk } from '../src/gitmeta.js';

// Independent of the checkout's refs, object packing, tags and installed
// git binary. The reader describes loose history on a best-effort basis.
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
};
const objectPath = (gitDir, hash) => join(gitDir, 'objects', hash.slice(0, 2), hash.slice(2));
function looseObject(gitDir, type, body) {
  const content = Buffer.from(body);
  const object = Buffer.concat([Buffer.from(`${type} ${content.length}\0`), content]);
  const hash = createHash('sha1').update(object).digest('hex');
  write(objectPath(gitDir, hash), deflateSync(object));
  return hash;
}
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'rssmart-gitmeta-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const gitDir = join(base, '.git');
  const tree = looseObject(gitDir, 'tree', '');
  const identity = 'Fixture <fixture@example.invalid> 1700000000 +0000';
  const root = looseObject(gitDir, 'commit', `tree ${tree}\nauthor ${identity}\ncommitter ${identity}\n\nRoot\n`);
  const head = looseObject(gitDir, 'commit', `tree ${tree}\nparent ${root}\nauthor ${identity}\ncommitter ${identity}\n\nSecond\n`);
  write(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  write(join(gitDir, 'refs/heads/main'), head + '\n');
  return { base, gitDir, root, head };
}

test('describeFromDisk describes a linear loose history with a lightweight tag', (t) => {
  const { base, gitDir, root, head } = fixture(t);
  write(join(gitDir, 'refs/tags/v1.0.0'), root + '\n');
  assert.equal(describeFromDisk(base), `v1.0.0-1-g${head.slice(0, 7)}`);
});

test('describeFromDisk resolves loose annotated tags and packed tag refs with peeled commits', (t) => {
  const { base, gitDir, root, head } = fixture(t);
  const tag = looseObject(gitDir, 'tag', `object ${root}\ntype commit\ntag v1.0.0\ntagger Fixture <fixture@example.invalid> 1700000000 +0000\n\nRelease\n`);
  const tagPath = join(gitDir, 'refs/tags/v1.0.0');
  write(tagPath, tag + '\n');
  assert.equal(describeFromDisk(base), `v1.0.0-1-g${head.slice(0, 7)}`);
  rmSync(tagPath);
  rmSync(objectPath(gitDir, tag));
  write(join(gitDir, 'packed-refs'), `# pack-refs with: peeled fully-peeled\n${tag} refs/tags/v1.0.0\n^${root}\n`);
  assert.equal(describeFromDisk(base), `v1.0.0-1-g${head.slice(0, 7)}`);
});

test('unavailable loose objects use the abbreviated HEAD fallback instead of promising git describe parity', (t) => {
  const { base, gitDir, root, head } = fixture(t);
  write(join(gitDir, 'refs/tags/v1.0.0'), root + '\n');
  // The parser intentionally ignores packfiles. HEAD is resolvable, but
  // its loose object is unavailable, as with packed/incomplete history.
  rmSync(objectPath(gitDir, head));
  assert.equal(describeFromDisk(base), head.slice(0, 7));
});

test('a tag-free loose history uses the abbreviated HEAD fallback', (t) => {
  const { base, head } = fixture(t);
  assert.equal(describeFromDisk(base), head.slice(0, 7));
});

test('detached linked worktrees resolve their common object and tag directory', (t) => {
  const { base, gitDir, root, head } = fixture(t);
  write(join(gitDir, 'refs/tags/v1.0.0'), root + '\n');
  const linked = join(base, 'linked');
  const worktreeGit = join(gitDir, 'worktrees/linked');
  write(join(linked, '.git'), 'gitdir: ../.git/worktrees/linked\n');
  write(join(worktreeGit, 'HEAD'), head + '\n');
  write(join(worktreeGit, 'commondir'), '../..\n');
  assert.equal(describeFromDisk(linked), `v1.0.0-1-g${head.slice(0, 7)}`);
});

test('missing refs, corrupt loose objects and missing git directories degrade to an empty description', (t) => {
  const { base, gitDir, head } = fixture(t);
  write(objectPath(gitDir, head), 'not a zlib object');
  assert.equal(describeFromDisk(base), '');
  rmSync(join(gitDir, 'refs/heads/main'));
  assert.equal(describeFromDisk(base), '');
  const noGit = join(base, 'no-git');
  mkdirSync(noGit);
  assert.equal(describeFromDisk(noGit), '');
});
