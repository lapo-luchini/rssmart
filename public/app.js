import { createApp } from './vendor/vue.esm-browser.prod.js';
import { createOutbox } from './outbox.js';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js'));
}

const LIMIT = 50;
const TRIAGE_BATCH = 30;
// One shared outbox for the whole app (module-level, not Vue reactive data
// -- its own count is mirrored into outboxCount whenever it changes so the
// UI badge reacts, see syncOutboxCount).
const outbox = createOutbox();
const OUTBOX_POLL_MS = 20_000;

createApp({
  data() {
    return {
      views: [
        { id: 'interesting', label: 'Interesting' },
        { id: 'unread', label: 'Unread' },
        { id: 'explore', label: 'Explore' },
        { id: 'custom', label: 'Custom' },
      ],
      view: 'interesting',
      topic: '',
      feedId: '',
      q: '',
      semantic: false,
      sort: 'hot',
      // sort=custom experiment sliders: relative multipliers over the
      // stored per-signal score components (1.0 = the configured weight).
      // The server defaults to 1.0 multipliers plus configured decay; the client keeps
      // its own copies lazily-set from /api/info's weight profile.
      customWeights: { topics: null, embedding: null, depth: null, feed: null, bonus: null, decay: null },
      customAxes: [
        { key: 'topics', label: 'topics', defaults: 1 },
        { key: 'embedding', label: 'similar', defaults: 1 },
        { key: 'depth', label: 'depth', defaults: 1 },
        { key: 'feed', label: 'source', defaults: 1 },
        { key: 'bonus', label: 'explore-nudge', defaults: 1 },
        { key: 'decay', label: 'freshness', defaults: 1, perDay: true },
      ],
      dupes: false,
      enrichedOnly: false,
      includeRead: false,
      articles: [],
      total: 0,
      cursor: null, // opaque keyset continuation from the last /api/articles page
      topics: [],
      feeds: [],
      feedsDetailed: [],
      panel: null, // null = article list, 'topics' | 'feeds' | 'triage' = content tabs
      triageScope: 'fixed', // 'fixed' = the dedicated Triage tab's own unread/date/enriched scope;
                            // 'filtered' = triageThisView(), whatever the main list's own filters/sort are
      triageSeen: new Set(), // ids already voted/skipped this session — needed for 'filtered' scopes
                              // like view=all that don't naturally shrink as articles are marked read
      triageQueue: [],
      triagePos: 0,
      triageProcessed: 0,
      outboxCount: outbox.count, // votes/skips queued locally, not yet synced
      outboxIssue: outbox.issue,
      outboxCoordinatedTabs: outbox.coordinatedTabs,
      feedbackIntent: {},
      feedbackApplied: {},
      triageLoading: false,
      triageBusy: false,
      triageExpanded: false,
      triageContent: '',
      triageContentSource: null,
      triageContentLoading: false,
      topicSort: { key: 'pref', dir: -1 },
      feedSort: { key: null, dir: -1 }, // null = server order (active first)
      feedForm: { url: '', title: '' },
      feedNotice: '',
      renamingFeedId: null,
      renameFeedTitle: '',
      guidelines: '',
      guidelinesNotice: '',
      topicMergeProposals: [],
      topicMergeLoading: false,
      topicMergeNotice: '',
      manualMerge: { from: '', to: '' },
      manualMergeNotice: '',
      stats: null,
      showStats: false, // the full-stats popup (click on the wire-stats line)
      expandedId: null,
      expandedVersions: {},
      selectedVersion: {},
      shownVersion: {},
      shownOriginal: {},
      flashId: null,
      scoreDetailId: null,
      readerArticle: null,
      readerHtml: '',
      readerSource: null,
      readerLoading: false,
      readerRequestId: 0,
      readerController: null,
      readerTargetId: null,
      loading: false,
      listRequestId: 0,
      listController: null,
      listLoadedKey: null,
      triageRequestId: 0,
      triageController: null,
      error: null,
      prefByTopic: {},
      articlesByTopic: {},
      searchTimer: null,
      customTimer: null,
      darkMode: window.matchMedia('(prefers-color-scheme: dark)').matches,
      touchStartY: null,
    };
  },

  computed: {
    topicsRanked() {
      const value = (t, key) => ({
        name: t.name.toLowerCase(),
        votes: t.up - t.down,
      }[key] ?? t[key]);
      return this.sortRows(this.topics, this.topicSort, value);
    },

    feedsRanked() {
      if (!this.feedSort.key) return this.feedsDetailed;
      const value = (f, key) => ({
        name: (f.title || f.url).toLowerCase(),
        // "fetches" sorts by error rate so problem feeds surface together
        errors: f.ok_count + f.error_count
          ? f.error_count / (f.ok_count + f.error_count)
          : -1,
        avg_vote: f.avg_vote ?? -Infinity, // unvoted feeds sort last
      }[key] ?? f[key]);
      return this.sortRows(this.feedsDetailed, this.feedSort, value);
    },

    // The actual view param the API sees: "explore" is really "unread",
    // just with a different default sort, and includeRead widens whichever
    // tab is active to also show already-read articles ("all", in API
    // terms) without changing which tab looks active.
    apiView() {
      if (this.includeRead) return 'all';
      return this.view === 'explore' || this.view === 'custom' ? 'unread' : this.view;
    },

    emptyMessage() {
      if (this.semantic && this.q) return 'No semantically similar articles found — try different wording, or note that only classified articles are searchable.';
      if (this.q || this.topic || this.feedId) return 'Nothing matches these filters.';
      if (this.apiView === 'all') return 'No articles yet. Add feeds in the Feeds tab and run: rssmart cron';
      return 'All caught up. New articles arrive on the next cron run.';
    },

    filtersActive() {
      return !!(this.topic || this.feedId || this.q || this.dupes || this.enrichedOnly || this.includeRead);
    },

    triageCurrent() {
      return this.triageQueue[this.triagePos] ?? null;
    },
  },

  watch: {
    q() {
      this.invalidateList();
      clearTimeout(this.searchTimer);
      clearTimeout(this.customTimer);
      this.searchTimer = setTimeout(() => this.reload(), 300);
    },
  },

  created() {
    // Hash routes (#/unread, #/feeds, ...): bookmarkable tabs, working
    // back/forward, and a reload stays on the current tab.
    this.applyRoute(location.hash, { replace: true });
    window.addEventListener('hashchange', () => this.applyRoute(location.hash));
    window.addEventListener('keydown', this.handleGlobalKey);
    window.addEventListener('wheel', this.handleGlobalWheel, { passive: false });
    window.addEventListener('touchstart', this.handleTriageTouchStart, { passive: true });
    window.addEventListener('touchend', this.handleTriageTouchEnd, { passive: true });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => (this.darkMode = e.matches));
    this.reload();
    this.loadSidebarData();
    // Log the running version for debugging (git describe when available,
    // commit hash otherwise — see /api/info), and seed the custom-sort
    // sliders with the server's multiplier profile and configured decay.
    this.api('/api/info').then((v) => {
      console.log('rssmart', v.describe || v.commit);
      if (v.weightProfile) {
        for (const axis of this.customAxes) {
          const w = v.weightProfile[axis.key];
          if (w == null) continue;
          // The displayed value and reset target follow the same defaults.
          if (this.customWeights[axis.key] == null) this.customWeights[axis.key] = w;
          axis.defaults = w;
        }
      }
    }).catch(() => {});

    // Retry queued triage votes/skips (see outbox.js) whenever there's a
    // reasonable signal connectivity might be back: on load (in case they
    // were queued in a previous session), on the browser's own online
    // event (best-effort -- it reflects network-interface state, not
    // actual reachability, so it can both under- and over-fire), and a
    // periodic fallback poll so a missed/wrong online event doesn't leave
    // votes stuck until the next unrelated trigger.
    this.flushOutbox({ retryAuth: true });
    window.addEventListener('online', () => this.flushOutbox());
    window.addEventListener('storage', () => {
      this.outboxCount = outbox.count;
      this.outboxIssue = outbox.issue;
    });
    setInterval(() => this.flushOutbox(), OUTBOX_POLL_MS);
  },

  methods: {

    // Custom-tab slider: debounce like the search box, then reload with the
    // weight params riding on sort=custom. Sliders are relative multipliers
    // over the stored per-signal components (1.0 = the configured weight).
    setCustomWeight(axis, value) {
      this.customWeights[axis] = Number(value);
      this.invalidateList();
      clearTimeout(this.customTimer);
      this.customTimer = setTimeout(() => this.reload(), 300);
    },

    // Reset the signal multipliers to 1.0 and freshness to configured decay.
    resetCustomWeights() {
      for (const axis of this.customAxes) {
        this.customWeights[axis.key] = axis.defaults;
      }
      this.reload();
    },

    params(offset) {
      const p = new URLSearchParams({
        view: this.apiView,
        sort: this.sort,
        limit: LIMIT,
      });
      // keyset pagination (server's `cursor` fix): the opaque nextCursor
      // from the previous page instead of a static OFFSET, so articles
      // that got read/voted between pages (leaving the unread WHERE and
      // the OFFSET window) can't be skipped. Unsupported modes
      // (semantic, date-rr) fall back to offset.
      const cursorMode = !this.semantic && this.sort !== 'date-rr';
      if (cursorMode && this.cursor) p.set('cursor', this.cursor);
      else p.set('offset', offset);
      if (this.topic) p.set('topic', this.topic);
      if (this.feedId) p.set('feed_id', this.feedId);
      if (this.q) p.set('q', this.q);
      if (this.semantic && this.q) p.set('semantic', '1');
      if (this.dupes) p.set('dupes', '1');
      if (this.enrichedOnly) p.set('status', 'enriched');
      if (this.sort === 'custom') {
        for (const [axis, value] of Object.entries(this.customWeights)) {
          if (value != null) p.set(`w_${axis}`, String(value));
        }
      }
      return p;
    },

    clearFilters() {
      this.topic = '';
      this.feedId = '';
      this.q = '';
      this.semantic = false;
      this.dupes = false;
      this.enrichedOnly = false;
      this.includeRead = false;
      this.reload();
    },

    async api(path, options) {
      const res = await fetch(path, options);
      if (res.ok) this.flushOutbox({ retryAuth: true });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `${res.status} ${res.statusText}`);
      }
      return res.json();
    },

    async flushOutbox(options) {
      const feedbackRevision = outbox.revision;
      const results = await outbox.flush(options);
      this.outboxCount = outbox.count;
      this.outboxIssue = outbox.issue;
      for (const { entry, data } of results) {
        if ((this.feedbackApplied[entry.articleId] ?? 0) > entry.sequence) continue;
        this.feedbackApplied[entry.articleId] = entry.sequence;
        const visible = [...this.articles, ...this.triageQueue, this.readerArticle];
        for (const article of visible) {
          if (article?.id === data.id) Object.assign(article, outbox.project({ ...article, ...data }, feedbackRevision));
        }
      }
      return results;
    },

    // Persist first for every feedback surface. Local updates are applied
    // only once persistence succeeds; acknowledgements may arrive later.
    async attemptOrQueue(path, options, { onSuccess, onQueued }) {
      const feedbackRevision = outbox.revision;
      const entry = await outbox.enqueue(path, options);
      this.feedbackIntent[entry.articleId] = entry.id;
      onQueued();
      this.outboxCount = outbox.count;
      this.flushOutbox().then(results => {
        if (this.feedbackIntent[entry.articleId] !== entry.id) return;
        const saved = results.find(item => item.entry.id === entry.id);
        if (saved) onSuccess(outbox.project(saved.data, feedbackRevision));
      });
    },

    invalidateList() {
      this.listRequestId++;
      this.listController?.abort();
      this.loading = false;
    },

    listQueryKey() {
      const params = this.params(0);
      params.delete('cursor');
      params.delete('offset');
      return `${this.panel ?? ''}:${params}`;
    },

    async reload() {
      const feedbackRevision = outbox.revision;
      this.invalidateList();
      const requestId = this.listRequestId;
      const query = this.listQueryKey();
      const current = () => requestId === this.listRequestId && query === this.listQueryKey();
      const controller = this.listController = new AbortController();
      this.loading = true;
      this.error = null;
      this.expandedId = null;
      this.expandedVersions = {};
      this.selectedVersion = {};
      this.shownVersion = {};
      this.shownOriginal = {};
      this.cursor = null; // a reload is page 1: a continuation left over from the previous filter/sort state would pin the wrong window
      try {
        const data = await this.api(`/api/articles?${this.params(0)}`, { signal: controller.signal });
        if (!current()) return;
        this.articles = data.articles.map(article => outbox.project(article, feedbackRevision));
        this.total = data.total;
        this.cursor = data.nextCursor ?? null; // keyset continuation
        this.listLoadedKey = query;
      } catch (err) {
        if (current() && err.name !== 'AbortError') this.error = `Cannot load articles: ${err.message}`;
      } finally {
        if (current()) this.loading = false;
      }
    },

    async loadMore() {
      const feedbackRevision = outbox.revision;
      if (this.loading) return;
      const query = this.listQueryKey();
      if (query !== this.listLoadedKey) return this.reload();
      const requestId = ++this.listRequestId;
      const controller = this.listController = new AbortController();
      const current = () => requestId === this.listRequestId && query === this.listQueryKey();
      this.loading = true;
      try {
        const data = await this.api(`/api/articles?${this.params(this.articles.length)}`, { signal: controller.signal });
        if (!current()) return;
        this.articles.push(...data.articles.map(article => outbox.project(article, feedbackRevision)));
        this.total = data.total;
        this.cursor = data.nextCursor ?? null;
      } catch (err) {
        if (current() && err.name !== 'AbortError') this.error = `Cannot load articles: ${err.message}`;
      } finally {
        if (current()) this.loading = false;
      }
    },

    async loadSidebarData() {
      try {
        const [topics, feeds, stats] = await Promise.all([
          this.api('/api/topics'),
          this.api('/api/feeds'),
          this.api('/api/stats'),
        ]);
        this.topics = topics.filter((t) => t.articles > 0);
        this.feedsDetailed = feeds;
        this.feeds = feeds.filter((f) => f.active);
        this.stats = stats;
        this.prefByTopic = Object.fromEntries(topics.map((t) => [t.name, t.pref]));
        this.articlesByTopic = Object.fromEntries(topics.map((t) => [t.name, t.articles]));
      } catch {
        /* header extras are non-essential */
      }
    },

    sortRows(rows, state, value) {
      return [...rows].sort((a, b) => {
        const va = value(a, state.key);
        const vb = value(b, state.key);
        const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
        return cmp * state.dir;
      });
    },

    setSort(state, key) {
      if (state.key === key) state.dir = -state.dir;
      else Object.assign(state, { key, dir: key === 'name' ? 1 : -1 });
    },

    sortMark(state, key) {
      return state.key === key ? (state.dir > 0 ? ' ▴' : ' ▾') : '';
    },

    currentRoute() {
      return this.panel ?? this.view;
    },

    syncHash() {
      const hash = `#/${this.currentRoute()}`;
      if (location.hash !== hash) location.hash = hash;
    },

    applyRoute(hash, { replace = false } = {}) {
      const route = hash.replace(/^#\//, '');
      const routes = ["interesting", "unread", "explore", "custom", "triage", "topics", "feeds"];
      const article = route.match(/^article\/(\d+)$/);
      if (article) {
        // permalink: the normal full-page reader view from any mode — it
        // doesn't encode triage/list state
        this.openReaderById(Number(article[1]));
        return;
      }
      if (replace && !routes.includes(route)) {
        history.replaceState(null, '', `#/${this.currentRoute()}`);
        return;
      }
      if (routes.includes(route)) this.closeReader({ restoreRoute: false });
      if (route === this.currentRoute()) return;
      if (['triage', 'topics', 'feeds'].includes(route)) this.openPanel(route);
      else if ([`interesting`, `unread`, `explore`, `custom`].includes(route)) this.setView(route);
    },

    setView(v) {
      this.closeReader({ restoreRoute: false });
      this.triageRequestId++;
      this.triageController?.abort();
      this.panel = null;
      this.view = v;
      this.sort = v === 'interesting' ? 'hot' : v === 'explore' ? 'novelty' : v === 'custom' ? 'custom' : 'date';
      this.syncHash();
      this.reload();
    },

    openPanel(name) {
      this.closeReader({ restoreRoute: false });
      this.invalidateList();
      this.triageRequestId++;
      this.triageController?.abort();
      this.panel = name;
      this.feedNotice = '';
      this.guidelinesNotice = '';
      this.syncHash();
      this.loadSidebarData();
      if (name === 'topics') {
        this.api('/api/guidelines')
          .then((g) => (this.guidelines = g.text))
          .catch(() => {});
      }
      if (name === 'triage') this.startTriage('fixed');
    },

    // Triage-this-view: the same rapid keyboard-driven flow as the
    // dedicated Triage tab, but scoped to whatever the main list is
    // already showing (topic/feed/search/dupes/enrichedOnly, current
    // sort) instead of the tab's own fixed unread/date/enriched scope —
    // requested so triage isn't limited to one hardcoded subset. Exiting
    // (esc) returns to this same filtered view, since starting it never
    // touches view/topic/feedId/etc. themselves, only which panel is shown.
    triageThisView() {
      this.invalidateList();
      this.panel = 'triage';
      this.startTriage('filtered');
      this.feedNotice = '';
      this.guidelinesNotice = '';
      this.syncHash();
    },

    startTriage(scope) {
      this.triageScope = scope;
      this.triageProcessed = 0;
      this.triageSeen = new Set();
      this.loadTriageBatch();
    },

    triageParams(offset) {
      if (this.triageScope === 'filtered') {
        const p = this.params(offset);
        // triage re-walks from offset 0 per batch with its own seen-set;
        // it needs the OFFSET scrollbar, not the main list's page cursor
        p.delete('cursor');
        p.set('offset', offset);
        p.set('limit', TRIAGE_BATCH);
        return p;
      }
      // The dedicated tab's own fixed scope, untouched by any of the main
      // list's filters: unread + classified, oldest-classified-first is
      // exactly wrong here — date order, newest first, is what makes a
      // freshly-classified article turn up promptly (see DESIGN.md).
      // 'date-rr' round-robins across feeds instead of plain date order —
      // an adaptive per-feed fetch cadence means one feed can dump many
      // articles at once, otherwise producing long same-source runs.
      return new URLSearchParams({ view: 'unread', sort: 'date-rr', status: 'enriched', limit: TRIAGE_BATCH, offset });
    },

    // Each vote/skip marks the article read. For the dedicated tab's own
    // scope (always unread) that alone drops it out of the very next
    // fetch at offset 0 — no bookkeeping needed. A filtered scope isn't
    // guaranteed to shrink that way (view=all shows read articles too),
    // so triageSeen also filters out anything already processed this
    // session; the while loop below just keeps walking the offset forward
    // until it finds a batch with something new, or genuinely runs out.
    async loadTriageBatch() {
      const feedbackRevision = outbox.revision;
      const requestId = ++this.triageRequestId;
      this.triageController?.abort();
      const controller = this.triageController = new AbortController();
      const panel = this.panel;
      const query = `${this.triageScope}:${this.triageParams(0)}`;
      const current = () => requestId === this.triageRequestId && panel === this.panel &&
        query === `${this.triageScope}:${this.triageParams(0)}`;
      this.triageLoading = true;
      try {
        let offset = 0;
        let queue = [];
        for (;;) {
          const data = await this.api(`/api/articles?${this.triageParams(offset)}`, { signal: controller.signal });
          if (!current()) return;
          queue = data.articles.filter((a) => !this.triageSeen.has(a.id)).map(article => outbox.project(article, feedbackRevision));
          if (queue.length > 0 || data.articles.length === 0) break;
          offset += data.articles.length;
        }
        this.triageQueue = queue;
        this.triagePos = 0;
        this.collapseTriageContent();
      } catch (err) {
        if (current() && err.name !== 'AbortError') this.error = `Cannot load triage queue: ${err.message}`;
      } finally {
        if (current()) this.triageLoading = false;
      }
    },

    async triageAdvance() {
      if (this.triageCurrent) this.triageSeen.add(this.triageCurrent.id);
      this.triageProcessed++;
      this.triagePos++;
      this.collapseTriageContent();
      // a mouse-clicked vote/skip button keeps DOM focus across cards; once
      // any keyboard input follows, :focus-visible paints a selection ring
      // on it over an article that was never voted — blur it on advance
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.closest('.triage-controls')) focused.blur();
      if (this.triagePos >= this.triageQueue.length) await this.loadTriageBatch();
    },

    async triageVote(value) {
      const article = this.triageCurrent;
      if (!article || this.triageBusy) return;
      this.triageBusy = true;
      try {
        // Clear on match: clicking the same button again resets to neutral
        const actual = article.vote === value ? 0 : value;
        await this.attemptOrQueue(`/api/articles/${article.id}/vote`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ vote: actual }),
        }, {
          onSuccess: (updated) => Object.assign(article, updated),
          // Offline/unreachable: apply the vote locally so triage keeps
          // moving (see outbox.js) -- score_* stays stale until the queued
          // request actually lands, matching /vote's own read_at rule
          // (only backfilled on a real vote, never cleared by a retraction).
          onQueued: () => {
            article.vote = actual;
            if (actual !== 0) article.read_at ??= new Date().toISOString();
          },
        });
        await this.triageAdvance();
      } catch (err) {
        this.error = `Vote failed: ${err.message}`;
      } finally {
        this.triageBusy = false;
      }
    },

    async triageSkip() {
      const article = this.triageCurrent;
      if (!article || this.triageBusy) return;
      this.triageBusy = true;
      try {
        await this.attemptOrQueue(`/api/articles/${article.id}/read`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ read: true }),
        }, {
          onSuccess: (updated) => { article.read_at = updated.read_at; },
          onQueued: () => { article.read_at ??= new Date().toISOString(); },
        });
        await this.triageAdvance();
      } catch (err) {
        this.error = `Update failed: ${err.message}`;
      } finally {
        this.triageBusy = false;
      }
    },

    triageBack() {
      if (this.triagePos > 0) {
        this.triagePos--;
        this.triageProcessed = Math.max(this.triageProcessed - 1, 0);
        this.collapseTriageContent();
      }
    },

    collapseTriageContent() {
      this.triageExpanded = false;
      this.triageContent = '';
      this.triageContentSource = null;
    },

    // On-demand full text inline in the triage card itself (not a separate
    // overlay) — triage is about screen-estate-efficient rapid voting, so
    // the extra text goes below the vote row rather than taking over the
    // view. Unlike openReader, this does NOT mark the article read: reading
    // ahead of a vote/skip shouldn't fast-track it out of the queue.
    async toggleTriageContent() {
      if (this.triageExpanded) {
        this.collapseTriageContent();
        return;
      }
      const article = this.triageCurrent;
      if (!article) return;
      this.triageExpanded = true;
      this.triageContent = '';
      this.triageContentSource = null;
      this.triageContentLoading = true;
      try {
        const data = await this.api(`/api/articles/${article.id}/reader`);
        if (this.triageCurrent !== article) return; // advanced while loading
        this.triageContent = data.html;
        this.triageContentSource = data.source;
      } catch (err) {
        if (this.triageCurrent !== article) return;
        this.error = `Cannot load article: ${err.message}`;
        this.triageExpanded = false;
      } finally {
        if (this.triageCurrent === article) this.triageContentLoading = false;
      }
    },

    // A direct new-tab open, same escape hatch as the reader overlay's
    // "open original ↗" link, just keyboard-reachable — window.open here
    // is a synchronous response to a keydown, so it isn't popup-blocked.
    openTriageOriginal() {
      if (this.triageCurrent?.url) window.open(this.triageCurrent.url, '_blank', 'noopener');
    },

    handleGlobalKey(e) {
      // While typing (reclassify note, search box, selects, any editable
      // target) letter/arrow shortcuts must never fire — "o" in a note must
      // not open the original. Focus can linger in such an input even under
      // an overlay opened afterwards. Escape stays live everywhere: closing
      // overlays is intentional from an input too.
      const target = e.target;
      const typing = target instanceof HTMLElement
        && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
          || target.tagName === 'SELECT' || target.isContentEditable);
      if (typing && e.key !== 'Escape') return;

      if (this.readerArticle) {
        if (e.key === 'Escape') {
          e.preventDefault();
          this.closeReader();
        } else if (e.key === 'ArrowUp' && !e.shiftKey) {
          e.preventDefault();
          this.voteClick(this.readerArticle, 1);
        } else if (e.key === 'ArrowUp' && e.shiftKey) {
          e.preventDefault();
          this.voteClick(this.readerArticle, 2);
        } else if (e.key === 'ArrowDown' && !e.shiftKey) {
          e.preventDefault();
          this.voteClick(this.readerArticle, -1);
        } else if (e.key === 'ArrowDown' && e.shiftKey) {
          e.preventDefault();
          this.voteClick(this.readerArticle, -2);
        } else if ((e.key === 'o' || e.key === 'O') && this.readerArticle.url) {
          e.preventDefault();
          window.open(this.readerArticle.url, '_blank', 'noopener');
        }
        return;
      }
      if (this.showStats) {
        if (e.key === 'Escape') {
          e.preventDefault();
          this.showStats = false;
        }
        return;
      }
      if (this.panel === null && e.key === 'Escape' && this.expandedId !== null
          && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        this.expandedId = null;
        return;
      }
      if (this.panel !== 'triage') return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      // Shift+arrow "escalates" the same direction to its extreme (WOW/never)
      // rather than reaching for unrelated keys — keeps the hand resting on
      // the arrow cluster throughout a triage session.
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.triageVote(e.shiftKey ? 2 : 1);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.triageVote(e.shiftKey ? -2 : -1);
        return;
      }

      // PageDown opens the preview the first time (nothing to scroll yet
      // anyway); once it's open, PageDown reverts to its normal job of
      // scrolling the now-visible content.
      if (e.key === 'PageDown' && !this.triageExpanded) {
        e.preventDefault();
        this.toggleTriageContent();
        return;
      }

      const actions = {
        ArrowLeft: () => this.triageBack(),
        Backspace: () => this.triageBack(),
        ArrowRight: () => this.triageSkip(),
        ' ': () => this.triageSkip(),
        Enter: () => this.triageSkip(),
        p: () => this.toggleTriageContent(),
        o: () => this.openTriageOriginal(),
        Escape: () => this.setView(this.view),
      };
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (actions[key]) {
        e.preventDefault();
        actions[key]();
      }
    },

    // Mobile has no PageDown key, and a mouse-less touch device has no
    // wheel either — a wheel-down tick and a short upward swipe are the
    // natural equivalents (both read as "tried to scroll past the end").
    // Same one-shot-then-normal-scroll behavior as PageDown: only fires
    // while the preview is still collapsed.
    handleGlobalWheel(e) {
      if (this.panel !== 'triage' || this.triageExpanded) return;
      if (e.deltaY > 0) {
        e.preventDefault();
        this.toggleTriageContent();
      }
    },

    handleTriageTouchStart(e) {
      this.touchStartY = e.touches[0]?.clientY ?? null;
    },

    handleTriageTouchEnd(e) {
      const startY = this.touchStartY;
      this.touchStartY = null;
      if (this.panel !== 'triage' || this.triageExpanded || startY === null) return;
      const endY = e.changedTouches[0]?.clientY;
      if (endY === undefined) return;
      if (startY - endY > 40) this.toggleTriageContent();
    },

    async saveGuidelines() {
      try {
        await this.api('/api/guidelines', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: this.guidelines }),
        });
        this.guidelinesNotice = 'Saved — used for every classification from now on.';
      } catch (err) {
        this.guidelinesNotice = `Save failed: ${err.message}`;
      }
    },

    // Propose-review-approve: the LLM only suggests candidate topic merges
    // (src/topicMerge.js) — nothing is applied until findTopicMerges below
    // is called per-proposal by an explicit click. Merging blends two
    // topics' historical vote data, not just their label, so this is never
    // automatic.
    async proposeTopicMerges() {
      this.topicMergeLoading = true;
      this.topicMergeNotice = '';
      try {
        const { merges } = await this.api('/api/topics/propose-merges', { method: 'POST' });
        this.topicMergeProposals = merges;
        this.topicMergeNotice = merges.length ? '' : 'No confident merge candidates found.';
      } catch (err) {
        this.topicMergeNotice = `Could not propose merges: ${err.message}`;
      } finally {
        this.topicMergeLoading = false;
      }
    },

    async applyTopicMerge(proposal) {
      try {
        await this.api('/api/topics/merge', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ from: proposal.from, to: proposal.to }),
        });
        this.topicMergeProposals = this.topicMergeProposals.filter((p) => p !== proposal);
        this.loadSidebarData();
      } catch (err) {
        this.topicMergeNotice = `Merge failed: ${err.message}`;
      }
    },

    // Same endpoint as a reviewed proposal's "merge" button — for a
    // redundant pair the reader noticed themselves, without waiting for
    // (or instead of) an LLM proposal to happen to include it.
    async submitManualMerge() {
      const { from, to } = this.manualMerge;
      if (!from || !to) return;
      this.manualMergeNotice = '';
      try {
        await this.api('/api/topics/merge', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ from, to }),
        });
        this.manualMerge = { from: '', to: '' };
        this.loadSidebarData();
      } catch (err) {
        this.manualMergeNotice = `Merge failed: ${err.message}`;
      }
    },

    skipTopicMerge(proposal) {
      this.topicMergeProposals = this.topicMergeProposals.filter((p) => p !== proposal);
    },

    async reclassify(article) {
      try {
        const updated = await this.api(`/api/articles/${article.id}/reclassify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ note: article.enrich_note ?? '' }),
        });
        Object.assign(article, updated); // status -> pending, note as stored
        this.loadSidebarData();
      } catch (err) {
        this.error = `Reclassify failed: ${err.message}`;
      }
    },

    filterTopic(name) {
      this.panel = null;
      this.topic = name;
      this.reload();
    },

    filterFeed(id) {
      this.panel = null;
      this.feedId = id;
      this.reload();
    },

    // Voting escalates: ▲ = interesting (+1), ▲ again = WOW (+2), again = clear.
    voteClick(article, direction) {
      const current = article.vote * direction; // 0, 1 or 2 in this direction
      const next = current === 2 ? 0 : (current + 1) * direction;
      return this.vote(article, next);
    },

    async vote(article, vote) {
      try {
        await this.attemptOrQueue(`/api/articles/${article.id}/vote`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ vote }),
        }, {
          onSuccess: updated => { Object.assign(article, updated); this.loadSidebarData(); },
          onQueued: () => {
            article.vote = vote;
            if (vote !== 0) article.read_at ??= new Date().toISOString();
          },
        });
      } catch (err) {
        this.error = `Vote failed: ${err.message}`;
      }
    },

    async toggleRead(article) {
      try {
        const read = !article.read_at;
        await this.attemptOrQueue(`/api/articles/${article.id}/read`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ read }),
        }, {
          onSuccess: updated => { article.read_at = updated.read_at; this.loadSidebarData(); },
          onQueued: () => { article.read_at = read ? new Date().toISOString() : null; },
        });
      } catch (err) {
        this.error = `Update failed: ${err.message}`;
      }
    },

    async toggle(article) {
      if (this.expandedId === article.id) {
        this.expandedId = null;
        return;
      }
      this.expandedId = article.id;
      if (article.content === undefined) {
        try {
          const full = await this.api(`/api/articles/${article.id}`);
          article.content = full.content;
        } catch {
          article.content = '';
        }
      }
      if (!article.read_at) this.toggleRead(article);
    },

    // In-page reader: full extracted text in an overlay, instead of a new
    // tab (which used to steal tab focus on close). "open original ↗" in
    // the overlay remains as the real-new-tab escape hatch. The overlay's
    // URL is the article permalink (#/article/<id>); closing restores the
    // tab's hash.
    invalidateReader() {
      this.readerRequestId++;
      this.readerController?.abort();
      this.readerController = null;
      this.readerTargetId = null;
      this.readerLoading = false;
    },

    async openReader(article) {
      this.invalidateReader();
      const requestId = this.readerRequestId;
      const controller = this.readerController = new AbortController();
      const current = () => requestId === this.readerRequestId;
      this.readerTargetId = article.id;
      this.readerArticle = article;
      const permalink = `#/article/${article.id}`;
      if (location.hash !== permalink) location.hash = permalink;
      this.readerHtml = '';
      this.readerSource = null;
      this.readerLoading = true;
      if (!article.read_at) this.toggleRead(article);
      try {
        const data = await this.api(`/api/articles/${article.id}/reader`, { signal: controller.signal });
        // A generation also distinguishes closing/reopening the SAME id.
        // It is independent of Vue's proxy identity and works if abort is late.
        if (!current()) return;
        this.readerHtml = data.html;
        this.readerSource = data.source;
      } catch (err) {
        if (!current() || err.name === 'AbortError') return;
        this.error = `Cannot load article: ${err.message}`;
        this.readerArticle = null;
        this.readerTargetId = null;
      } finally {
        if (current()) this.readerLoading = false;
      }
    },

    closeReader({ restoreRoute = true } = {}) {
      this.invalidateReader();
      this.readerArticle = null;
      this.readerHtml = '';
      this.readerSource = null;
      if (restoreRoute) this.syncHash();
    },

    // Permalink target: reuse the list's copy of the article when present
    // (so votes stay in sync), otherwise fetch it — works from any mode,
    // including deep links straight into triage or topics.
    async openReaderById(id) {
      // The hashchange generated by openReader belongs to the same request.
      if (this.readerTargetId === id) return;
      this.invalidateReader();
      const requestId = this.readerRequestId;
      const controller = this.readerController = new AbortController();
      const feedbackRevision = outbox.revision;
      this.readerTargetId = id;
      const local = this.articles.find((a) => a.id === id) ?? (this.readerArticle?.id === id ? this.readerArticle : null);
      if (local) return this.openReader(local);
      try {
        const article = await this.api(`/api/articles/${id}`, { signal: controller.signal });
        if (requestId !== this.readerRequestId) return;
        return this.openReader(outbox.project(article, feedbackRevision));
      } catch (err) {
        if (requestId !== this.readerRequestId || err.name === 'AbortError') return;
        this.error = `Cannot load article: ${err.message}`;
        this.readerTargetId = null;
      }
    },

    async addFeed() {
      try {
        await this.api('/api/feeds', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: this.feedForm.url, title: this.feedForm.title }),
        });
        this.feedForm = { url: '', title: '' };
        this.feedNotice = 'Feed added — articles arrive on the next cron run.';
        this.loadSidebarData();
      } catch (err) {
        this.feedNotice = `Cannot add feed: ${err.message}`;
      }
    },

    async setFeedActive(feed, active) {
      try {
        await this.api(`/api/feeds/${feed.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ active }),
        });
        this.loadSidebarData();
      } catch (err) {
        this.feedNotice = `Cannot update feed: ${err.message}`;
      }
    },

    startRenameFeed(feed) {
      this.renamingFeedId = feed.id;
      this.renameFeedTitle = feed.title || '';
    },

    cancelRenameFeed() {
      this.renamingFeedId = null;
    },

    async saveFeedTitle(feed) {
      try {
        await this.api(`/api/feeds/${feed.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: this.renameFeedTitle }),
        });
        this.renamingFeedId = null;
        this.loadSidebarData();
      } catch (err) {
        this.feedNotice = `Cannot rename feed: ${err.message}`;
      }
    },

    async refreshFeeds() {
      try {
        await this.api('/api/refresh', { method: 'POST' });
        this.feedNotice = 'Fetching all feeds in the background…';
        setTimeout(() => this.loadSidebarData(), 5000);
      } catch (err) {
        this.feedNotice = `Refresh failed: ${err.message}`;
      }
    },

    until(iso) {
      const s = (new Date(iso).getTime() - Date.now()) / 1000;
      if (s <= 0) return 'due now';
      if (s < 5400) return `in ${Math.round(s / 60)}m`;
      if (s < 129600) return `in ${Math.round(s / 3600)}h`;
      return `in ${Math.round(s / 86400)}d`;
    },

    importOpml(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const { found } = await this.api('/api/feeds/import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ opml: reader.result }),
          });
          this.feedNotice = found
            ? `Imported ${found} feed(s).`
            : 'No feeds found in that file.';
          this.loadSidebarData();
        } catch (err) {
          this.feedNotice = `Import failed: ${err.message}`;
        }
        event.target.value = '';
      };
      reader.readAsText(file);
    },

    // Group identity of a (possibly shown) article: shown copies carry their
    // duplicate_of, the group root carries null — both resolve to the root,
    // so the versions/shown maps stay keyed consistently across a "show" swap.
    groupKey(a) {
      return a.duplicate_of ?? a.id;
    },

    async toggleVersions(article) {
      const key = this.groupKey(article);
      if (this.expandedVersions[key]) {
        delete this.expandedVersions[key];
        delete this.selectedVersion[key];
        return;
      }
      try {
        this.expandedVersions[key] =
          await this.api(`/api/articles/${article.id}/versions`);
      } catch (err) {
        this.error = `Cannot load versions: ${err.message}`;
      }
    },

    // Row button, three-way: unshow a shown copy, close an open preview, or
    // open the preview (whose actions are "show" and "not a duplicate").
    versionRowAction(display, version) {
      const key = this.groupKey(display);
      if (this.shownVersion[key]?.id === version.id) return this.unshowVersion(display);
      if (this.selectedVersion[key] === version.id) delete this.selectedVersion[key];
      else this.selectedVersion[key] = version.id;
    },

    // Temporarily show a copy as the group's card: the full usual controls
    // (mark read, open ↗, votes, reclassify) then apply to that copy.
    // Purely client-side — nothing is persisted, reload restores the original.
    async showVersion(display, version) {
      const key = this.groupKey(display);
      const idx = this.articles.findIndex((x) => this.groupKey(x) === key);
      if (idx < 0) return;
      let full = version;
      if (!full.content) {
        try {
          full = { ...version, ...(await this.api(`/api/articles/${version.id}`)) };
        } catch (err) {
          this.error = `Cannot load article: ${err.message}`;
          return;
        }
      }
      full.versions = this.articles[idx].versions; // keep the group badge
      this.shownOriginal[key] = this.articles[idx];
      this.shownVersion[key] = full;
      this.articles.splice(idx, 1, full);
      delete this.selectedVersion[key];
    },

    unshowVersion(display) {
      const key = this.groupKey(display);
      const original = this.shownOriginal[key];
      const shown = this.shownVersion[key];
      if (!shown) return;
      const idx = this.articles.findIndex((x) => x.id === shown.id);
      if (idx >= 0 && original) this.articles.splice(idx, 1, original);
      delete this.shownVersion[key];
      delete this.shownOriginal[key];
    },

    // Re-run duplicate detection on one article (same window/threshold as
    // the enrichment pipeline) — the undo path for a mistaken "not a
    // duplicate". If it re-attaches, the list reloads so the story bundles
    // under its original again; otherwise an inline note says so.
    async rededup(article) {
      try {
        const res = await this.api(`/api/articles/${article.id}/rededup`, { method: 'POST' });
        if (res.duplicateOf) {
          article.rededupNote = `matched “${res.title || '#' + res.duplicateOf}” — grouped again`;
          setTimeout(() => this.reload(), 1200);
        } else {
          article.rededupNote = res.error === 'no embedding'
            ? 'no summary embedding yet'
            : 'no duplicates found in the recent window';
        }
      } catch (err) {
        this.error = `Re-check failed: ${err.message}`;
      }
    },

    // The reader judged a "duplicate" wrong: detach the copy from its group.
    // Only copies (never the group root) can be detached. The list reloads
    // afterwards so the versions badge and counts reflect the smaller group.
    async unlink(article) {
      if (!confirm('Detach this copy from its duplicate group?')) return;
      try {
        await this.api(`/api/articles/${article.id}/unlink`, { method: 'POST' });
        await this.reload();
      } catch (err) {
        this.error = `Unlink failed: ${err.message}`;
      }
    },

    // Jump to the original a repeat was matched against: scroll to it when
    // it's in the current list, otherwise search for it across everything.
    async goToOriginal(article) {
      if (!this.articles.some((a) => a.id === article.duplicate_of)) {
        this.includeRead = true;
        this.topic = '';
        this.feedId = '';
        this.q = article.duplicate_title || '';
        await this.reload();
      }
      this.$nextTick(() => {
        const el = document.getElementById(`article-${article.duplicate_of}`);
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        this.flashId = article.duplicate_of;
        setTimeout(() => (this.flashId = null), 1600);
      });
    },

    // Preference tint: red (-1) through neutral gray (0) to green (+1).
    tint(pref, light = 90) {
      const hue = pref < 0 ? 12 : 145;
      const strength = Math.min(Math.abs(pref), 1);
      const sat = Math.round(strength * 55);
      const l = this.darkMode ? Math.round(15 + (100 - light) * 0.35) : light;
      return `hsl(${hue} ${sat}% ${l}%)`;
    },

    chipStyle(topicName) {
      const pref = this.prefByTopic[topicName] ?? 0;
      return {
        background: this.tint(pref, 91),
        borderColor: this.tint(pref, 78),
      };
    },

    edgeStyle(article) {
      const strength = Math.min(Math.abs(article.score), 1);
      return {
        '--edge-color': this.tint(article.score, 60),
        '--edge-alpha': (0.15 + strength * 0.85).toFixed(2),
      };
    },

    // The components behind an article's score. Values are the already-
    // weighted contributions, so they sum to the total (plus a possible
    // exploratory bonus for content in unvoted embedding regions).
    scoreParts(a) {
      const parts = [
        { label: 'topic votes', value: a.score_topics },
        { label: 'similar articles', value: a.score_embedding },
        { label: a.depth ? `depth (${a.depth}/5)` : 'depth (unrated)', value: a.score_depth },
        { label: 'source record', value: a.score_feed },
      ];
      if (a.score_bonus) parts.push({ label: 'exploratory bonus', value: a.score_bonus });
      return parts;
    },

    fmtPart(value) {
      return (value < 0 ? '−' : '+') + Math.abs(value ?? 0).toFixed(2);
    },

    fmtScore(score) {
      if (!score) return '·00';
      return (score > 0 ? '+' : '−') + Math.round(Math.abs(score) * 100)
        .toString()
        .padStart(2, '0');
    },

    ago(iso) {
      if (!iso) return '';
      const s = (Date.now() - new Date(iso).getTime()) / 1000;
      if (s < 90) return 'now';
      if (s < 5400) return `${Math.round(s / 60)}m`;
      if (s < 129600) return `${Math.round(s / 3600)}h`;
      return `${Math.round(s / 86400)}d`;
    },

    // Tooltip for the relative "ago" times: exact date/time, local timezone,
    // ISO8601 field order (year-month-day, then hour:minute) but with a
    // space instead of "T" and no seconds/offset — easier to read at a
    // glance than either raw ISO8601 or a locale-dependent format.
    fullDate(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },
  },
}).mount('#app');
