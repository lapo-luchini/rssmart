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
Each copy there can be previewed with full details and voted on directly,
marked "not a duplicate" if the match was wrong (with a **re-check
duplicates** action in the expanded article to undo a mistake), and the
original the others were matched against is tagged. The "all versions"
toggle ungroups everything.

## Setup

```sh
pnpm install
cp config.example.yaml config.yaml   # then edit; config.yaml is gitignored
```

`pnpm install` needs network access once: its `postinstall` step fetches the
frontend's Vue build from a CDN (checksum-verified). Runs on both **Node.js
(24+)** and **[Bun](https://bun.sh)** — the package scripts pick whichever
runtime is installed; see [DESIGN.md](DESIGN.md) for how that works and what
to do after upgrading Node (a one-time native-addon rebuild).

Configure in `config.yaml` (the shipped `config.example.yaml` already has
these defaults):

- `ollama.url` — your Ollama instance, e.g. `http://192.168.1.10:11434`.
- `ollama.chatModel` — any instruct model for topics/summaries/depth, e.g.
  `gemma4:26b-mlx`.
- `ollama.embedModel` — embedding model for the text vectors behind taste
  scoring and search. Default: `leoipulsar/harrier-0.6b`.
- `ollama.dedupEmbedModel` — optional second embedding model used only for
  the summary vectors that detect duplicates. Default:
  `qwen3-embedding:0.6b` — benchmarked better at duplicate detection than
  harrier, which instead wins at taste clustering. Omit to use `embedModel`
  for everything.
- `ollama.embedDimensions` / `dedupEmbedDimensions` — optional
  Matryoshka-style truncation (defaults in the example config: 512 for text
  vectors, 64 for dedup). Only models trained for it (MRL, e.g.
  qwen3-embedding) keep quality when truncated — check the model card.
- `enrich.dupThreshold` — cosine similarity above which a story counts as a
  repeat (default 0.87; raise it if distinct stories get flagged).
- `enrich.fetchMinChars` — link-only feeds (e.g. Hacker News) carry almost no
  text, so when an RSS entry has less than this many characters, the
  article's origin page is fetched and its readable content extracted
  (Firefox reader mode) for classification, summarizing, and the expanded
  view. Set 0 to disable.
- `enrich.maxArticleChars` (default 50000) — hard cap on a fetched origin
  page's stored text/html, regardless of how well it extracted.
- `enrich.maxSuggestedTopics` (default 150) — the topic vocabulary only
  grows, and the full list rides in every classification prompt; this
  shows the classifier only the N most-used topics. 0 shows the full list.

## Usage

```sh
node bin/rssmart.js serve    # web UI on http://127.0.0.1:8098 + built-in scheduler
node bin/rssmart.js cron     # one-shot: fetch due feeds, classify, exit
```

`serve` is self-sufficient: its internal scheduler (`scheduler.enabled`)
fetches each feed on an adaptive cadence — roughly as often as it publishes,
bounded by `scheduler.minIntervalMin`/`maxIntervalMin` — and continuously
classifies pending articles. No system cron required.

`cron` remains for one-shot uses: backfills (`--max-run 0`), debugging
(`--debug`), or driving rssmart from system cron instead of the scheduler
(set `scheduler.enabled: false` then). It fetches only feeds that are due
(`--all-feeds` overrides), works within a time budget (`cron.maxRunMs`,
default 5 minutes; unfinished classification continues on the next run), and
a lease in the DB ensures a cron run and a running scheduler never classify
the same queue twice. `cron` and `serve` can run concurrently (SQLite WAL).

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

If Ollama is down, ingestion still works; articles stay `pending` and are
classified on a later run (after 5 failed attempts an article is parked as
unclassifiable).

## Web UI

- **Interesting** (default): unread, sorted "hot" — interest blended with
  freshness (`scoring.hotDecayPerDay`), so an old article can't bury a fresh
  one just by having a slightly higher score. **Unread** is newest first;
  **Explore** sorts by novelty (furthest from anything you've voted on).
  Plus topic + feed filters, full-text search, and an "include read" toggle.
- Every tab has its own hash route (`#/interesting`, `#/unread`,
  `#/explore`, `#/triage`, `#/topics`, `#/feeds`) — bookmarkable, and
  back/forward works.
- **⚡Triage**: a fast, keyboard-driven way to vote through your unread,
  *classified* backlog — one article at a time, no clicking into anything.
  `↑` more interesting, `↓` less interesting, `Shift+↑` WOW, `Shift+↓`
  never, `←`/`⌫` back, `→`/`space`/`enter` skip (marks read without
  voting), `esc` exit, `p` expands the full article inline, `o` opens the
  source in a new tab. Aimed squarely at the sparsity problem: a smarter
  algorithm can't beat more training data, and this is the fastest way to
  generate it.
- **⚡ triage this** (next to the filters) runs the same triage UI over
  whatever the list is already showing — current topic/feed/search/sort
  included. `esc` returns to that filtered view.
- ▲ / ▼ vote to teach it: one click = interesting (±1), a second click = WOW
  (±2, counts double in every signal), a third clears. Expanding a story
  marks it read; `esc` collapses whichever one is open. Topic chips and
  each story's left edge are tinted by learned preference: green = liked,
  red = disliked.
- **open ↗** opens an in-page reader instead of a new tab, fetching the
  origin page on demand if the feed's own text looks thin. `esc` or **←
  back** returns to exactly where you were.
- Disagree with a classification? Expand the article and hit **reclassify**,
  optionally with a note ("this is about hardware, not software") — the note
  is stored with the article, shown to the LLM together with the previous
  classification, and the article jumps the queue. For corrections that
  should apply to *everything*, edit the **classification guidelines** in
  the Topics tab: that text rides along with every classification request.
- Check **semantic** next to the search box to rank results by meaning
  instead of matching words — "microwave power grid" can find an article
  that never uses those words. Results show a match-strength badge.
- **Topics** and **Feeds** tabs: Topics shows every learned topic with its
  preference, votes and article count; Feeds is feed management — add a
  feed, import/export OPML, enable/disable sources, and see each feed's
  average vote, articles/week, and fetch success/error record.
- **Find redundant topics** (Topics tab) asks the LLM to spot near-duplicate
  topics and propose collapsing each into one. Nothing is applied
  automatically — review each proposal and click **merge** or **skip**;
  merging retags every affected article and blends the two topics' vote
  history permanently. A merged-away name is remembered: if the classifier
  suggests it again later, it's silently redirected to the topic you kept.

## Notes

- Data lives in the SQLite file set by `config.db` (default `./data/rssmart.db`).
- Feed HTML is stripped of scripts/event handlers before storage, but this is
  a personal-use reader — don't expose it to the open internet.
- Full-text search only matches title/summary, not article bodies; use
  **semantic** search (embeds a sample of the full text) to search by meaning.
- `pnpm run dbstats` reports file size, row counts, and a per-column
  breakdown of the database — read-only, safe to run anytime.
- `pnpm run bench-model <model> [...]` benchmarks one or more Ollama chat
  models for speed and output quality against real articles from your own
  DB, using the exact production classification prompt — read-only, and a
  handy way to judge whether a new model release is worth switching to.
- Duplicate grouping links a story to a group when it's similar to any
  member, so a bulk-ingested archive of a formulaic newsletter (e.g. years
  of a weekly digest at once) can chain into one large group; the versions
  list tags the original and the per-copy "not a duplicate" action is the
  fix. `node scripts/repair-dedup.js` re-validates every stored link after
  any embedding-model change (`--fix` applies; see the script header).
- Origin-page fetching refuses article links that resolve to private, loopback
  or link-local addresses (feed content is third-party input; this prevents a
  malicious feed from probing your LAN). `enrich.allowPrivateFetch: true`
  disables the guard for trusted intranet feeds.
- Tests: `pnpm test` (stubs both the RSS feeds and the Ollama API; no network).

## Design

Why things are built this way — including the runtime-selection details,
embedding storage internals, and where the known scaling limits are — lives
in [DESIGN.md](DESIGN.md).
