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
      ],
      view: 'interesting',
      topic: '',
      feedId: '',
      q: '',
      semantic: false,
      sort: 'hot',
      dupes: false,
      enrichedOnly: false,
      includeRead: false,
      articles: [],
      total: 0,
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
      guidelines: '',
      guidelinesNotice: '',
      topicMergeProposals: [],
      topicMergeLoading: false,
      topicMergeNotice: '',
      manualMerge: { from: '', to: '' },
      manualMergeNotice: '',
      stats: null,
      expandedId: null,
      expandedVersions: {},
      flashId: null,
      scoreDetailId: null,
      readerArticle: null,
      readerHtml: '',
      readerSource: null,
      readerLoading: false,
      loading: false,
      error: null,
      prefByTopic: {},
      articlesByTopic: {},
      searchTimer: null,
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
      return this.view === 'explore' ? 'unread' : this.view;
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
      clearTimeout(this.searchTimer);
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
    // Log commit hash for debugging
    this.api('/api/version').then((v) => console.log('rssmart', v.commit)).catch(() => {});

    // Retry queued triage votes/skips (see outbox.js) whenever there's a
    // reasonable signal connectivity might be back: on load (in case they
    // were queued in a previous session), on the browser's own online
    // event (best-effort -- it reflects network-interface state, not
    // actual reachability, so it can both under- and over-fire), and a
    // periodic fallback poll so a missed/wrong online event doesn't leave
    // votes stuck until the next unrelated trigger.
    this.flushOutbox();
    window.addEventListener('online', () => this.flushOutbox());
    setInterval(() => this.flushOutbox(), OUTBOX_POLL_MS);
  },

  methods: {
    params(offset) {
      const p = new URLSearchParams({
        view: this.apiView,
        sort: this.sort,
        limit: LIMIT,
        offset,
      });
      if (this.topic) p.set('topic', this.topic);
      if (this.feedId) p.set('feed_id', this.feedId);
      if (this.q) p.set('q', this.q);
      if (this.semantic && this.q) p.set('semantic', '1');
      if (this.dupes) p.set('dupes', '1');
      if (this.enrichedOnly) p.set('status', 'enriched');
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
      this.flushOutbox(); // fire-and-forget: a response at all proves connectivity right now
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `${res.status} ${res.statusText}`);
      }
      return res.json();
    },

    async flushOutbox() {
      await outbox.flush();
      this.outboxCount = outbox.count;
    },

    /**
     * Attempt a write; on success, hand the parsed response to onSuccess.
     * On a real rejection (4xx) throw, same as api() -- that's not a
     * connectivity problem. On a network failure or 5xx, apply onQueued's
     * optimistic local update and queue the request in the outbox (see
     * outbox.js) to replay later instead of blocking/erroring the caller.
     */
    async attemptOrQueue(path, options, { onSuccess, onQueued }) {
      let res;
      try {
        res = await fetch(path, options);
      } catch {
        res = null;
      }
      if (res && res.ok) {
        onSuccess(await res.json());
        this.flushOutbox();
      } else if (res && res.status < 500) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `${res.status} ${res.statusText}`);
      } else {
        onQueued();
        outbox.enqueue(path, options);
        this.outboxCount = outbox.count;
      }
    },

    async reload() {
      this.loading = true;
      this.error = null;
      this.expandedId = null;
      this.expandedVersions = {};
      try {
        const data = await this.api(`/api/articles?${this.params(0)}`);
        this.articles = data.articles;
        this.total = data.total;
      } catch (err) {
        this.error = `Cannot load articles: ${err.message}`;
      } finally {
        this.loading = false;
      }
    },

    async loadMore() {
      this.loading = true;
      try {
        const data = await this.api(`/api/articles?${this.params(this.articles.length)}`);
        this.articles.push(...data.articles);
        this.total = data.total;
      } catch (err) {
        this.error = `Cannot load articles: ${err.message}`;
      } finally {
        this.loading = false;
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
      const routes = ['interesting', 'unread', 'explore', 'triage', 'topics', 'feeds'];
      if (replace && !routes.includes(route)) {
        history.replaceState(null, '', `#/${this.currentRoute()}`);
        return;
      }
      if (route === this.currentRoute()) return;
      if (['triage', 'topics', 'feeds'].includes(route)) this.openPanel(route);
      else if (['interesting', 'unread', 'explore'].includes(route)) this.setView(route);
    },

    setView(v) {
      this.panel = null;
      this.view = v;
      this.sort = v === 'interesting' ? 'hot' : v === 'explore' ? 'novelty' : 'date';
      this.syncHash();
      this.reload();
    },

    openPanel(name) {
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
      this.startTriage('filtered');
      this.panel = 'triage';
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
      this.triageLoading = true;
      try {
        let offset = 0;
        let queue = [];
        for (;;) {
          const data = await this.api(`/api/articles?${this.triageParams(offset)}`);
          queue = data.articles.filter((a) => !this.triageSeen.has(a.id));
          if (queue.length > 0 || data.articles.length === 0) break;
          offset += data.articles.length;
        }
        this.triageQueue = queue;
        this.triagePos = 0;
        this.collapseTriageContent();
      } catch (err) {
        this.error = `Cannot load triage queue: ${err.message}`;
      } finally {
        this.triageLoading = false;
      }
    },

    async triageAdvance() {
      if (this.triageCurrent) this.triageSeen.add(this.triageCurrent.id);
      this.triageProcessed++;
      this.triagePos++;
      this.collapseTriageContent();
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
        const updated = await this.api(`/api/articles/${article.id}/vote`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ vote }),
        });
        Object.assign(article, updated); // vote, score and its components
        this.loadSidebarData();
      } catch (err) {
        this.error = `Vote failed: ${err.message}`;
      }
    },

    async toggleRead(article) {
      try {
        const updated = await this.api(`/api/articles/${article.id}/read`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ read: !article.read_at }),
        });
        article.read_at = updated.read_at;
        this.loadSidebarData();
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
    // the overlay remains as the real-new-tab escape hatch.
    async openReader(article) {
      this.readerArticle = article;
      this.readerHtml = '';
      this.readerSource = null;
      this.readerLoading = true;
      if (!article.read_at) this.toggleRead(article);
      try {
        const data = await this.api(`/api/articles/${article.id}/reader`);
        if (this.readerArticle !== article) return; // closed or switched while loading
        this.readerHtml = data.html;
        this.readerSource = data.source;
      } catch (err) {
        if (this.readerArticle !== article) return;
        this.error = `Cannot load article: ${err.message}`;
        this.readerArticle = null;
      } finally {
        if (this.readerArticle === article) this.readerLoading = false;
      }
    },

    closeReader() {
      this.readerArticle = null;
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

    async toggleVersions(article) {
      if (this.expandedVersions[article.id]) {
        delete this.expandedVersions[article.id];
        return;
      }
      try {
        this.expandedVersions[article.id] =
          await this.api(`/api/articles/${article.id}/versions`);
      } catch (err) {
        this.error = `Cannot load versions: ${err.message}`;
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
