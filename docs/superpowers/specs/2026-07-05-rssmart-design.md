# rssmart — Personalized News Feed: Design

Date: 2026-07-05
Status: approved (autonomous mode — decisions documented below; user set goal via /goal and is not available for interactive review)

## Purpose

A self-hosted personalized news reader. It periodically ingests RSS feeds into
SQLite, uses a network-local Ollama instance to classify articles by topic,
generate ~50-word summaries, and detect duplicates, and learns the user's
preferences from explicit 👍/👎 votes given at read time. A small Vue frontend
shows the most interesting unread articles by default, with interactive
filtering and sorting.

## Key decisions (and why)

1. **Language: Node.js (ESM, no TypeScript, no build step for the backend).**
   The user knows Node well; the frontend is Vue so the stack stays coherent;
   a working, maintainable product arrives faster. Go was the alternative
   ("language I'd like to learn") — rejected for v1 because a tool you rely on
   daily should be in the language you can fix quickly. A Go rewrite remains a
   good future learning project against the same SQLite schema and HTTP API.

2. **One executable, two modes.** `rssmart cron` fetches feeds, enriches new
   articles via Ollama, recomputes scores, and exits (intended for system
   cron). `rssmart serve` starts the HTTP server + frontend. Shared config and
   DB layer.

3. **SQLite via `better-sqlite3`.** Synchronous, fast, zero-config, the de
   facto standard. WAL mode so `cron` and `serve` can run concurrently.

4. **Duplicate detection via embeddings, not generative LLM.** Each article
   gets an embedding (Ollama `/api/embed`, default model `nomic-embed-text`)
   of title+summary. A new article whose cosine similarity to a recent
   article (last 14 days) exceeds a threshold (default 0.87) is marked
   `duplicate_of` that article. Cheap, deterministic, no prompt engineering.
   The UI hides duplicates by default with a toggle.

5. **Preference learning: transparent vote-based topic scoring, computed in
   SQL — no LLM in the loop.** Votes (+1/−1/0) attach to articles. A topic's
   preference is a Laplace-smoothed ratio over the votes of articles carrying
   that topic: `pref = (up + 1) / (up + down + 2) * 2 − 1` → range [−1, 1],
   0 = unknown. An article's interest score is the mean pref of its topics.
   This is inspectable, retrains "for free" on every vote, and needs no
   training jobs. An LLM-predicted per-article interest axis is explicitly
   deferred (YAGNI) — the schema leaves room (`articles.score` is computed,
   extra axes can be added as columns).

6. **Topic classification with a controlled-but-growable vocabulary.** The
   classify prompt shows Ollama the existing topic list and asks it to pick
   1–3, allowing at most one new topic when nothing fits. Keeps the taxonomy
   from exploding into hundreds of one-off tags (which would starve the
   preference model of signal).

7. **Ollama is remote and may be down.** All LLM work is a separate
   enrichment stage over `articles.status = 'pending'`. Ingest never blocks
   on the LLM; failures leave articles pending (retried next cron run,
   with a retry cap → `status = 'error'`). The app is fully usable without
   Ollama — articles simply lack topics/summaries and score 0.

8. **Frontend: Vue 3 vendored from npm, no bundler.** `vue.esm-browser.prod.js`
   copied from `node_modules` into `public/vendor/` at install time
   (postinstall script). One `index.html` + `app.js` + `style.css`. No Vite —
   YAGNI for a single-view app; nothing to break at build time.

## Architecture

```
bin/rssmart.js            CLI entry: parses mode + flags, dispatches
src/config.js             load + validate config.json (path via --config / RSSMART_CONFIG)
src/db.js                 open DB, schema migrations (user_version), WAL
src/ingest.js             fetch RSS feeds (rss-parser), upsert feeds/articles
src/llm.js                Ollama HTTP client: chat-JSON + embeddings, timeouts
src/enrich.js             pending articles → topics + summary + embedding + dup check
src/scoring.js            topic prefs + article scores (pure SQL, recompute fn)
src/server.js             express app: JSON API + static frontend
public/                   index.html, app.js, style.css, vendor/vue
config.example.json       feeds list, ollama {url, chatModel, embedModel}, tuning knobs
test/                     node:test suites (see Testing)
```

