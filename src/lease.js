// A soft lease over the enrichment queue so two rssmart processes (serve's
// internal scheduler, a cron run, a manual backfill) don't classify the
// same articles twice. There is a tiny read-then-write race window between
// processes; the worst case is briefly duplicated LLM work, never data
// corruption, so simplicity wins over real locking.

const KEY = 'enrich_lease';

/** Take (or renew) the lease. Returns false if another live owner holds it. */
export function acquireLease(db, owner, ttlMs = 90_000) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(KEY);
  if (row) {
    const lease = JSON.parse(row.value);
    if (lease.owner !== owner && Date.now() - lease.ts < ttlMs) return false;
  }
  db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `).run(KEY, JSON.stringify({ owner, ts: Date.now() }));
  return true;
}

/** Give the lease back (only if we still own it). */
export function releaseLease(db, owner) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(KEY);
  if (row && JSON.parse(row.value).owner === owner) {
    db.prepare('DELETE FROM meta WHERE key = ?').run(KEY);
  }
}
