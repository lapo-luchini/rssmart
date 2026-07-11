# rssmart — design rationale and scaling notes

This is a living document: it records *why* things are built the way they
are, and where the known limits sit. If you change the architecture, change
this file — an outdated design doc misleads more than none (the original
day-one spec was retired for exactly that reason; it's in git history).

## Decisions and their reasons

- **Duplicate detection uses embeddings, not a generative prompt.** Cosine
  similarity of summary embeddings is cheap, deterministic, and needs no
  prompt engineering. The summary embedding is deliberately built from *our
  own* uniform-voice summary so that style differences between sources don't
  mask same-story matches.
- **A second, raw-text embedding exists for taste learning.** The dedup
  embedding is style-blind by design (see above), so the vote-similarity
  signal uses an embedding of the article's own text, which keeps register
  and genre.
- **No LLM in the preference loop.** Scores derive from votes at recompute
  time — Laplace-smoothed ratios and a kNN over voted articles. Transparent,
  inspectable (`/api/topics`, the score popover), retrains "for free" on
  every vote, no training jobs to babysit.
- **The LLM contributes classification, summaries and one scalar (depth).**
  Depth (1–5, substance and craft) exists because two articles on the same
  topic can be a deep analysis or a churned rehash — a distinction votes on
  topics can't express. It's a per-article judgment of the text itself, so
  it *is* an LLM job, unlike preference.
- **duplicate_of always points to a group root.** Groups stay single-level,
  which makes bundling a window function instead of a graph traversal.
  Re-enrichment used to create cycles (A↔B) that made both articles
  invisible; `repairDuplicateGroups` in `src/db.js` normalizes legacy data
  and is idempotent.
- **Scheduling lives where the state is.** `serve` runs an internal
  scheduler: adaptive per-feed cadence (a feed is checked about as often as
  it publishes, clamped to `scheduler.minIntervalMin`/`maxIntervalMin`) and
  a continuous classification loop. A fixed system crontab can't use any of
  that. `cron` mode stays for one-shots (backfills, debugging) and defers to
  a live scheduler via the enrichment lease in the `meta` table.
- **Classification is newest-first, reclassifications first of all.** A deep
  backlog must not make today's articles stale; explicit reader requests
  jump the queue entirely (`enrich_priority`).
- **The embedding space is versioned.** Vectors from different models must
  never be compared, so the model that produced the stored vectors is
  recorded in `meta.embed_model`. Changing `ollama.embedModel` in the config
  is detected on the next run (cron or serve): all vectors are cleared and
  rebuilt by `reembedMissing` — embeddings only, no LLM classification, so
  ~2-3 articles/s. Legacy vectors with no record are treated as unknown
  space and rebuilt too. Duplicate marks made in the old space are kept:
  they were real matches when made, and re-deriving them is O(N²).
  Task prefixes (`ollama.embedPrefixes`, document/query) ride in the config
  because every retrieval model spells them differently (qwen3: plain
  documents + instructed queries; nomic v1.5: `search_document:` /
  `search_query:`). Current model: qwen3-embedding:0.6b (multilingual —
  half the feeds are Italian; nomic v1.5 was English-centric).
- **Semantic search (src/search.js) reuses the taste-learning embeddings,
  no vector index.** The query is embedded with the same model and the
  `query` task prefix, then ranked by brute-force cosine against
  `text_embedding` — the same math the vote kNN already does (see above),
  so it needed no sqlite-vec at this scale (~5k articles), just the
  qwen3-embedding switch that gave stored vectors real task prefixes.
  Only enriched articles are candidates; duplicate groups collapse to
  their best *textual* match, which can differ from the group's
  highest-*scoring* member picked in normal browsing. An unreachable
  Ollama surfaces as a 502 with a clear message rather than silently
  falling back to text search — searching by meaning and searching by
  literal words return different results, so a silent fallback would be
  misleading about what was actually searched.
- **The SQLite driver is chosen at runtime, not hardcoded.** `src/db.js`
  loads `bun:sqlite` under Bun and `better-sqlite3` under Node (`typeof Bun
  !== 'undefined'`, resolved once via a top-level dynamic import so
  `openDb()` itself stays synchronous — no call site elsewhere needed to
  change). The two APIs are close enough (prepare/get/all/run/transaction/
  exec, multi-statement exec, `RETURNING`, BLOB round-tripping via
  Buffer-compatible Uint8Array — all verified against a real Bun 1.3.14)
  that nothing outside db.js knows or cares which driver is loaded. Added
  2026-07-09 because bun:sqlite avoids compiling a native addon under Bun;
  verified against real Ollama, real feeds, and a live concurrent
  cron+serve stress test, not just the test suite. Two real driver
  differences it papers over: bun:sqlite has no `.pragma()` convenience
  method (`.prepare('PRAGMA ...').get()` works on both, except—) and
  better-sqlite3 itself throws on `.get()` for pragma forms it statically
  classifies as non-data-returning (`foreign_keys = ON`), so `pragma()`
  falls back to `.run()` on that specific error rather than guessing per
  pragma. `bun test` cannot run more than one `node:test`-based file per
  invocation ([oven-sh/bun#5090](https://github.com/oven-sh/bun/issues/5090));
  this project's suite still runs fine under Bun one file at a time, or
  under `node --test` (`pnpm test`) as usual either way.
- **`busy_timeout` is set explicitly, not left to the driver's default.**
  better-sqlite3 waits out lock contention by default; bun:sqlite does not
  — discovered as a real `SQLITE_BUSY` crash under genuine concurrent
  cron + serve writers against the live database, a scenario the
  enrichment lease already assumes is safe (WAL allows it; it just needs
  both connections to wait for each other rather than fail immediately).
  `openDb()` now sets `PRAGMA busy_timeout = 5000` unconditionally so both
  drivers behave the same way, rather than relying on an implicit default
  that turned out to differ.
- **Reader corrections are text, not weights.** Per-article notes
  (`enrich_note`, persistent) and the global classification guidelines
  (`meta` table) are shown to the LLM verbatim. Guidelines are directly
  editable, never auto-updated: text the reader owns stays auditable;
  an LLM silently rewriting its own instructions would drift.
- **"Interesting" defaults to a time-decayed "hot" sort, not pure score
  (2026-07-11).** Plain score-sort has no forgetting: an old article
  needs only a marginally higher score than everything published since
  to sit at #1 forever, and the corpus only grows. Confirmed live before
  fixing it — the top score-sorted result was over a year old. `hot`
  (`a.score - hotDecayPerDay * age_in_days`, computed at query time from
  `published_at` via SQLite's `julianday()`, no stored/stale column) is
  additive/linear rather than a Hacker-News-style power-law-over-age: our
  `score` is a signed preference strength in roughly [-1, 1], not a
  monotonically-growing raw vote count starting at 1, so a divisive decay
  doesn't translate the same way. Plain "by interest" and "by date"
  remain selectable; only "Interesting"'s default changed.
- **Triage mode (2026-07-11) attacks the sparsity problem by generating
  more votes, not by making the algorithm cleverer with fewer.** Only ~43
  votes exist across ~6000 articles; a smarter model trained on the same
  43 votes is a smaller win than 10x-ing the vote count. It's built
  entirely on the existing `/vote` and `/read` endpoints — no backend
  changes — as a client-only mode (`public/app.js`): fetch one batch of
  `view=unread&sort=date` (newest first, matching Unread's own default),
  step through it one card at a time, and once the batch is exhausted
  just re-fetch the same query at offset 0 — everything just processed
  is now `read`, so it naturally falls out and the "next batch" is
  whatever's now at the front, no offset bookkeeping needed. Skipping (no
  vote) still marks the article read, deliberately: a purpose-built
  triage *session* is an explicit "I reviewed this" action, unlike
  passive scrolling — this is a narrower, session-scoped exception to
  "only explicit votes train" (skip itself still isn't a training
  signal, it just clears the article from the unread queue).
- **Triage keybindings mirror physical key layout, not vote magnitude
  (revised 2026-07-11).** The original scheme put magnitude on two
  different axes (←/→ for ±1, ↑/↓ for WOW/never) with no consistent
  direction — reported as unintuitive. Now ↑/↓ are the normal-magnitude
  votes, PgUp/PgDn (physically further, a bigger reach) are their WOW/never
  extremes, and ←/→ are back/skip — no vote maps to left-right at all
  anymore. The `.triage-controls` CSS grid places six buttons in a
  matching cross shape (PgUp/PgDn outermost, back/skip flanking the middle
  two rows) so the layout doubles as a legend, not just an arbitrary
  button row.
- **Triage's full-article view is inline, not the reader overlay.**
  Reuses the same `GET /api/articles/:id/reader` endpoint the reader
  overlay uses (see above), but renders the result inside the triage card itself
  (below the vote row), not as a full-screen takeover — triage is
  explicitly about using screen space efficiently for rapid voting, so a
  modal would work against its own premise. Unlike the reader overlay,
  expanding does *not* mark the article read: previewing the full text
  ahead of a vote/skip shouldn't fast-track it out of the queue by itself
  (voting/skipping already does that, per the entry above). The expand
  state resets on advance/back/new-batch since it's a per-card, transient
  peek, not something that should carry across cards. A real "open
  original ↗" link sits next to the byline regardless of expand state,
  for the cases where the extraction isn't enough — same reasoning as the
  reader overlay's own escape hatch: an occasional, deliberate new-tab
  open doesn't reintroduce the wrong-tab-focus annoyance that motivated
  replacing the *default* open action with the overlay in the first
  place, since that annoyance scales with frequency of use, not existence.
- **In-page reader overlay (2026-07-11), not an iframe.** Opening an article
  in a new tab and closing it with Ctrl-W left the reader on whatever tab
  happened to be next, not the tab they came from — reported as a real
  annoyance. A literal `<iframe src="article-url">` was the first idea, but
  many sites refuse to be framed (`X-Frame-Options`/CSP `frame-ancestors`),
  so it'd fail unpredictably per-source. Instead, `GET
  /api/articles/:id/reader` (`getReaderContent` in `src/enrich.js`) serves
  our own extracted text: cached `full_content` if present, otherwise a
  live fetch of the origin page through the same `fetchArticleText` and
  "keep only if it beats the feed's own text" guard the enrichment pipeline
  already uses (avoids the same footer/nav-extraction failure mode), else
  the feed's own excerpt. A win from a live fetch is persisted into
  `full_content`, so later reads (and re-enrichment) get it for free. The
  overlay itself (`public/app.js` `openReader`/`closeReader`) is a plain
  boolean-gated full-screen div, not a hash route — closing it returns to
  whatever view/panel was already active (including mid-triage, on the
  same card) rather than navigating anywhere. "open original ↗" inside the
  overlay remains a real `target="_blank"` link for the cases where the
  live page is actually wanted.
- **Sans-serif for all reading content, not just the reader overlay.** The
  `--serif` CSS variable was removed outright (reader preference, stated
  directly, not scoped to one feature) — `.story-body`, `.story-summary`,
  `.triage-title/-summary` and the reader body all use `--sans`
  (`system-ui` etc.) now. No separate "reading" font stack was introduced:
  system-ui renders well at both UI-chrome and article-body sizes, so
  reusing one stack was simpler than maintaining two.

## How the cosine math actually runs

All in RAM, brute force, plain JS loops over `Float32Array`s. SQLite is
storage only — embeddings are BLOBs (768 × 4 bytes ≈ 3 KB, two per
article), there is no vector index (no sqlite-vec/vss).

Two paths, with very different scaling:

1. **Duplicate detection** (`enrichPending`): loads the summary embeddings
   of the last `dupWindowDays` (default 14) enriched articles once per run
   and compares each new article against that set. The window makes the
   cost roughly constant regardless of archive size. Never a bottleneck:
   one pass is a few million float ops (~ms) against ~10 s of LLM time.

2. **kNN vote scoring** (`recomputeScores`): loads *all* text embeddings
   and compares every article against every voted article —
   O(N articles × V votes × 768) — and runs on **every vote** plus after
   every classification batch. This is the path with a real ceiling.

## Known limits (as of ~5k articles, 2026-07)

- **The ceiling arrived much earlier than projected — measured 5.7s per
  vote at N≈6000/V=43 (2026-07-11), against an earlier ~1s-at-N=30k/V=300
  estimate — and the obvious first remediation (score only unread
  articles) turned out to be a dead end.** The app exists specifically
  because arrival outpaces reading; by design, unread articles are the
  overwhelming majority forever (measured same day: 5934/5972 = 99.4%
  unread, only 38 read). "Skip recompute for read articles" therefore
  barely shrinks N — it isn't a real fix, it just looked like one before
  checking the actual proportions. **Fixed instead by decoupling "confirm
  my vote" from "rescore the corpus"** (`src/scoring.js`,
  `recomputeOneScore` / `scheduleRecompute` / `recomputeIfDue`):
  - A vote updates *only its own article's* score synchronously —
    scoped queries (this article's topics, its feed, the — usually
    small — voted set), no full-corpus scan, genuinely cheap. The vote
    response is accurate and instant (measured 0.14s live, down from
    5.7s) because it never touches the other ~5900 articles.
  - The full-corpus ripple (a new vote can shift *any* article's kNN
    term, not just the voted one) is debounced: each vote pushes a due
    time (`meta.score_recompute_due_at`) `scoring.recomputeDebounceSec`
    (default 120s) into the future, so a whole voting session collapses
    into one recompute after you actually stop, not one per click.
  - The due time is a DB row, not a JS timer, so it survives a crash or
    restart with no extra code: whatever next checks it (the serve
    scheduler's own `scoreTick`, polling cheaply) just runs it
    immediately if it's overdue. Verified live: voted, killed the
    process before the debounce elapsed, restarted — the pending
    recompute fired on the very first tick and cleared its own marker.
  - `cron` and the scheduler's post-classification sweep already do an
    unconditional full `recomputeScores` for an unrelated reason (fresh
    depth/topics need scoring); either one also clears a pending
    debounce marker, since it's now moot.
  Retention (drop/archive old read-but-unvoted articles) is *also* not
  the fix it looked like, for the same reason: read articles are a small
  minority, so pruning them wouldn't shrink N either. The remaining
  ladder rungs (cache voted vectors instead of re-reading blobs each
  sweep; sqlite-vec/approximate NN if this ever gets truly huge) are
  about the debounced sweep's own cost, not urgent now that it no longer
  blocks anything a person is looking at.
- **Nothing prunes articles.** The archive grows forever (~6 KB of
  embeddings per article plus text). Fine for years at current intake;
  see retention above.
- **DB access is single-process-friendly.** WAL mode (either driver, see
  below); the enrichment lease (soft, TTL 90 s) prevents duplicated LLM
  work between a serve scheduler and cron runs, not corruption (which WAL
  already prevents). A tiny read-then-write race in the lease is accepted:
  worst case is briefly duplicated classification work.
- **Feed-content trust boundary.** Feed HTML is sanitized (scripts, event
  handlers, `javascript:` URLs stripped at every write path) and
  origin-page fetching refuses private/loopback targets (SSRF) unless
  `enrich.allowPrivateFetch` is set. Residual, accepted: DNS-rebinding
  TOCTOU on page fetches — firewall the process if that ever matters.
- **The topic vocabulary is unbounded.** It reached 283 by 2026-07-07 and
  only grows — nothing merges, retires, or caps it. Two knock-on costs: the
  Topics tab becomes less browsable, and the full topic list rides in every
  classification prompt, so it competes with the article text and the
  reader's guidelines/notes for the model's context window (see `num_ctx`
  sizing below — a large vocabulary no longer risks silent truncation, but
  the list itself keeps growing regardless). Deferred fix: cap what's shown
  to the model to, say, the ~100 most-used topics, letting rarely-assigned
  ones fade out of the *suggestion* list (they'd remain valid on articles
  already tagged with them — this only changes what the classifier is
  nudged toward, not stored data).
- **`num_ctx` must stay stable across requests, not just "large enough".**
  Changing `num_ctx` between calls makes Ollama reload the model — measured
  ~1.5s per change vs ~0.4s when unchanged, on this setup. `contextTokens`
  (src/enrich.js) therefore sizes it from `maxInputChars` (the configured
  worst-case content length, which `sampleText` caps every article to
  anyway) plus the real topic list/guidelines/note lengths, never from an
  article's actual, highly variable, length. An earlier version (fixed
  2026-07-07, same day as a first fix that sized `num_ctx` from a flat
  1000-token headroom the topic list alone had already exceeded) sized it
  from the real assembled prompt, which inadvertently made `num_ctx` change
  on nearly every article and paid the reload tax constantly. Any future
  change to the prompt must keep this invariant: base the size estimate on
  worst-case bounds, not on what happens to be in front of you this call.

## Deferred ideas

- Harden `sanitizeHtml` (`src/html.js`): it's a regex blocklist (strips
  `<script>/<style>/<iframe>/<object>/<embed>/<form>`, `on*` attributes,
  `javascript:` URLs), not a parser-based allowlist, so it's more exposed to
  malformed/nested-markup evasion than something like DOMPurify or
  `sanitize-html`. Flagged by an automated security review of the reader
  overlay's `v-html` binding (2026-07-11); not a new gap introduced by that
  feature — every `v-html` in the app (`a.content`, `readerHtml`) has always
  relied on this same write-time sanitization (`ingest.js`, `fetchpage.js`).
  Swapping in a real HTML-sanitizer library would be a codebase-wide change,
  not a one-file fix, which is why it's deferred rather than done inline.
- Non-RSS sources (the feeds table would grow a `kind` column).
- Bookmarkable filter state in the URL hash (tabs already have routes).
- "Promote this note to guidelines" one-click from a reclassify note.
- Direct topic chip editing (✕ on a wrong chip) — deterministic corrections
  without an LLM round-trip.
- An LLM-updated *draft* of guidelines proposed from accumulated notes,
  applied only on explicit reader approval.
