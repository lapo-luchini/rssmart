// Every vote/read intent is persisted BEFORE sending, online or offline.
// FIFO is intentional: vote(+1), vote(0) still marks read, so dropping an
// intermediate vote is not a semantics-preserving coalescence. Server-side
// receipts make ambiguous/lost responses safe to retry without re-dating.
// Upstream tabs write arrays to the old key and silently replace unknown
// formats. A separate key keeps those writers away from durable new intents.
const STORAGE_KEY = 'rssmart_outbox_v3';
const LEGACY_KEY = 'rssmart_outbox';
const RETRY_MS = 20_000;
const LEGACY_ISSUE = {
  permanent: true, legacyConflict: true,
  message: 'Feedback from an older app changed. Sync is paused; both queues are kept. Close older tabs and reconcile the saved changes before retrying.',
};
const ACK_FIELDS = ['vote', 'read_at', 'voted_at', 'score', 'score_topics',
  'score_embedding', 'score_depth', 'score_feed', 'score_bonus'];

function target(path, options) {
  const match = /^\/api\/articles\/(\d+)\/(vote|read)$/.exec(path);
  if (!match || options.method !== 'POST') throw new Error('Unsupported queued feedback');
  const body = JSON.parse(options.body);
  const field = match[2];
  if (field === 'vote' ? !Number.isInteger(body.vote) || Math.abs(body.vote) > 2 : typeof body.read !== 'boolean') {
    throw new Error('Invalid queued feedback');
  }
  return { articleId: match[1], field, body };
}

