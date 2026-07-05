# rssmart

A self-hosted personalized news feed. It ingests RSS feeds into SQLite, uses a
network-local [Ollama](https://ollama.com) instance to classify articles by
topic, write ~50-word previews, and detect near-duplicate stories, and learns
what you like from explicit 👍/👎 votes given while you read.

## How the learning works

Every vote adjusts the preference of the article's topics
(Laplace-smoothed up/down ratio, range −1…+1). An article's interest score is
the mean preference of its topics, recomputed on every vote and every cron
run — no training jobs, fully inspectable via `GET /api/topics`. Duplicates
are detected by cosine similarity of embeddings against recent articles.

## Setup

```sh
pnpm install
cp config.example.yaml config.yaml   # then edit; config.yaml is gitignored
```

Configure in `config.yaml`:

- `feeds` — list of `{url, title?}` entries (or plain URL strings).
  Removing a feed deactivates it; its articles are kept.
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
node bin/rssmart.js cron     # fetch feeds, classify new articles, exit
node bin/rssmart.js serve    # web UI on http://0.0.0.0:8098
```

`--config <path>` (or `RSSMART_CONFIG`) selects the config file;
`--port <n>` overrides the serve port.

`cron` follows cron etiquette: silent when all is well, problems on stderr
(so real cron only emails you on failure). To watch it work when running
manually, add `--verbose` (per-feed and per-article progress) or `--debug`
(also prints the generated summaries).

Schedule ingestion with system cron, e.g. every 30 minutes:

```cron
*/30 * * * * cd /project/rssmart && node bin/rssmart.js cron
```

Each cron run fetches feeds and classifies articles in parallel (one is
network-bound, the other Ollama-bound) within a time budget
(`cron.maxRunMs`, default 5 minutes); classification work that doesn't fit
continues on the next run. `cron` and `serve` can run concurrently
(SQLite WAL). If Ollama is down,
ingestion still works; articles stay `pending` and are classified on a later
run (after 5 failed attempts an article is parked as unclassifiable).

## Web UI

- **Interesting** (default): unread, repeats hidden, sorted by learned score.
- **Unread / All** tabs, topic + feed filters, full-text search, date sort,
  and a "repeats" toggle.
- ▲ / ▼ vote to teach it (click again to retract); expanding a story marks it
  read. Topic chips and each story's left edge are tinted by learned
  preference: green = liked, red = disliked.

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

See `docs/superpowers/specs/2026-07-05-rssmart-design.md` for architecture and
the reasoning behind the main decisions (including why Node.js over Go).
