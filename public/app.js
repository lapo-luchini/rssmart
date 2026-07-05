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
      view: 'interesting',
      topic: '',
      feedId: '',
      q: '',
      sort: 'score',
      dupes: false,
      articles: [],
      total: 0,
      topics: [],
      feeds: [],
      stats: null,
      expandedId: null,
      loading: false,
      error: null,
      prefByTopic: {},
      searchTimer: null,
    };
  },

  computed: {
    emptyMessage() {
      if (this.q || this.topic || this.feedId) return 'Nothing matches these filters.';
      if (this.view === 'all') return 'No articles yet. Add feeds to config.json and run: rssmart cron';
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
        this.feeds = feeds.filter((f) => f.active);
        this.stats = stats;
        this.prefByTopic = Object.fromEntries(topics.map((t) => [t.name, t.pref]));
      } catch {
        /* header extras are non-essential */
      }
    },

    setView(v) {
      this.view = v;
      this.sort = v === 'interesting' ? 'score' : 'date';
      this.reload();
    },

    async vote(article, value) {
      const vote = article.vote === value ? 0 : value; // second click retracts
      try {
        const updated = await this.api(`/api/articles/${article.id}/vote`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ vote }),
        });
        article.vote = updated.vote;
        article.score = updated.score;
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
