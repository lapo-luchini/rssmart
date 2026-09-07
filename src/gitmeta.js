// Read just enough git metadata to produce a `git describe --tags --long`
// style version string ("1.0.0-36-g5ef3d72") without executing the git
// binary: HEAD, refs (loose + packed-refs), and loose object files
// (zlib-inflated, header-parsed). Anything that can't be resolved — packed
// objects, shallow clones, missing files — degrades to an empty string and
// the caller falls back to commit-hash-only versioning; the application
// never requires git to run.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';

const readText = (p) => {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
};

/** Locate the git directory for a working tree; handles the `.git` file
 *  form used by worktrees ("gitdir: <path>") and the commondir indirection
 *  of linked worktrees (refs/objects live in the main git directory). */
function locateGitDir(base) {
  const dotGit = join(base, '.git');
  if (!existsSync(dotGit)) return null;
  if (statSync(dotGit).isDirectory()) return { head: dotGit, refs: dotGit };
  const gitdir = readText(dotGit)?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
  if (!gitdir) return null;
  const resolved = gitdir.startsWith('/') ? gitdir : join(base, gitdir);
  // refs and objects live in the common directory for linked worktrees
  const commondir = readText(join(resolved, 'commondir'))?.trim();
  return {
    head: resolved,
    refs: commondir ? (commondir.startsWith('/') ? commondir : join(resolved, commondir)) : resolved,
  };
}

/** tag name -> commit hash, from loose refs and packed-refs. Annotated
 *  tags point at a tag object, not the commit — loose tag objects are
 *  read and their `object <hash>` line resolved (packed-refs carries the
 *  peeled commit as the following `^<hash>` line directly). */
function readTagCommits(gitDir) {
  const out = new Map(); // commit hash -> tag name (first wins)
  const add = (name, hash) => { if (hash && !out.has(hash)) out.set(hash, name); };

  const tagsDir = join(gitDir, 'refs', 'tags');
  if (existsSync(tagsDir)) {
    const walk = (dir, prefix) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
        else add(prefix + entry.name, readText(full)?.trim());
      }
    };
    walk(tagsDir, '');
  }

  const packed = readText(join(gitDir, 'packed-refs'));
  if (packed) {
    let lastName = null;
    for (const line of packed.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('^')) { // peeled commit of the previous annotated tag
        if (lastName) add(lastName, trimmed.slice(1).trim());
        lastName = null;
        continue;
      }
      const sp = trimmed.indexOf(' ');
      if (sp < 0) continue;
      const hash = trimmed.slice(0, sp);
      const name = trimmed.slice(sp + 1);
      lastName = null;
      if (name.startsWith('refs/tags/')) {
        lastName = name.slice('refs/tags/'.length);
        add(lastName, hash); // lightweight tag: ref points straight at the commit
      }
    }
  }

  // resolve annotated tag refs: their hash names a tag object whose body
  // ("object <commit>\ntype commit\n...") names the actual commit
  for (const [hash, name] of [...out]) {
    const obj = readLooseObject(gitDir, hash);
    if (obj?.type === 'tag') {
      const commit = obj.data.toString().match(/^object ([0-9a-f]{40})$/m)?.[1];
      if (commit) add(name, commit);
    }
  }
  return out;
}

function headHash(gitDir) {
  const head = readText(join(gitDir, 'HEAD'));
  if (!head) return null;
  const trimmed = head.trim();
  if (!trimmed.startsWith('ref: ')) return trimmed; // detached HEAD
  return readText(join(gitDir, trimmed.slice(5)))?.trim() ?? null;
}

/** Parse a loose object file: "<type> <size>\0<zlib payload>". */
function readLooseObject(gitDir, hash) {
  const path = join(gitDir, 'objects', hash.slice(0, 2), hash.slice(2));
  if (!existsSync(path)) return null;
  const raw = inflateSync(readFileSync(path));
  const nul = raw.indexOf(0);
  const header = raw.subarray(0, nul).toString(); // e.g. "commit 245"
  return { type: header.slice(0, header.indexOf(' ')), data: raw.subarray(nul + 1) };
}

function parentsOf(commitData) {
  return [...commitData.toString().matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1]);
}

/**
 * The `git describe --tags --long --abbrev=7` equivalent:
 * "<nearest tag name>-<commits since it>-g<abbreviated HEAD hash>", or the
 * abbreviated HEAD hash alone when no tag is reachable from HEAD (git's
 * --always fallback), or '' when anything can't be resolved from disk.
 */
export function describeFromDisk(base = process.cwd()) {
  try {
    const located = locateGitDir(base);
    if (!located) return '';
    const gitDir = located.refs;

    const tagCommits = readTagCommits(gitDir);
    const head = headHash(located.head);
    if (!head) return '';

    // breadth-first from HEAD: the first tagged commit encountered sits at
    // the minimum commit distance, matching git's choice on linear history
    let frontier = [head];
    const seen = new Set();
    for (let depth = 0; frontier.length; depth++) {
      const tagged = frontier.find((h) => tagCommits.has(h));
      if (tagged != null) {
        return `${tagCommits.get(tagged)}-${depth}-g${head.slice(0, 7)}`;
      }
      const next = [];
      for (const h of frontier) {
        if (seen.has(h)) continue;
        seen.add(h);
        const obj = readLooseObject(gitDir, h);
        if (!obj || obj.type !== 'commit') continue;
        for (const parent of parentsOf(obj.data)) {
          if (!seen.has(parent)) next.push(parent);
        }
      }
      frontier = next;
    }
    return head.slice(0, 7); // no tag reachable — git's --always fallback
  } catch {
    return '';
  }
}
