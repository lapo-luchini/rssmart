import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KERNEL_DEFAULTS, KERNEL_YEAR_SECONDS, kernelParameters, scoreKernel } from '../src/kernelScore.js';

const now = 1800000000;
const vec = (similarity) => [similarity, Math.sqrt(1 - similarity * similarity)];
const row = (id, vote, similarity, extra = {}) => ({ id, vote, vector: vec(similarity), voteTime: now, createdTime: now, ...extra });
const candidate = (id = 100) => ({ id, vector: [1, 0] });
const score = (training, parameters = {}, item = candidate()) => scoreKernel(training, [item], { now, tau: 0, k: 30, lambda: .5, halfLifeYears: 0, ...parameters })[0];
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('frozen defaults and explicit time keep the pure kernel reproducible', () => {
  assert.deepEqual(KERNEL_DEFAULTS, { tau: .2, k: 15, exponent: 1, lambda: 1, halfLifeYears: 1.5 });
  assert.ok(Object.isFrozen(KERNEL_DEFAULTS));
  assert.throws(() => scoreKernel([], [], {}), /explicit finite Unix time/);
  assert.deepEqual(scoreKernel([], [], { now }), []);
});

test('a nearby positive and remote negative do not cancel as separately normalized signs do', () => {
  close(score([row(1, 1, .9), row(2, -1, .1)]).score, 4 / 15);
  close(score([row(1, -1, .9), row(2, 1, .1)]).score, -4 / 15);
});

test('counterexample: many moderately similar positives can dilute a very close negative', () => {
  const training = [row(1, -1, 1), ...Array.from({ length: 20 }, (_, i) => row(i + 2, 1, .6))];
  const result = score(training, { k: 21 });
  close(result.score, 11 / 27);
  assert.equal(result.contributions[0].id, 1);
  assert.ok(result.contributions[0].scoreContribution < 0);
});

test('zero support and conflicting supported votes have different diagnostics despite the same score', () => {
  const unsupported = score([row(1, 2, 0), row(2, -2, -1)], { tau: .2 });
  const conflicted = score([row(1, 2, 1), row(2, -2, 1)]);
  assert.equal(unsupported.score, 0); assert.equal(conflicted.score, 0);
  assert.equal(unsupported.support.mass, 0); assert.equal(unsupported.support.effectiveNeighbors, 0);
  assert.equal(conflicted.support.mass, 2); assert.equal(conflicted.support.effectiveNeighbors, 2);
});

test('threshold, exponent, vote/2 and decay combine before shrinkage', () => {
  const result = score([row(1, 1, .6, { voteTime: now - KERNEL_YEAR_SECONDS })], {
    tau: .2, exponent: 2, lambda: 1, halfLifeYears: 1,
  });
  close(result.contributions[0].kernelWeight, .25);
  close(result.contributions[0].decay, .5);
  close(result.support.mass, .125);
  close(result.score, 1 / 18);
});

test('decay falls back to creation time, clips future age and can be disabled', () => {
  const past = row(1, 2, 1, { voteTime: null, createdTime: now - KERNEL_YEAR_SECONDS });
  close(score([past], { lambda: 1, halfLifeYears: 1 }).score, 1 / 3);
  close(score([past], { lambda: 1, halfLifeYears: null }).score, .5);
  close(score([row(2, 2, 1, { voteTime: now + KERNEL_YEAR_SECONDS })], { lambda: 1, halfLifeYears: 1 }).score, .5);
});

test('top-k is chosen by similarity before decay, not by the final weight', () => {
  const result = score([row(1, -2, 1, { voteTime: now - 10 * KERNEL_YEAR_SECONDS }), row(2, 2, .9)], {
    k: 1, lambda: 1, halfLifeYears: 1,
  });
  assert.deepEqual(result.contributions.map((r) => r.id), [1]);
  close(result.score, -1 / 1025);
});

test('self is excluded before selecting neighbors even if its own vote is strongest', () => {
  const result = score([row(1, 2, 1), row(2, -2, .5)], { k: 1, lambda: 1 }, candidate(1));
  assert.deepEqual(result.contributions.map((r) => r.id), [2]);
  close(result.score, -1 / 3);
  assert.equal(score([row(1, 2, 1)], {}, candidate(1)).score, 0);
});