export function createOutbox({
  storage = typeof localStorage !== 'undefined' ? localStorage : null,
  request = (path, options) => fetch(path, options),
  locks = globalThis.navigator?.locks,
  now = () => Date.now(),
  newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''),
} = {}) {
  if (!storage) throw new Error('createOutbox: no storage available');
  let flushing;
  let localIssue = null;
  const lock = (name, fn) => locks ? locks.request(`${STORAGE_KEY}:${name}`, async () => fn()) : Promise.resolve().then(fn);

  function append(state, path, options) {
    const { articleId, field, body } = target(path, options);
    const sequence = (state.sequences[articleId] ?? 0) + 1;
    if (!Number.isSafeInteger(sequence)) throw new Error('Feedback sequence exhausted');
    const entry = { id: `${state.clientId}:${articleId}:${sequence}`, articleId, field,
      sequence, createdAt: new Date(now()).toISOString(), path,
      options: { ...options, body: JSON.stringify({ ...body, mutation: { clientId: state.clientId, sequence } }) } };
    state.sequences[articleId] = sequence;
    state.entries.push(entry);
    return entry;
  }

  function decode(raw) {
    const parsed = raw === null ? [] : JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const state = { version: 3, clientId: newId(), sequences: {}, entries: [], revision: 0, acknowledged: {} };
      // Upgrade the old queue under the storage lock, retaining every SET
      // in order; all subsequent reads use the persisted client identity.
      for (const entry of parsed) append(state, entry.path, entry.options);
      return state;
    }
    if (![2, 3].includes(parsed?.version) || typeof parsed.clientId !== 'string' ||
        !parsed.sequences || !Array.isArray(parsed.entries)) throw new Error('Unrecognized feedback queue');
    // Keep durable identities unchanged when upgrading an intermediate v2.
    if (parsed.version === 2) return { ...parsed, version: 3, revision: 0, acknowledged: {} };
    if (!Number.isSafeInteger(parsed.revision) || parsed.revision < 0 ||
        !parsed.acknowledged || typeof parsed.acknowledged !== 'object' || Array.isArray(parsed.acknowledged)) {
      throw new Error('Unrecognized feedback acknowledgements');
    }
    return parsed;
  }

  function load() {
    const raw = storage.getItem(STORAGE_KEY);
    const legacy = storage.getItem(LEGACY_KEY);
    let state;
    if (raw === null) {
      // Persist this copy under the new storage lock before any network I/O.
      // Never clear the old key: an old tab does not share our lock and can
      // write between a compare and delete. The exact baseline also avoids
      // hash collisions when detecting a later incompatible writer.
      state = { ...decode(legacy), legacySnapshot: legacy };
    } else {
      state = decode(raw);
      if (state.version !== 3 || !Object.hasOwn(state, 'legacySnapshot') ||
          (state.legacySnapshot !== null && typeof state.legacySnapshot !== 'string')) {
        throw new Error('Unrecognized isolated feedback queue');
      }
    }
    if (legacy !== state.legacySnapshot && !state.legacyConflict) {
      // Keep the first observed conflicting value as well. Once a mutation
      // or flush saves it, an old tab clearing its queue cannot resume ours.
      state.legacyConflict = { snapshot: legacy };
    }
    return state;
  }

  function save(state) {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  async function enqueue(path, options) {
    return lock('storage', () => {
      const state = load();
      const entry = append(state, path, options);
      save(state); // Failure propagates: the UI must not claim it saved this intent.
      localIssue = null;
      return entry;
    });
  }

  function issueFor(res) {
    if (res.status === 401) return { status: 401, message: 'Sign in again, then retry. Your changes are saved locally.' };
    if (res.status === 429 || res.status === 408 || res.status === 425 || res.status >= 500) {
      const retry = res.headers?.get('retry-after');
      const delay = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry);
      const retryAt = retry && Number.isFinite(delay)
        ? Math.max(now() + 1000, /^\d+(?:\.\d+)?$/.test(retry) ? now() + delay : delay)
        : now() + RETRY_MS;
      return { status: res.status, retryAt, message: 'Sync will retry later. Your changes are saved locally.' };
    }
    return { status: res.status, permanent: true,
      message: `Sync rejected (${res.status}). Your changes are kept; resolve the error before retrying.` };
  }

  async function drain({ retryAuth = false, retryErrors = false } = {}) {
    const results = [];
    const blockedArticles = new Set();
    for (;;) {
      const entry = await lock('storage', () => {
        const state = load();
        save(state); // Also makes a legacy queue's assigned IDs durable before I/O.
        localIssue = null;
        // Detect a legacy write occurring during the migration save too.
        const legacy = storage.getItem(LEGACY_KEY);
        if (legacy !== state.legacySnapshot && !state.legacyConflict) {
          state.legacyConflict = { snapshot: legacy };
          save(state);
        }
        if (state.legacyConflict) return;
        for (const candidate of state.entries) {
          if (blockedArticles.has(candidate.articleId)) continue;
          if (candidate.issue?.permanent && !retryErrors) {
            blockedArticles.add(candidate.articleId);
            continue;
          }
          return candidate;
        }
      });
      if (!entry) return results;
      if (entry.issue?.retryAt > now() ||
          (entry.issue?.status === 401 && !retryAuth) ||
          (entry.issue?.permanent && !retryErrors)) return results;
      let issue;
      let data;
      try {
        const res = await request(entry.path, { ...entry.options, signal: AbortSignal.timeout(15_000) });
        if (res.ok) {
          data = await res.json(); // A lost/unreadable acknowledgement stays queued.
          if (!data || String(data.id) !== entry.articleId) throw new Error('Invalid feedback acknowledgement');
        } else {
          issue = issueFor(res);
          if (issue.permanent) {
            const body = await res.json().catch(() => ({}));
            if (body.error) issue.message = `Sync rejected (${res.status}): ${body.error}. Your changes are kept.`;
          }
        }
      } catch {
        issue = { retryAt: now() + RETRY_MS, message: 'Waiting for a connection. Your changes are saved locally.' };
      }
      await lock('storage', () => {
        const state = load();
        const index = state.entries.findIndex(item => item.id === entry.id);
        if (index < 0) throw new Error('Feedback queue changed unexpectedly');
        if (issue) state.entries[index].issue = issue;
        else {
          const revision = state.revision + 1;
          if (!Number.isSafeInteger(revision)) throw new Error('Feedback revision exhausted');
          const fields = state.acknowledged[entry.articleId] ??= {};
          for (const key of ACK_FIELDS) {
            if (Object.hasOwn(data, key)) fields[key] = { revision, value: data[key] };
          }
          state.revision = revision;
          state.entries.splice(index, 1); // Never shift a newer intent accidentally.
        }
        // Removal, acknowledged fields and revision commit in one storage
        // write under the shared lock. On quota failure the durable entry
        // still exists, with the same replay identity and FIFO position.
        save(state);
      });
      if (issue?.permanent) {
        blockedArticles.add(entry.articleId);
        continue; // Other articles have independent sequences.
      }
      if (issue) return results;
      results.push({ entry, data });
    }
  }

  function flush(options) {
    if (flushing) return flushing;
    flushing = lock('flush', () => drain(options)).catch(err => {
      localIssue = { permanent: true, message: `Cannot access saved feedback: ${err.message}` };
      return [];
    }).finally(() => { flushing = null; });
    return flushing;
  }

  function inspect() {
    try { return load(); }
    catch (err) {
      localIssue = { permanent: true, message: `Cannot access saved feedback: ${err.message}` };
      return { entries: [], revision: 0, acknowledged: {} };
    }
  }

  return {
    enqueue, flush,
    get count() { return inspect().entries.length; },
    get issue() {
      const state = inspect();
      return localIssue ?? (state.legacyConflict ? LEGACY_ISSUE : null)
        ?? state.entries.find(entry => entry.issue?.status === 401)?.issue
        ?? state.entries.find(entry => entry.issue)?.issue ?? null;
    },
    get coordinatedTabs() { return !!locks; },
    get revision() { return inspect().revision; },
    // Preserve optimistic intent when a list reload/older acknowledgement
    // contains the server's state from before queued changes.
    project(article, since) {
      const state = inspect();
      since ??= state.revision;
      const result = { ...article };
      // A GET begun before an acknowledgement may finish after the queue
      // has drained. Preserve only fields acknowledged since that GET.
      for (const [key, field] of Object.entries(state.acknowledged[String(article.id)] ?? {})) {
        if (field.revision > since) result[key] = field.value;
      }
      for (const entry of state.entries) {
        if (entry.articleId !== String(article.id)) continue;
        const body = JSON.parse(entry.options.body);
        if (entry.field === 'vote') {
          result.vote = body.vote;
          if (body.vote !== 0) result.read_at ??= entry.createdAt;
        } else result.read_at = body.read ? entry.createdAt : null;
      }
      return result;
    },
  };
}
