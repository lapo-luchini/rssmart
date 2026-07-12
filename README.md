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

`pnpm install` needs network access once: its `postinstall` step
(`scripts/vendor.js`) fetches the frontend's Vue build directly from a CDN,
checksum-verified, rather than installing the full `vue` npm package (whose
own dependency chain — SSR, SFC compilation, none of it used here — is
~28MB for a single 170KB file). Already-vendored installs skip the fetch.

Runs on both **Node.js (24+)** and **[Bun](https://bun.sh)**: `src/db.js`
picks `bun:sqlite` under Bun and `better-sqlite3` under Node automatically,
so `bun bin/rssmart.js serve` / `bun bin/rssmart.js cron` work exactly like
their `node` equivalents (including `bun run cron` / `bun run serve` via
the package.json scripts). No config needed — just use whichever
`node`/`bun` binary is on your `PATH`. Node 24 is required for native
`Float16Array` (embeddings are stored as float16 — see below); if you're
on an older Node, install 24 via `nvm install 24` and rebuild the native
addon once: `nvm use 24 && npm rebuild better-sqlite3`. `bin/rssmart.js`
checks for `Float16Array` at startup and exits with a clear error if it's
missing, rather than failing later inside an embed/search call — the
project is only tested against Node/Bun versions meeting `engines` in
`package.json`; older-but-Float16-capable runtimes get a warning, not a
hard stop.

Configure in `config.yaml`:

- `ollama.url` — your Ollama instance, e.g. `http://192.168.1.10:11434`.
- `ollama.chatModel` — any instruct model, e.g. `gemma4:12b-it-qat`, `qwen3`.
- `ollama.embedModel` — an embedding model, e.g. `nomic-embed-text`
  (`ollama pull nomic-embed-text`).
- `ollama.embedDimensions` — optional Matryoshka-style truncation (e.g. `512`
  for a 1024-dim model): halves embedding storage on top of the float16
  format, with little accuracy loss — only if your model supports it
  (check its card; qwen3-embedding does). Omit to use the model's native
  dimension.
- `enrich.dupThreshold` — cosine similarity above which a story counts as a
  repeat (default 0.87; raise it if distinct stories get flagged).
- `enrich.fetchMinChars` — link-only feeds (e.g. Hacker News) carry almost no
  text, so when an RSS entry has less than this many characters, the
  article's origin page is fetched and its readable content extracted
  (Firefox reader mode) for classification, summarizing, and the expanded
  view. Set 0 to disable.
- `enrich.maxArticleChars` (default 50000) — hard cap on a fetched origin
  page's stored text/html, regardless of how well it extracted. Guards
  against pages that aren't really a single article (e.g. an `#anchor`
  into a shared listing/archive page, which fetches the same huge page
  every time since fragments never reach the server).

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

- **Interesting** (default): unread, sorted "hot" — interest blended with
  freshness (`scoring.hotDecayPerDay`), so an old article can't bury a
  fresh one just by having a slightly higher score. Pure "by interest" and
  "by date" are also selectable.
- **Unread**: unread articles, newest first, repeats hidden. **All** shows
  everything. Plus topic + feed filters, full-text search, and a "repeats"
  toggle.
- Every tab has its own hash route (`#/unread`, `#/interesting`, `#/all`,
  `#/triage`, `#/topics`, `#/feeds`) — bookmarkable, and back/forward works.
- **⚡Triage**: a fast, keyboard-driven way to vote through your unread,
  *classified* backlog (not-yet-classified articles are excluded — triage
  runs on title/summary/topics, which a pending article doesn't have yet)
  — one article at a time, no clicking into anything. `↑` more interesting,
  `↓` less interesting, `Shift+↑` WOW, `Shift+↓` never, `←`/`⌫` back,
  `→`/`space`/`enter` skip (marks read without voting), `esc` exit.
  The on-screen buttons form a cross matching this layout: WOW/never are
  the outer top/bottom buttons, back/skip flank the middle two. `p` (or
  click the title, or `PgDn` the first time — after that `PgDn` just
  scrolls the now-visible content normally) expands
  the full extracted article inline below the vote buttons — wider than
  the card itself, so long paragraphs cost fewer scrolled lines — without
  leaving triage or marking it read; `o` (or **open original ↗** next to
  the byline) opens the real source page in a new tab for the cases where
  the extraction isn't enough. Aimed squarely at the sparsity problem: a
  smarter algorithm can't beat more training data, and this is the fastest
  way to generate it.
- ▲ / ▼ vote to teach it: one click = interesting (±1), a second click = WOW
  (±2, counts double in every signal), a third clears. Expanding a story
  marks it read; `esc` collapses whichever one is open, from anywhere on
  the page — handy after scrolling down into a long one. Topic chips and
  each story's left edge are tinted by learned preference: green = liked,
  red = disliked.
- **open ↗** opens an in-page reader instead of a new tab. It shows our own
  extracted full-text — many sites refuse to be iframed — fetching the
  origin page on demand if the feed's own text looks thin. `esc` or **←
  back** returns to exactly where you were; **open original ↗** is still
  there as a real new tab for when you want the live page. Vote and
  mark-read controls stay reachable from the reader's top bar.
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
- `content`/`full_content` are stored brotli-compressed (still `TEXT`-typed
  columns — SQLite stores the BLOB as-is), which is why full-text search only
  matches title/summary, not article bodies; use **semantic** search (embeds
  a sample of the full text) to search by meaning instead.
- Example size breakdown for a real ~6,000-article database (28.1 MB total,
  after `VACUUM`; run `VACUUM` yourself after a large backfill or config
  change — SQLite doesn't reclaim freed pages from the file on its own):

  | column | size | notes |
  |---|---|---|
  | `embedding` + `text_embedding` | 11.8 MB | two float16 vectors/article (see `ollama.embedDimensions`) |
  | `content` | 3.6 MB | brotli-compressed RSS text |
  | `full_content` | 2.8 MB | brotli-compressed, only for articles with a fetched/cached copy |
  | `summary` | 1.3 MB | LLM-generated |
  | indexes | ~1.2 MB | |
  | every other column (id, dates, scores, status, vote…) + per-row overhead | ~7.4 MB | many small columns, none individually significant |

  Actual numbers scale with corpus size and how much of it has cached
  `full_content`/embeddings, but the *shape* — embeddings and article text
  dominate, everything else is small — should hold generally.
- Origin-page fetching refuses article links that resolve to private, loopback
  or link-local addresses (feed content is third-party input; this prevents a
  malicious feed from probing your LAN). `enrich.allowPrivateFetch: true`
  disables the guard for trusted intranet feeds.
- Tests: `pnpm test` (stubs both the RSS feeds and the Ollama API; no network).

## Design

Why things are built this way — and where the known scaling limits are —
lives in [DESIGN.md](DESIGN.md).