test('equal similarities preserve training input order for a top-k boundary tie', () => {
  const training = [row(2, -2, .8), row(1, 2, .8)];
  assert.equal(score(training, { k: 1 }).contributions[0].id, 2);
  assert.equal(score([...training].reverse(), { k: 1 }).contributions[0].id, 1);
});

test('increasing the zero prior shrinks scores without changing evidence', () => {
  const a = score([row(1, 2, 1)], { lambda: 1 });
  const b = score([row(1, 2, 1)], { lambda: 3 });
  close(a.score, .5); close(b.score, .25);
  assert.equal(a.support.mass, b.support.mass);
  close(b.support.dataFraction + b.support.priorFraction, 1);
  assert.equal(b.support.priorValue, 0);
});

test('effective neighbor count reflects concentration and contributions sum to the score', () => {
  const result = score([row(1, 2, 1), row(2, -2, .25)], { lambda: 1 });
  close(result.support.mass, 1.25); close(result.support.squaredMass, 17 / 16);
  close(result.support.effectiveNeighbors, 25 / 17);
  close(result.contributions.reduce((sum, r) => sum + r.scoreContribution, 0), result.score);
  close(result.score, 1 / 3);
});

test('effective count remains finite with tiny old weights and does not imply substantial mass', () => {
  const time = now - 1000 * KERNEL_YEAR_SECONDS;
  const result = score([row(1, 1, 1, { voteTime: time }), row(2, 1, 1, { voteTime: time })], { halfLifeYears: 1 });
  assert.equal(result.support.effectiveNeighbors, 2);
  assert.ok(result.support.mass > 0 && result.support.mass < 1e-300);
});

test('zero k, empty training, negative similarities and threshold equality have zero evidence', () => {
  for (const result of [score([], {}), score([row(1, 2, 1)], { k: 0 }), score([row(1, 2, -.2)]), score([row(1, 2, .2)], { tau: .2 })]) {
    assert.equal(result.score, 0); assert.equal(result.support.mass, 0);
    assert.equal(result.support.priorFraction, 1);
  }
});

test('float16 norm tolerance permits small rounding error and dot products are clipped', () => {
  const result = score([row(1, 2, 1)], { lambda: 1 }, { id: 100, vector: [1.004, 0] });
  assert.equal(result.contributions[0].similarity, 1); assert.equal(result.score, .5);
});

test('wrong dimensions, zero/nonunit norms and nonfinite values stop scoring', () => {
  for (const vector of [[1, 0, 0], [0, 0], [2, 0], [NaN, 0], [Infinity, 0]]) {
    assert.throws(() => score([row(1, 2, 1)], {}, { id: 100, vector }), /embedding/);
  }
});

test('invalid labels, times, duplicate IDs and unsafe IDs stop scoring', () => {
  for (const vote of [0, 3, 1.5, NaN]) assert.throws(() => score([row(1, vote, 1)]), /vote/);
  assert.throws(() => score([row(1, 1, 1, { voteTime: null, createdTime: NaN })]), /time/);
  assert.throws(() => score([row(1, 1, 1), row(1, -1, 0)]), /duplicate article id/);
  assert.throws(() => score([row(Number.MAX_SAFE_INTEGER + 1, 1, 1)]), /invalid article id/);
  assert.throws(() => scoreKernel([], [candidate(), candidate()], { now }), /duplicate article id/);
});

test('invalid parameters are rejected instead of silently changing the experiment', () => {
  for (const override of [{ tau: 1 }, { tau: -1.1 }, { k: -1 }, { k: 1.5 }, { exponent: 0 }, { lambda: 0 }, { lambda: Infinity }, { halfLifeYears: -1 }, { p: 2 }]) {
    assert.throws(() => kernelParameters({ now, ...override }), /kernel/);
  }
});

test('batch scoring preserves candidate order and never mutates caller vectors or rows', () => {
  const training = [row(1, 2, 1), row(2, -1, .5)], candidates = [candidate(4), { id: 3, vector: [0, 1] }];
  const before = structuredClone({ training, candidates });
  const results = scoreKernel(training, candidates, { now });
  assert.deepEqual(results.map((r) => r.id), [4, 3]);
  assert.deepEqual({ training, candidates }, before);
  assert.ok(results.every((r) => r.score >= -1 && r.score <= 1));
});
