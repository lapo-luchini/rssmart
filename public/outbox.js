// A tiny persisted retry queue for triage's vote/skip actions on flaky
// mobile networks: a failed write is applied locally right away (triage
// keeps moving) and queued here to replay once connectivity returns. Safe
// to replay because /vote and /read are both plain idempotent SETs
// server-side (see DESIGN.md) -- no dedup or conflict resolution needed,
// just resend the same request.
const STORAGE_KEY = 'rssmart_outbox';

function load(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function save(storage, entries) {
  storage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

/**
 * @param {object} [opts]
 * @param {{getItem: Function, setItem: Function}} [opts.storage] defaults to window.localStorage
 * @param {(path: string, options: object) => Promise<Response>} [opts.request] defaults to fetch
 */
export function createOutbox({
  storage = typeof localStorage !== 'undefined' ? localStorage : null,
  request = (path, options) => fetch(path, options),
} = {}) {
  if (!storage) throw new Error('createOutbox: no storage available (no localStorage, and none provided)');
  let entries = load(storage);
  let flushing = false;

  function enqueue(path, options) {
    entries.push({ path, options });
    save(storage, entries);
  }

  /**
   * Replays queued entries in order, oldest first. Stops at the first
   * entry that still can't be sent (a network failure, or a 5xx -- a
   * still-bad connection or a transient server issue) so it doesn't
   * hammer a connection that isn't back yet. A 4xx is a real rejection,
   * not a connectivity problem, so that entry is dropped rather than
   * retried forever, and the flush continues to whatever's next.
   */
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      while (entries.length > 0) {
        let res;
        try {
          res = await request(entries[0].path, entries[0].options);
        } catch {
          return;
        }
        if (!res.ok && res.status >= 500) return;
        entries.shift();
        save(storage, entries);
      }
    } finally {
      flushing = false;
    }
  }

  return {
    enqueue,
    flush,
    get count() {
      return entries.length;
    },
  };
}
