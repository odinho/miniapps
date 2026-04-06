/** Core types for immich-cull */

export interface Asset {
  id: string;
  path: string;
  filename: string;
  fileCreatedAt: Date;
  embedding: Float32Array;
  rating: number | null;
  isFavorite: boolean;
  duplicateId: string | null;
}

export interface GroupAsset {
  asset: Asset;
  rank: number | null;
  keep: boolean;
  reason: string | null;
}

export interface PhotoGroup {
  id: string;
  assets: GroupAsset[];
  bestAssetId: string | null;
  summary: string | null;
  confidence: number | null;
  timeSpanMinutes: number;
  avgDistance: number;
}

export interface ClusterConfig {
  /** Time window size in minutes for bucketing */
  bucketMinutes: number;
  /** Stride between buckets in minutes */
  bucketStride: number;
  /** Max cosine distance for a strong similarity edge */
  strongEdgeDistance: number;
  /** Max cosine distance for a near-burst edge (requires time proximity) */
  burstEdgeDistance: number;
  /** Max time delta in minutes for near-burst edges */
  burstTimeMinutes: number;
  /** Max group size before splitting */
  maxGroupSize: number;
  /** Min group size to keep */
  minGroupSize: number;
  /** Top K neighbors to consider per asset */
  topK: number;
}

export const DEFAULT_CLUSTER_CONFIG: ClusterConfig = {
  bucketMinutes: 60,
  bucketStride: 30,
  strongEdgeDistance: 0.18,
  burstEdgeDistance: 0.22,
  burstTimeMinutes: 5,
  maxGroupSize: 20,
  minGroupSize: 2,
  topK: 12,
};
