import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDotBatcher } from '../src/wasmDot.js';

test('createDotBatcher computes dot products matching plain-JS cosine on unit vectors', () => {
  const dims = 4;
  const candidates = [
    Float32Array.of(1, 0, 0, 0),
    Float32Array.of(0, 1, 0, 0),
    Float32Array.of(Math.SQRT1_2, Math.SQRT1_2, 0, 0),
    Float32Array.of(-1, 0, 0, 0),
  ];
  const batcher = createDotBatcher(candidates, dims);
  try {
    const sims = batcher.query(Float32Array.of(1, 0, 0, 0));
    assert.equal(sims.length, 4);
    assert.ok(Math.abs(sims[0] - 1) < 1e-6, 'identical vector -> dot 1');
    assert.ok(Math.abs(sims[1] - 0) < 1e-6, 'orthogonal vector -> dot 0');
    assert.ok(Math.abs(sims[2] - Math.SQRT1_2) < 1e-6, '45 degrees -> dot cos(45deg)');
    assert.ok(Math.abs(sims[3] - -1) < 1e-6, 'opposite vector -> dot -1');
  } finally {
    batcher.free();
  }
});

test('createDotBatcher accepts Float16Array candidates and queries (production storage format)', () => {
  const dims = 3;
  const candidates = [Float16Array.of(1, 0, 0), Float16Array.of(0, 0, 1)];
  const batcher = createDotBatcher(candidates, dims);
  try {
    const sims = batcher.query(Float16Array.of(0, 0, 1));
    assert.ok(Math.abs(sims[0] - 0) < 1e-3);
    assert.ok(Math.abs(sims[1] - 1) < 1e-3);
  } finally {
    batcher.free();
  }
});

test('multiple sequential queries against the same batcher each reflect only their own query vector', () => {
  const dims = 2;
  const candidates = [Float32Array.of(1, 0), Float32Array.of(0, 1)];
  const batcher = createDotBatcher(candidates, dims);
  try {
    const a = batcher.query(Float32Array.of(1, 0));
    assert.ok(Math.abs(a[0] - 1) < 1e-6);
    assert.ok(Math.abs(a[1] - 0) < 1e-6);

    const b = batcher.query(Float32Array.of(0, 1));
    assert.ok(Math.abs(b[0] - 0) < 1e-6);
    assert.ok(Math.abs(b[1] - 1) < 1e-6);
  } finally {
    batcher.free();
  }
});

test('multiple independent batchers coexist without corrupting each other (mid-sweep vote scenario)', () => {
  const sweepBatcher = createDotBatcher(
    [Float32Array.of(1, 0), Float32Array.of(0, 1)], 2,
  );
  try {
    const sweepResult1 = sweepBatcher.query(Float32Array.of(1, 0));
    assert.ok(Math.abs(sweepResult1[0] - 1) < 1e-6);

    // A second, independent batcher (mirroring recomputeOneScore firing
    // while a recomputeScores sweep is paused between chunks) must not
    // disturb the first batcher's own buffers.
    const oneOffBatcher = createDotBatcher([Float32Array.of(0.6, 0.8)], 2);
    const oneOffResult = oneOffBatcher.query(Float32Array.of(1, 0));
    assert.ok(Math.abs(oneOffResult[0] - 0.6) < 1e-6);
    oneOffBatcher.free();

    const sweepResult2 = sweepBatcher.query(Float32Array.of(0, 1));
    assert.ok(Math.abs(sweepResult2[0] - 0) < 1e-6);
    assert.ok(Math.abs(sweepResult2[1] - 1) < 1e-6, 'sweep batcher unaffected by the one-off batcher');
  } finally {
    sweepBatcher.free();
  }
});

test('a mismatched-dims candidate is rejected at construction, not silently corrupted', () => {
  assert.throws(
    () => createDotBatcher([Float32Array.of(1, 0), Float32Array.of(1, 0, 0)], 2),
    /3 dims, expected 2/,
  );
});

test('a mismatched-dims query vector is rejected, not silently read/written out of bounds', () => {
  const batcher = createDotBatcher([Float32Array.of(1, 0)], 2);
  try {
    assert.throws(
      () => batcher.query(Float32Array.of(1, 0, 0)),
      /3 dims, expected 2/,
    );
  } finally {
    batcher.free();
  }
});
