import { createApp } from './vendor/vue.esm-browser.prod.js';

const LIMIT = 50;

createApp({
  data() {
    return {
      views: [
        { id: 'interesting', label: 'Interesting' },
        { id: 'unread', label: 'Unread' },
        { id: 'all', label: 'All' },
      ],
      view: 'unread',
      topic: '',
      feedId: '',
      q: '',
      sort: 'date',
      dupes: false,
      articles: [],
      total: 0,
      topics: [],
      feeds: [],
      feedsDetailed: [],
      panel: null, // null = article list, 'topics' | 'feeds' = content tabs
      topicSort: { key: 'pref', dir: -1 },
      feedSort: { key: null, dir: -1 }, // null = server order (active first)
      feedForm: { url: '', title: '' },
      feedNotice: '',
      stats: null,
      expandedId: null,
      flashId: null,
      scoreDetailId: null,
      loading: false,
      error: null,
      prefByTopic: {},
      searchTimer: null,
    };
  },

  computed: {
    topicsRanked() {
      const value = (t, key) => ({
        name: t.name.toLowerCase(),
        votes: t.up + t.down,
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

    emptyMessage() {
      if (this.q || this.topic || this.feedId) return 'Nothing matches these filters.';
      if (this.view === 'all') return 'No articles yet. Add feeds in the Feeds tab and run: rssmart cron';
      return 'All caught up. New articles arrive on the next cron run.';
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
    this.reload();
    this.loadSidebarData();
  },

  methods: {
    params(offset) {
      const p = new URLSearchParams({
        view: this.view,
        sort: this.sort,
        limit: LIMIT,
        offset,
      });
      if (this.topic) p.set('topic', this.topic);
      if (this.feedId) p.set('feed_id', this.feedId);
      if (this.q) p.set('q', this.q);
      if (this.dupes) p.set('dupes', '1');
      return p;
    },

    async api(path, options) {
      const res = await fetch(path, options);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `${res.status} ${res.statusText}`);
      }
      return res.json();
    },

    async reload() {
      this.loading = true;
      this.error = null;
      this.expandedId = null;
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
      if (replace && !['interesting', 'unread', 'all', 'topics', 'feeds'].includes(route)) {
        history.replaceState(null, '', `#/${this.currentRoute()}`);
        return;
      }
      if (route === this.currentRoute()) return;
      if (route === 'topics' || route === 'feeds') this.openPanel(route);
      else if (['interesting', 'unread', 'all'].includes(route)) this.setView(route);
    },

    setView(v) {
      this.panel = null;
      this.view = v;
      this.sort = v === 'interesting' ? 'score' : 'date';
      this.syncHash();
      this.reload();
    },

    openPanel(name) {
      this.panel = name;
      this.feedNotice = '';
      this.syncHash();
      this.loadSidebarData();
    },

    filterTopic(name) {
      this.panel = null;
      this.topic = name;
      this.reload();
    },

    // Voting escalates: ▲ = interesting (+1), ▲ again = WOW (+2), again = clear.
    voteCycle(article, direction) {
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

    // Jump to the original a repeat was matched against: scroll to it when
    // it's in the current list, otherwise search for it across everything.
    async goToOriginal(article) {
      if (!this.articles.some((a) => a.id === article.duplicate_of)) {
        this.view = 'all';
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
      return `hsl(${hue} ${sat}% ${light}%)`;
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

    // The four learned components behind an article's score. Values are the
    // already-weighted contributions, so they sum to the total.
    scoreParts(a) {
      return [
        { label: 'topic votes', value: a.score_topics },
        { label: 'similar articles', value: a.score_embedding },
        { label: a.depth ? `depth (${a.depth}/5)` : 'depth (unrated)', value: a.score_depth },
        { label: 'source record', value: a.score_feed },
      ];
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
  },
}).mount('#app');
