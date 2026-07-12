import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Batched dot product (= cosine similarity, since every vector this project
// stores is verified L2-normalized - see enrich.js's cosine()) of one query
// against many candidates, computed in WASM: one JS<->WASM boundary
// crossing per query instead of one per candidate pair, and no per-element
// Float16->float conversion in a JS loop. Measured live against the real
// shape of scoring.js's kNN pass (a query per article, ~170-8000
// candidates, 512 dims): ~9-10x faster than plain JS on Node, ~46-51x on
// Bun (JSC's Float16Array element access is dramatically worse-optimized
// than V8's) - see DESIGN.md. `wasm/cosine-src` is the Rust source;
// `wasm/cosine.wasm` is the committed, portable, prebuilt artifact this
// loads - no Rust toolchain needed to run the app, only to rebuild it.
const wasmPath = fileURLToPath(new URL('../wasm/cosine.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {});
const { memory, alloc_f32, free_f32, dot_batch } = instance.exports;

/**
 * Prepare a batch of candidate vectors once, then run many single-query
 * dot-product searches against them cheaply. Mirrors how scoring.js uses
 * it: build once per full recompute sweep from the (rarely-changing within
 * one sweep) voted set, then `.query()` once per article being scored.
 *
 * `candidates`: array of same-length Float16Array or Float32Array vectors.
 * `dims`: vector length (all candidates and every query must match it).
 *
 * `.query(vec)` returns a Float32Array of length candidates.length, one
 * dot product per candidate in the same order - a *live view* into WASM
 * memory, valid only until the next `.query()` call or `.free()`; the
 * caller (knnScore) consumes it immediately, so this avoids a copy on the
 * hot path.
 *
 * `.free()` releases the WASM-side buffers; call it exactly once when done
 * (recomputeScores/recomputeOneScore do this in a finally block).
 */
export function createDotBatcher(candidates, dims) {
  const n = candidates.length;
  for (const c of candidates) {
    if (c.length !== dims) {
      throw new Error(`createDotBatcher: candidate vector has ${c.length} dims, expected ${dims}`);
    }
  }
  const candPtr = alloc_f32(n * dims);
  const queryPtr = alloc_f32(dims);
  const outPtr = alloc_f32(n);

  const candView = new Float32Array(memory.buffer, candPtr, n * dims);
  for (let i = 0; i < n; i++) candView.set(candidates[i], i * dims);

  return {
    query(vec) {
      // WASM does no bounds checking on the raw pointer arithmetic below -
      // a length mismatch here wouldn't cleanly return a wrong answer (the
      // way the old cosine()'s `a.length !== b.length` guard did), it
      // would silently read/write past the query buffer into whatever
      // WASM memory follows it. Cheap enough to check every call, and the
      // failure mode it prevents is memory corruption, not just a bad
      // score - worth it even though a mismatch should never actually
      // happen (every stored embedding is the current embedding space's
      // dimension by construction; see syncEmbeddingSpace in enrich.js).
      if (vec.length !== dims) {
        throw new Error(`createDotBatcher: query vector has ${vec.length} dims, expected ${dims}`);
      }
      // memory.buffer can be a new ArrayBuffer if WASM memory grew since
      // the last call (e.g. from a concurrent batcher's own allocation) -
      // re-view fresh every time rather than caching a view across calls.
      new Float32Array(memory.buffer, queryPtr, dims).set(vec);
      dot_batch(queryPtr, candPtr, dims, n, outPtr);
      return new Float32Array(memory.buffer, outPtr, n);
    },
    free() {
      free_f32(candPtr, n * dims);
      free_f32(queryPtr, dims);
      free_f32(outPtr, n);
    },
  };
}
