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
#[no_mangle]
pub unsafe extern "C" fn dot_batch(
    query: *const f32,
    candidates: *const f32,
    dims: usize,
    n: usize,
    out: *mut f32,
) {
    let query = std::slice::from_raw_parts(query, dims);
    for i in 0..n {
        let row = std::slice::from_raw_parts(candidates.add(i * dims), dims);
        let mut sum = 0.0f32;
        for d in 0..dims {
            sum += query[d] * row[d];
        }
        *out.add(i) = sum;
    }
}
