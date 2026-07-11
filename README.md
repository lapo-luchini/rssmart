# rssmart

A self-hosted personalized news feed. It ingests RSS feeds into SQLite, uses a
network-local [Ollama](https://ollama.com) instance to classify articles by
topic, write ~50-word previews, and detect near-duplicate stories, and learns
what you like from explicit 👍/👎 votes given while you read.

## How the learning works

An article's interest score blends four signals (weights in `scoring.weights`),
each −1…+1 and neutral when it has no data, recomputed on every vote and
every cron run — no training jobs:

- **topic votes** — Laplace-smoothed up/down ratio of the article's topics;
- **similar articles** — k-nearest-neighbors over the raw-text embeddings of
  articles you voted on, so it learns style/genre taste that shared topic
  names flatten;
- **depth** — an LLM rating (1–5) of substance and craft, so a thin rehash
  scores below real reporting on the same subject;
- **source record** — the feed's own vote ratio.

Click or hover an article's score in the UI to see the breakdown.

Near-duplicate stories (detected by cosine similarity of summary embeddings)
are bundled: the list shows one card per news item — its best-scoring
version — with an "N more versions" badge that expands the others inline.
The "all versions" toggle ungroups them.

## Setup

```sh
pnpm install
cp config.example.yaml config.yaml   # then edit; config.yaml is gitignored
```

Runs on both **Node.js** and **[Bun](https://bun.sh)**: `src/db.js` picks
`bun:sqlite` under Bun and `better-sqlite3` under Node automatically, so
`bun bin/rssmart.js serve` / `bun bin/rssmart.js cron` work exactly like
their `node` equivalents (including `bun run cron` / `bun run serve` via
the package.json scripts). No config needed — just use whichever
`node`/`bun` binary is on your `PATH`.

Configure in `config.yaml`:

- `ollama.url` — your Ollama instance, e.g. `http://192.168.1.10:11434`.
- `ollama.chatModel` — any instruct model, e.g. `llama3.1`, `qwen3`.
- `ollama.embedModel` — an embedding model, e.g. `nomic-embed-text`
  (`ollama pull nomic-embed-text`).
- `enrich.dupThreshold` — cosine similarity above which a story counts as a
  repeat (default 0.87; raise it if distinct stories get flagged).
- `enrich.fetchMinChars` — link-only feeds (e.g. Hacker News) carry almost no
  text, so when an RSS entry has less than this many characters, the
  article's origin page is fetched and its readable content extracted
  (Firefox reader mode) for classification, summarizing, and the expanded
  view. Set 0 to disable.

## Usage

```sh
node bin/rssmart.js serve    # web UI on http://0.0.0.0:8098 + built-in scheduler
node bin/rssmart.js cron     # one-shot: fetch due feeds, classify, exit
```

`serve` is self-sufficient: its internal scheduler (`scheduler.enabled`)
fetches each feed on an adaptive cadence — roughly as often as it publishes,
bounded by `scheduler.minIntervalMin`/`maxIntervalMin` — and continuously
classifies pending articles. No system cron required.

`cron` remains for one-shot uses: backfills (`--max-run 0`), debugging
(`--debug`), or driving rssmart from system cron instead of the scheduler
(set `scheduler.enabled: false` then). It fetches only feeds that are due
(`--all-feeds` overrides), and a lease in the DB ensures a cron run and a
running scheduler never classify the same queue twice.

`--config <path>` (or `RSSMART_CONFIG`) selects the config file;
`--port <n>` overrides the serve port.

`cron` follows cron etiquette: silent when all is well, problems on stderr
(so real cron only emails you on failure). To watch it work when running
manually, add `--verbose` (per-feed and per-article progress) or `--debug`
(also prints the generated summaries). Every log line (cron and serve,
including the internal scheduler's) is prefixed with an ISO8601 timestamp
(`src/log.js`), so output from concurrent processes can be interleaved and
ordered correctly.

If you prefer system cron over the internal scheduler, e.g. every 30 minutes:

```cron
*/30 * * * * cd /project/rssmart && node bin/rssmart.js cron
```

Feeds themselves are managed from the web UI (Feeds tab); a config `feeds:`
list is optional and only seeds the database.

Each cron run fetches feeds and classifies articles in parallel (one is
network-bound, the other Ollama-bound) within a time budget
(`cron.maxRunMs`, default 5 minutes; `--max-run <minutes>` overrides it,
`--max-run 0` removes it for long backfills); classification work that
doesn't fit continues on the next run. `cron` and `serve` can run concurrently
(SQLite WAL). If Ollama is down,
ingestion still works; articles stay `pending` and are classified on a later
run (after 5 failed attempts an article is parked as unclassifiable).

## Web UI

- **Unread** (default): unread articles, newest first, repeats hidden.
- **Interesting**: unread, sorted "hot" — interest blended with freshness
  (`scoring.hotDecayPerDay`), so an old article can't bury a fresh one just
  by having a slightly higher score. Pure "by interest" and "by date" are
  also selectable. **All** shows everything. Plus topic + feed filters,
  full-text search, and a "repeats" toggle.
- Every tab has its own hash route (`#/unread`, `#/interesting`, `#/all`,
  `#/triage`, `#/topics`, `#/feeds`) — bookmarkable, and back/forward works.
- **⚡Triage**: a fast, keyboard-driven way to vote through your unread
  backlog — one article at a time (title, summary, topics), no clicking
  into anything. `↑` more interesting, `↓` less interesting, `PgUp` WOW,
  `PgDn` never, `←`/`⌫` back, `→`/`space`/`enter` skip (marks read without
  voting), `esc` exit. The on-screen buttons form a cross matching this
  layout: PgUp/PgDn are the outer top/bottom buttons, back/skip flank the
  middle two. Click the title (or tap it) to expand the full extracted
  article inline, below the vote buttons, without leaving triage or
  marking it read — and **open original ↗** next to the byline is a real
  new-tab link for the cases where the extraction isn't enough. Aimed
  squarely at the sparsity problem: a smarter algorithm can't beat more
  training data, and this is the fastest way to generate it.
- ▲ / ▼ vote to teach it: one click = interesting (±1), a second click = WOW
  (±2, counts double in every signal), a third clears. Expanding a story
  marks it read. Topic chips and each story's left edge are tinted by
  learned preference: green = liked, red = disliked.
- **open ↗** opens an in-page reader instead of a new tab (closing a tab used
  to leave you on whatever tab happened to be next, not the one you came
  from). It shows our own extracted full-text — many sites refuse to be
  iframed — fetching the origin page on demand if the feed's own text looks
  thin. `esc` or **← back** returns to exactly where you were; **open
  original ↗** is still there as a real new tab for when you want the live
  page. Vote and mark-read controls stay reachable from the reader's top bar.
- Disagree with a classification? Expand the article and hit **reclassify**,
  optionally with a note ("this is about hardware, not software") — the note
  is stored with the article, shown to the LLM together with the previous
  classification, and the article jumps the queue. For corrections that
  should apply to *everything*, edit the **classification guidelines** in
  the Topics tab: that text rides along with every classification request.
- Check **semantic** next to the search box to rank results by meaning
  instead of matching words — "microwave power grid" can find an article
  that never uses those words. It embeds your query with the same model
  used to store article vectors and ranks by cosine similarity; only
  classified articles are searchable (pending ones have no vector yet),
  and results show a match-strength badge. Falls back to a clear error
  if Ollama is unreachable rather than silently returning nothing.
- **Topics** and **Feeds** tabs (right side of the tab bar) replace the
  article list with their own views: Topics shows every learned topic with
  its preference, votes and article count (click through to its articles);
  Feeds is feed management — add a feed, import/export OPML, enable/disable
  sources, and see each feed's average vote, articles/week, and fetch
  success/error record.

## Notes

- Data lives in the SQLite file set by `config.db` (default `./data/rssmart.db`).
- Feed HTML is stripped of scripts/event handlers before storage, but this is
  a personal-use reader — don't expose it to the open internet.
- Origin-page fetching refuses article links that resolve to private, loopback
  or link-local addresses (feed content is third-party input; this prevents a
  malicious feed from probing your LAN). `enrich.allowPrivateFetch: true`
  disables the guard for trusted intranet feeds.
- Tests: `pnpm test` (stubs both the RSS feeds and the Ollama API; no network).

## Design

Why things are built this way — and where the known scaling limits are —
lives in [DESIGN.md](DESIGN.md).