Data flow, cron mode:
`config feeds → ingest (insert new by guid/link) → enrich pending (classify+summarize+embed, dup-check) → recompute scores → exit (code 0; 1 if every feed failed)`

Data flow, serve mode:
`GET /api/articles ←→ SQLite (scores read from articles.score, recomputed on vote) ←→ Vue app; POST vote/read → update + recompute affected topic prefs`

## Data model (SQLite)

```sql
feeds(id PK, url UNIQUE, title, active DEFAULT 1, last_fetched_at, last_status)
articles(id PK, feed_id FK, guid, url, title, author, published_at,
         content,             -- raw description/content from RSS
         summary,             -- ~50-word LLM preview
         embedding BLOB,      -- Float32Array bytes
         status TEXT DEFAULT 'pending',  -- pending|enriched|error
         enrich_attempts INT DEFAULT 0,
         duplicate_of INT NULL FK articles.id,
         score REAL DEFAULT 0,
         vote INT DEFAULT 0,  -- -1|0|1
         read_at TEXT NULL,
         created_at TEXT,
         UNIQUE(feed_id, guid))
topics(id PK, name UNIQUE COLLATE NOCASE)
article_topics(article_id FK, topic_id FK, PK(article_id, topic_id))
```

Topic prefs are a SQL view/query, not a table (always consistent with votes).
`articles.score` is materialized for cheap sorting and recomputed after each
vote and each cron run.

## HTTP API

```
GET  /api/articles?view=interesting|unread|all&topic=&feed_id=&q=&sort=score|date&dupes=0|1&limit=&offset=
GET  /api/articles/:id                  full article (content included)
POST /api/articles/:id/vote  {vote}     -1|0|1 → recompute scores
POST /api/articles/:id/read  {read}     true|false
GET  /api/topics                        names + pref + article counts
GET  /api/feeds                         feeds + counts + last status
GET  /api/stats                         totals for header bar
```

`view=interesting` = unread, non-duplicate, sorted score DESC then
published_at DESC (the default landing view).

## Frontend behavior

Single page: header with view tabs (Interesting / Unread / All), topic chip
filter, feed filter, search box, sort selector, duplicates toggle. Article
cards show title (link, opens original in new tab), source + relative time,
topic chips with pref-tinted color, 50-word summary, 👍/👎 vote buttons, and
mark read/unread. Expanding a card shows full RSS content and marks it read.
Votes and reads are optimistic-updated, then the list refreshes scores.

## Error handling

- Feed fetch errors: recorded on `feeds.last_status`, never abort the run.
- Ollama unreachable/timeout/bad JSON: article stays `pending`,
  `enrich_attempts++`; after 5 attempts → `status='error'` (visible in UI as
  "unclassified"). One retry per cron run.
- Malformed RSS items (no guid+link+title): skipped, counted in run summary.
- API validation errors → 400 JSON; unknown id → 404.

## Testing

`node --test` with: in-memory/temp SQLite; a stub RSS HTTP server serving
fixture XML; a stub Ollama HTTP server (canned classify/summary JSON +
deterministic embeddings). Covers: ingest idempotency, enrichment pipeline
incl. failure/retry, dup detection math, scoring math (Laplace smoothing,
vote flips), and API endpoints end-to-end (supertest-style via fetch against
an ephemeral port). Frontend is exercised manually via `serve` (and the
webapp-testing skill for smoke verification).

## Deferred (recorded, not built)

- Non-RSS sources (the `feeds` table gets a `kind` column when needed).
- LLM-predicted interest axis, novelty-vs-replica LLM judgment beyond
  embedding dedup.
- Full-page article scraping (v1 uses RSS-provided content only).
- Feed management UI (v1: edit config.json; cron syncs it to the DB).
- Go rewrite.
