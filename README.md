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
(also prints the generated summaries).

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
- **Interesting**: unread, sorted by learned interest score. **All** shows
  everything. Plus topic + feed filters, full-text search, sort selector,
  and a "repeats" toggle.
- Every tab has its own hash route (`#/unread`, `#/interesting`, `#/all`,
  `#/topics`, `#/feeds`) — bookmarkable, and back/forward works.
- ▲ / ▼ vote to teach it: one click = interesting (±1), a second click = WOW
  (±2, counts double in every signal), a third clears. Expanding a story
  marks it read. Topic chips and each story's left edge are tinted by
  learned preference: green = liked, red = disliked.
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

## Design notes

- **Node.js over Go**: a tool you rely on daily belongs in the language you
  can fix fastest, and it keeps the stack coherent with the Vue frontend. A
  Go rewrite against the same SQLite schema and HTTP API would make a good
  learning project.
- **Duplicate detection uses embeddings, not a generative prompt**: cosine
  similarity of summary embeddings is cheap, deterministic, and needs no
  prompt engineering.
- **No LLM in the preference loop**: scoring derives from your votes at
  recompute time — transparent, inspectable, retrains "for free".
- Ideas deliberately deferred: non-RSS sources (the feeds table would grow a
  `kind` column), bookmarkable filter state in the URL hash.
