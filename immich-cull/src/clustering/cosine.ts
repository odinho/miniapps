/** Fast cosine distance between two Float32Arrays. Returns 0..2 (0 = identical). */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 2;
  return 1 - dot / denom;
}

/**
 * Find top-K nearest neighbors by cosine distance within a set of assets.
 * Returns indices and distances sorted by distance ascending.
 */
export function topKNeighbors(
  queryEmbedding: Float32Array,
  candidates: Float32Array[],
  k: number,
  excludeIndex: number,
): Array<{ index: number; distance: number }> {
  const scored: Array<{ index: number; distance: number }> = [];

  for (let i = 0; i < candidates.length; i++) {
    if (i === excludeIndex) continue;
    scored.push({ index: i, distance: cosineDistance(queryEmbedding, candidates[i]) });
  }

  scored.sort((a, b) => a.distance - b.distance);
  return scored.slice(0, k);
}
