use core::arch::wasm32::{
    f32x4_add, f32x4_extract_lane, f32x4_mul, f32x4_splat, v128, v128_load,
};
use std::alloc::{alloc, dealloc, Layout};

#[no_mangle]
pub extern "C" fn alloc_f32(len: usize) -> *mut f32 {
    let layout = Layout::array::<f32>(len).unwrap();
    unsafe { alloc(layout) as *mut f32 }
}

#[no_mangle]
pub extern "C" fn free_f32(ptr: *mut f32, len: usize) {
    let layout = Layout::array::<f32>(len).unwrap();
    unsafe { dealloc(ptr as *mut u8, layout) }
}

/// Compute dot(query, candidates[i]) for every i in 0..n in one call - the
/// whole point being a single JS<->WASM boundary crossing per *query*, not
/// per candidate pair. Vectors are assumed pre-normalized (verified true for
/// this project's stored embeddings - see enrich.js's cosine()), so dot
/// product IS cosine similarity; no norm/sqrt/divide needed here either.
///
/// query: dims f32s. candidates: n*dims f32s, row-major flattened.
/// out: n f32s, one dot product per candidate row.
///
/// SIMD kernel (fixed-width simd128, supported by every engine this project
/// targets - Node >= 16.4 on V8, Bun/Safari >= 16.4 on JSC): 4-wide f32
/// multiply-add, unrolled 4x (16 floats per iteration) into separate
/// accumulators to hide lane latency, then a horizontal reduction, then a
/// scalar tail for dims % 4. Works for any dims (including dims < 4); v128
/// loads have no alignment requirement in wasm. Accumulation order differs
/// from a scalar loop (per-lane sums reduced at the end), so results sit in
/// the same float32 rounding class but aren't bit-identical to the old
/// scalar kernel - same magnitude of deviation the WASM port itself
/// introduced vs float64 JS (measured there: max 7.7e-08).
#[target_feature(enable = "simd128")]
#[no_mangle]
pub unsafe extern "C" fn dot_batch(
    query: *const f32,
    candidates: *const f32,
    dims: usize,
    n: usize,
    out: *mut f32,
) {
    let simd_end = dims & !15; // 16-float chunks: 4x unrolled f32x4
    let vec_end = dims & !3; // remaining 4-float chunks
    for i in 0..n {
        let row = candidates.add(i * dims);
        let mut qp = query;
        let mut rp = row;
        let (mut a0, mut a1, mut a2, mut a3) = (
            f32x4_splat(0.0),
            f32x4_splat(0.0),
            f32x4_splat(0.0),
            f32x4_splat(0.0),
        );
        while qp < query.add(simd_end) {
            a0 = f32x4_add(a0, f32x4_mul(v128_load(qp as *const v128), v128_load(rp as *const v128)));
            a1 = f32x4_add(a1, f32x4_mul(v128_load(qp.add(4) as *const v128), v128_load(rp.add(4) as *const v128)));
            a2 = f32x4_add(a2, f32x4_mul(v128_load(qp.add(8) as *const v128), v128_load(rp.add(8) as *const v128)));
            a3 = f32x4_add(a3, f32x4_mul(v128_load(qp.add(12) as *const v128), v128_load(rp.add(12) as *const v128)));
            qp = qp.add(16);
            rp = rp.add(16);
        }
        while qp < query.add(vec_end) {
            a0 = f32x4_add(a0, f32x4_mul(v128_load(qp as *const v128), v128_load(rp as *const v128)));
            qp = qp.add(4);
            rp = rp.add(4);
        }
        a0 = f32x4_add(a0, a1);
        a0 = f32x4_add(a0, a2);
        a0 = f32x4_add(a0, a3);
        let mut sum = f32x4_extract_lane::<0>(a0)
            + f32x4_extract_lane::<1>(a0)
            + f32x4_extract_lane::<2>(a0)
            + f32x4_extract_lane::<3>(a0);
        while qp < query.add(dims) {
            sum += *qp * *rp;
            qp = qp.add(1);
            rp = rp.add(1);
        }
        *out.add(i) = sum;
    }
}
