// Pure vector helpers shared by the browser recommender and server tests.

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i++) {
    const va = a[i] || 0;
    const vb = b[i] || 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

/** Map cosine [-1, 1] onto [0, 1] so it can be blended with normalized scores. */
export function normalizedCosine(a: readonly number[], b: readonly number[]): number {
  return Math.max(0, Math.min(1, (cosineSimilarity(a, b) + 1) / 2));
}

export function normalizeVector(vector: readonly number[]): number[] {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm === 0) return new Array(vector.length).fill(0);
  return vector.map((value) => (Number.isFinite(value) ? value / norm : 0));
}

export interface WeightedVectorSource {
  vector: readonly number[];
  weight: number;
}

/**
 * Weighted mean of the source embeddings, then L2-normalized. Sources with a
 * different dimension or a non-positive weight are ignored rather than
 * corrupting the profile.
 */
export function weightedMeanVector(sources: readonly WeightedVectorSource[], dim: number): number[] | null {
  if (!Number.isInteger(dim) || dim < 1) return null;
  const accumulator = new Array<number>(dim).fill(0);
  let totalWeight = 0;
  for (const source of sources) {
    const weight = Number(source.weight);
    if (!Number.isFinite(weight) || weight <= 0 || source.vector.length !== dim) continue;
    for (let i = 0; i < dim; i++) {
      const value = Number(source.vector[i]);
      if (Number.isFinite(value)) accumulator[i] += value * weight;
    }
    totalWeight += weight;
  }
  if (totalWeight <= 0) return null;
  for (let i = 0; i < dim; i++) accumulator[i] /= totalWeight;
  return normalizeVector(accumulator);
}
