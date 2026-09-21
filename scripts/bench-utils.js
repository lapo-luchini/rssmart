// Shared measurement helpers; importing this module performs no benchmark.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Stored duplicate links are proxy labels, not independently judged events.
 * Sample unordered, unique cross-group negatives from same-feed articles
 * within the time window. Absence of a link does not establish a negative
 * ground-truth label. The recorded pairs make that assumption auditable.
 */
export function selectDedupPairs(db, { positiveCount = 800, negativeCount = 800, seed = 7, windowDays = 14 } = {}) {
  for (const value of [positiveCount, negativeCount, seed]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('pair counts and seed must be nonnegative safe integers');
  }
  if (!Number.isFinite(windowDays) || windowDays < 0) throw new Error('windowDays must be finite and nonnegative');
  let state = seed >>> 0;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000;
  const pool = db.prepare(`
    SELECT id AS dup_id, duplicate_of AS root_id FROM articles
    WHERE duplicate_of IS NOT NULL ORDER BY id
  `).all();
  const positives = [];
  for (let i = 0; i < Math.min(positiveCount, pool.length); i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
    positives.push(pool[i]);
  }
  const ids = [...new Set(positives.flatMap((p) => [p.dup_id, p.root_id]))].sort((a, b) => a - b);
  const articles = ids.length ? db.prepare(`
    SELECT id, feed_id, title, summary, published_at, duplicate_of,
           COALESCE(duplicate_of, id) AS event_id
    FROM articles WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id
  `).all(...ids) : [];
  const byId = new Map(articles.map((a) => [a.id, a]));
  for (const a of articles) {
    if (a.duplicate_of != null && (a.duplicate_of === a.id || byId.get(a.duplicate_of)?.duplicate_of !== null)) {
      throw new Error('benchmark requires flat duplicate groups with existing roots; repair a separate copy first');
    }
  }
  const byFeed = new Map();
  for (const a of articles) {
    const date = a.published_at ? Date.parse(a.published_at) : NaN;
    if (!Number.isFinite(date)) continue;
    if (!byFeed.has(a.feed_id)) byFeed.set(a.feed_id, []);
    byFeed.get(a.feed_id).push({ ...a, date });
  }
  const negatives = [];
  let availableNegatives = 0;
  // Reservoir sampling bounds memory; enumerating i<j prevents replacement
  // duplicates and reversed copies without a rejection-loop termination risk.
  for (const feed of byFeed.values()) {
    for (let i = 0; i < feed.length; i++) {
      for (let j = i + 1; j < feed.length; j++) {
        const a = feed[i], b = feed[j];
        if (a.event_id === b.event_id || Math.abs(a.date - b.date) > windowDays * 86400000) continue;
        const pair = [a.id, b.id];
        availableNegatives++;
        if (negatives.length < negativeCount) negatives.push(pair);
        else {
          const replacement = Math.floor(random() * availableNegatives);
          if (replacement < negativeCount) negatives[replacement] = pair;
        }
      }
    }
  }
  negatives.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return {
    positives, negatives, articles,
    manifest: {
      version: 1, seed, windowDays, schemaVersion: db.prepare('PRAGMA user_version').get().user_version,
      labels: 'stored links versus unlinked cross-group candidates; not human ground truth',
      requestedPositives: positiveCount, requestedNegatives: negativeCount,
      availablePositives: pool.length, availableNegatives,
      positivePairs: positives.map((p) => [p.dup_id, p.root_id]), negativePairs: negatives,
      articleIds: ids,
    },
  };
}

export function writePairManifest(directory, sample) {
  const path = join(directory, `bench-pairs-${Date.now()}-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify(sample.manifest, null, 2) + '\n', { flag: 'wx' });
  return path;
}

export function requireDedupPairs(sample) {
  if (!sample.positives.length || !sample.negatives.length) {
    throw new Error('dedup benchmark needs both stored-link pairs and cross-group candidate negatives; sample is insufficient');
  }
}

/** Separate retained prefix energy from agreement with the returned short
 * embedding. Neither statistic measures semantic-neighbor preservation,
 * downstream ranking quality or whether an encoder was trained with MRL.
 */
export function prefixDiagnostics(native, shorter) {
  if (!shorter.length || native.length < shorter.length) throw new Error('prefix probe requires 0 < short dimensions <= native dimensions');
  let nativeNorm2 = 0, prefixNorm2 = 0, shorterNorm2 = 0, dot = 0;
  for (let i = 0; i < native.length; i++) {
    if (!Number.isFinite(native[i])) throw new Error('prefix probe received a non-finite vector');
    nativeNorm2 += native[i] ** 2;
    if (i < shorter.length) {
      if (!Number.isFinite(shorter[i])) throw new Error('prefix probe received a non-finite vector');
      prefixNorm2 += native[i] ** 2;
      shorterNorm2 += shorter[i] ** 2;
      dot += native[i] * shorter[i];
    }
  }
  if (!nativeNorm2 || !prefixNorm2 || !shorterNorm2) throw new Error('prefix probe received a zero vector or prefix');
  return {
    retainedEnergy: prefixNorm2 / nativeNorm2,
    prefixCosine: dot / Math.sqrt(prefixNorm2 * shorterNorm2),
    paddedCosine: dot / Math.sqrt(nativeNorm2 * shorterNorm2),
  };
}
