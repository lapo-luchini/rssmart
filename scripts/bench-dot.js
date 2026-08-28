import { readFileSync } from 'node:fs';

const DIMS = 512;
// Engine simd128 probe: minimal module (func (result v128) v128.const 0).
// body: [0 local decls][FD 0C v128.const][16 zero bytes][0B end] = 20 bytes
const simdProbe = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
  10, 22, 1, 20, 0, 253, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11,
]);
console.log(`engine: ${typeof Bun !== 'undefined' ? `Bun ${Bun.version}` : `Node ${process.version}`}, simd128 support: ${WebAssembly.validate(simdProbe)}`);
const shapes = [
  { n: 170, queries: 6200 },
  { n: 2000, queries: 4000 },
  { n: 8000, queries: 2000 },
];

function loadBatcher(path) {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(readFileSync(path)), {},
  );
  const { memory, alloc_f32, free_f32, dot_batch } = instance.exports;
  let candPtr, queryPtr, outPtr;
  return {
    build(candidates, dims) {
      const n = candidates.length;
      candPtr = alloc_f32(n * dims);
      queryPtr = alloc_f32(dims);
      outPtr = alloc_f32(n);
      const view = new Float32Array(memory.buffer, candPtr, n * dims);
      for (let i = 0; i < n; i++) view.set(candidates[i], i * dims);
      return {
        query(vec) {
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
    },
  };
}

function jsBaseline(candidates, dims) {
  return {
    query(vec) {
      const out = new Float32Array(candidates.length);
      let sink = 0;
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        let s = 0;
        for (let d = 0; d < dims; d++) s += vec[d] * c[d];
        out[i] = s;
        sink += s;
      }
      if (sink === Infinity) console.error('impossible');
      return out;
    },
  };
}

function makeData(n, dims, seed) {
  // Deterministic pseudo-random normalized vectors.
  let s = seed;
  const rand = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const vecs = [];
  for (let i = 0; i < n; i++) {
    const v = new Float32Array(dims);
    let norm = 0;
    for (let d = 0; d < dims; d++) { v[d] = rand() - 0.5; norm += v[d] * v[d]; }
    norm = Math.sqrt(norm);
    for (let d = 0; d < dims; d++) v[d] /= norm;
    vecs.push(v);
  }
  return vecs;
}

const kernels = {
  'wasm scalar (old)': loadBatcher('/tmp/cosine-scalar.wasm'),
  'wasm simd128 (new)': loadBatcher('wasm/cosine.wasm'),
};

// Correctness cross-check: simd vs scalar must agree to float32 rounding.
{
  const candidates = makeData(1000, DIMS, 42);
  const queries = makeData(50, DIMS, 7);
  const scalar = kernels['wasm scalar (old)'].build(candidates, DIMS);
  const simd = kernels['wasm simd128 (new)'].build(candidates, DIMS);
  let maxDev = 0;
  for (const q of queries) {
    const a = scalar.query(q);
    const b = simd.query(q);
    for (let i = 0; i < a.length; i++) maxDev = Math.max(maxDev, Math.abs(a[i] - b[i]));
  }
  scalar.free();
  simd.free();
  console.log(`simd vs scalar max deviation over 50x1000 dots: ${maxDev.toExponential(2)}`);
  if (maxDev > 1e-5) { console.error('DEVIATION TOO LARGE'); process.exit(1); }
}

const label = (ms) => `${(ms / 1000).toFixed(2)}s`;
for (const { n, queries } of shapes) {
  const candidates = makeData(n, DIMS, 123);
  const qs = makeData(queries, DIMS, 999);
  const rows = [];
  for (const [name, loader] of Object.entries(kernels)) {
    const b = loader.build(candidates, DIMS);
    for (let i = 0; i < 50; i++) b.query(qs[i]); // warmup
    const t0 = performance.now();
    for (let i = 0; i < queries; i++) b.query(qs[i]);
    const ms = performance.now() - t0;
    b.free();
    rows.push(`${name}: ${label(ms)}  (${(ms / queries).toFixed(1)}us/query, ${(ms / queries / n * 1e6).toFixed(1)}ns/pair)`);
  }
  const js = jsBaseline(candidates, DIMS);
  const jsSamples = Math.min(queries, 200);
  const jt0 = performance.now();
  for (let i = 0; i < jsSamples; i++) js.query(qs[i]);
  const jsPerUs = (performance.now() - jt0) / jsSamples * 1000; // us per query
  rows.push(`plain JS (sampled ${jsSamples}): ${(jsPerUs * queries / 1e6).toFixed(2)}s projected (${(jsPerUs * 1000 / n).toFixed(0)}ns/pair)`);
  console.log(`\nn=${n} voted, ${queries} queries, ${DIMS} dims\n  ${rows.join('\n  ')}`);
}
