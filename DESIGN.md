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
- **Reader corrections are text, not weights.** Per-article notes
  (`enrich_note`, persistent) and the global classification guidelines
  (`meta` table) are shown to the LLM verbatim. Guidelines are directly
  editable, never auto-updated: text the reader owns stays auditable;
  an LLM silently rewriting its own instructions would drift.

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

- **Soft ceiling: kNN scoring**, around tens of thousands of articles ×
  hundreds of votes. At N=30k, V=300 a recompute is ~7G float ops (~1 s of
  JS CPU) and loads ~90 MB of embeddings; since voting triggers it
  synchronously, the symptom will be *lag on the vote buttons*. At current
  size it's milliseconds. Remediation ladder, in order of effort:
  1. compute the kNN term only for unread articles (cost becomes
     proportional to the unread set, not the archive);
  2. cache voted vectors between recomputes;
  3. retention policy: drop/archive read, unvoted articles older than N
     months (voted articles must stay — they are the training data);
  4. only if truly huge: sqlite-vec / approximate NN.
  Deliberately not done yet: the brute-force version is correct and
  measurable, and the system's charm is being inspectable. Act when a vote
  feels slow, not before.
- **Nothing prunes articles.** The archive grows forever (~6 KB of
  embeddings per article plus text). Fine for years at current intake;
  see retention above.
- **DB access is single-process-friendly.** better-sqlite3 + WAL; the
  enrichment lease (soft, TTL 90 s) prevents duplicated LLM work between a
  serve scheduler and cron runs, not corruption (which WAL already
  prevents). A tiny read-then-write race in the lease is accepted: worst
  case is briefly duplicated classification work.
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

- Non-RSS sources (the feeds table would grow a `kind` column).
- Bookmarkable filter state in the URL hash (tabs already have routes).
- "Promote this note to guidelines" one-click from a reclassify note.
- Direct topic chip editing (✕ on a wrong chip) — deterministic corrections
  without an LLM round-trip.
- An LLM-updated *draft* of guidelines proposed from accumulated notes,
  applied only on explicit reader approval.
- Semantic search: embed the query (same model), cosine against the stored
  text_embeddings, top-k — the same math as the vote kNN, so no sqlite-vec
  needed until the same ~100k-article horizon. Caveat: nomic-embed-text
  wants asymmetric prefixes (`search_document:` / `search_query:`); stored
  embeddings are unprefixed, so proper quality needs a one-off re-embed
  pass. Fall back to LIKE when Ollama is down.
