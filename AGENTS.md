# AGENTS.md

Personal RSS reader: Ollama-classified articles with vote-based preference
learning. Node ≥24 (or Bun ≥1.3.13), SQLite, no bundler, no CI, no lint/
typecheck — `node --test` is the only automated gate.

## Commands

- `npm test` — full suite (node:test, in-memory SQLite). Single file:
  `node --test test/scoring.test.js`; single test: add
  `--test-name-pattern="..."`. There is no lint/typecheck/format config.
- `npm run serve` / `npm run cron` — the two runtime modes (bin/rssmart.js).
  Cron is silent on success (`-v` for progress) and defers enrichment to a
  live serve via a lease row in `meta` — don't add work that fights the lease.
- `npm run postinstall` — re-vendor Vue into `public/vendor/` after bumping
  the version in `scripts/vendor.js`. `public/app.js` imports the vendored
  ESM file directly; there is no bundler or build step for the frontend.
- Config resolves via `$RSSMART_CONFIG` or `./config.yaml` (gitignored).
  `validateConfig` requires the FULL schema — a minimal file crashes startup
  with "missing key" errors. Always start from `config.example.yaml`.
- Rebuild the WASM dot-product kernel after editing
  `wasm/cosine-src/src/lib.rs`: `cd wasm/cosine-src && cargo build --release
  --target wasm32-unknown-unknown` and copy the artifact to `wasm/cosine.wasm`
  (committed, dependency-free). It requires WASM simd128; `wasmDot.js`
  feature-checks and fails loud.

## Architecture (what filenames don't tell you)

- Two embedding columns per article with separate models (hybrid setup):
  `embedding` = title+summary, used for duplicate detection
  (`ollama.dedupEmbedModel`, qwen3-embedding@256 dims); `text_embedding` =
  title+text, used for taste kNN + semantic search (`ollama.embedModel`,
  harrier@512). Each column's model+dims is versioned in `meta`
  (`embed_model_text`/`embed_model_dedup`); switching a model clears only
  that column and `reembedMissing` rebuilds it progressively — embeddings
  only, no LLM classification, and only the missing column. Each column's
  document prefix and preprocessing/input contract are versioned too;
  legacy identities trigger a conservative rebuild. The dedup
  vector is only kept for articles inside the dedup window
  (`enrich.dupWindowDays`): dedup compares against recent articles
  exclusively, so syncRecentCache drops aged-out vectors from storage and
  reembedMissing deliberately does not refill them — don't "fix" that NULL.
- Scoring learns from votes. Votes, relevant feature changes and elapsed
  decay time can schedule score work. A vote recomputes only its own article
  (`recomputeOneScore`, synchronous in the request) and schedules a
  debounced full sweep (`recomputeIfDue` → `recomputeScores`), which is
  async/chunked (`yieldEveryMs`) to yield between chunks; preparation and an
  individual chunk can still block the event loop. Never call the full sweep
  synchronously from a request path; never
  make tests depend on real Ollama — use `startOllamaStub` from
  `test/helpers.js` (tests run on `tempDb()` in-memory DBs).
- `src/html.js`'s `stripHtml` is the single html→text chokepoint for all
  LLM prompts and embedding inputs (it emits `[image: alt]` markers for
  images). Feed HTML is parser-sanitized with an allowlist at write paths
  and final article/reader rendering boundaries (`sanitizeHtml`). Keep both
  boundaries, including when handling legacy content or new transformations.
- `data/rssmart.db` is a snapshot of real production data used for local
  benchmarks (`scripts/bench-embed.js`, `bench-model.js`,
  `bench-comic-alt.js` — use `openReadOnlyDb`, which requires an existing
  database with the current schema; migrate only a copy of older snapshots.
  Reports land in `data/`;
  `bench-dot.js` is the standalone kernel benchmark, no DB involved).
  Don't write to it from experiments; copy it first.
- `scripts/repair-dedup.js` inspects connected components within stored
  groups, readonly by default. `--fix` splits only complete, compatible,
  disconnected groups without immediately reattaching them. Incomplete or
  incompatible groups remain unmeasurable; connectivity is not a semantic
  event label. Inspect after a model/dims mismatch, then review before repair.
- Vote/read intents share durable per-article sequences and server receipts.
  Persist before sending, retain ambiguous failures and preserve every FIFO
  operation. Never reset sequences or discard rejected entries automatically.
  The v3 outbox has its own storage key; legacy divergence pauses synchronization.
  Close old tabs before upgrading; preserve and reconcile both storage keys
  before rollback, since legacy entries may already have been replayed.

## Docs

- `README.md` is for a user deciding to run the project: what it is, what
  it does, setup, config keys, runtime modes, the web UI. Keep it
  user-facing — no implementation internals (runtime selection, storage
  formats, rebuild steps, driver quirks); those belong in `DESIGN.md`.
- `DESIGN.md` is the authoritative, dated design log: architecture
  rationale, measurements, internal mechanics, known limits. When you
  change a hot path or make a measured tradeoff, add an entry there
  instead of prose elsewhere.

## Traps

- SQLite runs under two drivers: better-sqlite3 (Node) and bun:sqlite (Bun).
  They disagree on named-parameter binding — use positional `?` placeholders
  everywhere (see the long comment in test/api.test.js's seed).
- Embeddings are stored as `Float16Array` (why Node ≥24 is required).
- Votes are integers -2..+2 with UI escalation (▲ → ▲▲ → clear). Duplicate
  decisions in `articles.duplicate_of` point to group roots and are never
  re-derived after being made (re-deriving is O(N²));
  `repairDuplicateGroups` normalizes legacy data.
- Both `npm test` (Node) and `bun test` are green. If a Bun-only failure
  shows up, check bun:sqlite vs better-sqlite3 differences first — e.g.
  bun:sqlite lacks the `dbstat` virtual table (metrics.js degrades
  gracefully, test/metrics.test.js is runtime-conditional), and Bun's
  `process.version` masquerades as a Node version.
