// Experimental local vote smoother. This module is deliberately independent
// of the production scorer: no database, clock, models, state or learned weights.
export const KERNEL_DEFAULTS = Object.freeze({
  tau: .2, k: 15, exponent: 1, lambda: 1, halfLifeYears: 1.5,
});
export const KERNEL_YEAR_SECONDS = 365.25 * 86400;
export const KERNEL_NORM_SQUARED_TOLERANCE = .02;

export function kernelParameters(options = {}) {
  for (const key of Object.keys(options)) {
    if (!Object.hasOwn(KERNEL_DEFAULTS, key) && key !== 'now') throw new Error(`unknown kernel parameter ${key}`);
  }
  const p = { ...KERNEL_DEFAULTS, ...options };
  if (!Number.isFinite(p.now)) throw new Error('kernel now must be an explicit finite Unix time in seconds');
  if (!Number.isFinite(p.tau) || p.tau < -1 || p.tau >= 1) throw new Error('kernel tau must be in [-1, 1)');
  if (!Number.isSafeInteger(p.k) || p.k < 0) throw new Error('kernel k must be a nonnegative safe integer');
  if (!Number.isFinite(p.exponent) || p.exponent <= 0) throw new Error('kernel exponent must be positive');
  if (!Number.isFinite(p.lambda) || p.lambda <= 0) throw new Error('kernel lambda must be positive');
  if (p.halfLifeYears !== null && (!Number.isFinite(p.halfLifeYears) || p.halfLifeYears < 0)) {
    throw new Error('kernel halfLifeYears must be null or nonnegative');
  }
  return p;
}

export function validateKernelVector(vector, dimensions, label = 'vector') {
  if ((!Array.isArray(vector) && !ArrayBuffer.isView(vector)) || vector instanceof DataView
      || vector.length !== dimensions || !Number.isSafeInteger(dimensions) || dimensions < 1) {
    throw new Error(`${label}: embedding dimension mismatch`);
  }
  let normSquared = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error(`${label}: embedding contains a nonfinite value`);
    normSquared += value * value;
  }
  if (Math.abs(normSquared - 1) > KERNEL_NORM_SQUARED_TOLERANCE) {
    throw new Error(`${label}: embedding is not unit normalized (squared norm ${normSquared})`);
  }
}

function validateId(id, seen, label) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error(`${label}: invalid article id`);
  if (seen.has(id)) throw new Error(`${label}: duplicate article id ${id}`);
  seen.add(id);
}

/**
 * training: [{ id, vote: -2|-1|1|2, vector, voteTime, createdTime }]
 * candidates: [{ id, vector }]. Times are Unix seconds; null voteTime falls
 * back to createdTime. The caller provides one explicit `now` for the batch.
 *
 * Input order breaks similarity ties. Select top-k by clipped dot product
 * BEFORE decay, omit the candidate's own ID, then compute:
 *   w_i = max(0, (cos_i - tau)/(1 - tau)) ** exponent * decay_i
 *   score = sum(w_i * vote_i/2) / (lambda + sum(w_i))
 * This is one pooled neighborhood with a zero-valued prior of mass lambda.
 * Vector norms are checked, never silently repaired or renormalized.
 */
export function scoreKernel(training, candidates, options) {
  const p = kernelParameters(options);
  if (!Array.isArray(training) || !Array.isArray(candidates)) throw new Error('kernel inputs must be arrays');
  const dimensions = training[0]?.vector?.length ?? candidates[0]?.vector?.length;
  const trainingIds = new Set(), candidateIds = new Set();
  const neighbors = training.map((row, index) => {
    validateId(row.id, trainingIds, 'training');
    validateKernelVector(row.vector, dimensions, `training #${row.id}`);
    if (![-2, -1, 1, 2].includes(row.vote)) throw new Error(`training #${row.id}: expected a nonzero integer vote in [-2, 2]`);
    const time = row.voteTime ?? row.createdTime;
    if (!Number.isFinite(time)) throw new Error(`training #${row.id}: invalid vote/creation time`);
    const decay = p.halfLifeYears
      ? 2 ** (-Math.max(0, p.now - time) / (p.halfLifeYears * KERNEL_YEAR_SECONDS)) : 1;
    return { row, index, decay };
  });
  return candidates.map((candidate) => {
    validateId(candidate.id, candidateIds, 'candidate');
    validateKernelVector(candidate.vector, dimensions, `candidate #${candidate.id}`);
    const selected = [];
    for (const neighbor of neighbors) {
      if (neighbor.row.id === candidate.id) continue;
      let similarity = 0;
      for (let d = 0; d < dimensions; d++) similarity += candidate.vector[d] * neighbor.row.vector[d];
      similarity = Math.max(-1, Math.min(1, similarity));
      selected.push({ ...neighbor, similarity });
    }
    selected.sort((a, b) => b.similarity - a.similarity || a.index - b.index);
    selected.length = Math.min(p.k, selected.length);
    let mass = 0, squaredMass = 0, numerator = 0, positiveWeightNeighbors = 0;
    const contributions = selected.map(({ row, similarity, decay }) => {
      const kernelWeight = Math.max(0, (similarity - p.tau) / (1 - p.tau)) ** p.exponent;
      const weight = kernelWeight * decay;
      const normalizedVote = row.vote / 2;
      const numeratorContribution = weight * normalizedVote;
      mass += weight;
      squaredMass += weight * weight;
      numerator += numeratorContribution;
      if (weight > 0) positiveWeightNeighbors++;
      return { id: row.id, similarity, vote: row.vote, normalizedVote, kernelWeight, decay, weight, numeratorContribution };
    });
    const denominator = p.lambda + mass;
    for (const contribution of contributions) contribution.scoreContribution = contribution.numeratorContribution / denominator;
    // Rescale only for this diagnostic so squared weights do not underflow
    // when every vote is extremely old. This never changes scoring weights.
    const maxWeight = contributions.reduce((max, c) => Math.max(max, c.weight), 0);
    let scaledMass = 0, scaledSquares = 0;
    if (maxWeight > 0) for (const c of contributions) {
      const scaled = c.weight / maxWeight;
      scaledMass += scaled;
      scaledSquares += scaled * scaled;
    }
    return {
      id: candidate.id,
      score: numerator / denominator,
      support: {
        selectedNeighbors: selected.length, positiveWeightNeighbors,
        mass, squaredMass, effectiveNeighbors: scaledSquares > 0 ? scaledMass * scaledMass / scaledSquares : 0,
        priorMass: p.lambda, priorValue: 0,
        dataFraction: mass / denominator, priorFraction: p.lambda / denominator,
        maxSimilarity: selected[0]?.similarity ?? null,
      },
      contributions,
    };
  });
}
