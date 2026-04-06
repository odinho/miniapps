/**
 * Time-constrained similarity graph clustering engine.
 *
 * Algorithm:
 * 1. Sort assets by time, create overlapping time buckets
 * 2. Within each bucket, find top-K neighbors per asset using cosine distance
 * 3. Add edges: strong (distance ≤ threshold) or near-burst (distance ≤ burst threshold + time proximity)
 * 4. Find connected components via Union-Find
 * 5. Split mega-groups by temporal gaps
 */
import { Asset, ClusterConfig, DEFAULT_CLUSTER_CONFIG, PhotoGroup, GroupAsset } from "../shared/types.js";
import { cosineDistance, topKNeighbors } from "./cosine.js";
import { UnionFind } from "./union-find.js";

export interface ClusterStats {
  totalAssets: number;
  assetsWithEmbeddings: number;
  totalGroups: number;
  singletons: number;
  largestGroup: number;
  avgGroupSize: number;
  edgesCreated: number;
}

export function clusterAssets(
  assets: Asset[],
  config: ClusterConfig = DEFAULT_CLUSTER_CONFIG
): { groups: PhotoGroup[]; stats: ClusterStats } {
  // Sort by time
  const sorted = [...assets].sort(
    (a, b) => a.fileCreatedAt.getTime() - b.fileCreatedAt.getTime()
  );

  const n = sorted.length;
  const uf = new UnionFind(n);
  let edgesCreated = 0;

  // Create time buckets with stride
  const bucketMs = config.bucketMinutes * 60_000;
  const strideMs = config.bucketStride * 60_000;

  if (n === 0) {
    return { groups: [], stats: emptyStats() };
  }

  const startTime = sorted[0].fileCreatedAt.getTime();
  const endTime = sorted[n - 1].fileCreatedAt.getTime();

  // Separate assets with valid dates from those without
  const EPOCH_THRESHOLD = 86_400_000; // 1 day after epoch = "no date"
  const dated = sorted.filter((a) => a.fileCreatedAt.getTime() > EPOCH_THRESHOLD);
  const undated = sorted.filter((a) => a.fileCreatedAt.getTime() <= EPOCH_THRESHOLD);

  console.log(`Clustering ${dated.length} dated + ${undated.length} undated assets`);
  if (dated.length > 0) {
    console.log(`Date range: ${dated[0].fileCreatedAt.toISOString()} to ${dated[dated.length - 1].fileCreatedAt.toISOString()}`);
  }

  // Build index map: asset -> position in sorted array
  const assetIndex = new Map<string, number>();
  sorted.forEach((a, i) => assetIndex.set(a.id, i));

  // Process dated assets with time buckets
  const datedStart = dated.length > 0 ? dated[0].fileCreatedAt.getTime() : 0;
  const datedEnd = dated.length > 0 ? dated[dated.length - 1].fileCreatedAt.getTime() : 0;

  let bucketCount = 0;
  for (let bucketStart = datedStart; bucketStart <= datedEnd; bucketStart += strideMs) {
    const bucketEnd = bucketStart + bucketMs;

    // Find assets in this bucket (binary search would be faster but this is fine for 100k)
    const bucketIndices: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = sorted[i].fileCreatedAt.getTime();
      if (t >= bucketStart && t < bucketEnd) {
        bucketIndices.push(i);
      }
    }

    if (bucketIndices.length < 2) continue;
    bucketCount++;

    // Gather embeddings for this bucket
    const bucketEmbeddings = bucketIndices.map((i) => sorted[i].embedding);

    // For each asset in the bucket, find top-K neighbors
    for (let localIdx = 0; localIdx < bucketIndices.length; localIdx++) {
      const globalIdx = bucketIndices[localIdx];
      const asset = sorted[globalIdx];

      const neighbors = topKNeighbors(
        asset.embedding,
        bucketEmbeddings,
        config.topK,
        localIdx
      );

      for (const neighbor of neighbors) {
        const neighborGlobalIdx = bucketIndices[neighbor.index];
        const neighborAsset = sorted[neighborGlobalIdx];
        const timeDeltaMin =
          Math.abs(asset.fileCreatedAt.getTime() - neighborAsset.fileCreatedAt.getTime()) / 60_000;

        let shouldLink = false;

        // Strong edge: similar enough regardless of time (within the bucket)
        if (neighbor.distance <= config.strongEdgeDistance) {
          shouldLink = true;
        }
        // Near-burst edge: somewhat similar + very close in time
        else if (
          neighbor.distance <= config.burstEdgeDistance &&
          timeDeltaMin <= config.burstTimeMinutes
        ) {
          shouldLink = true;
        }

        if (shouldLink) {
          uf.union(globalIdx, neighborGlobalIdx);
          edgesCreated++;
        }
      }
    }
  }

  // Process undated assets: only use strong similarity edges (no time signal)
  if (undated.length >= 2) {
    const undatedIndices = undated.map((a) => assetIndex.get(a.id)!);
    const undatedEmbeddings = undated.map((a) => a.embedding);

    // Use a tighter threshold for undated since we have no time signal
    const UNDATED_THRESHOLD = config.strongEdgeDistance * 0.75;

    for (let localIdx = 0; localIdx < undated.length; localIdx++) {
      const globalIdx = undatedIndices[localIdx];
      const neighbors = topKNeighbors(undated[localIdx].embedding, undatedEmbeddings, config.topK, localIdx);

      for (const neighbor of neighbors) {
        if (neighbor.distance <= UNDATED_THRESHOLD) {
          uf.union(globalIdx, undatedIndices[neighbor.index]);
          edgesCreated++;
        }
      }
    }
    console.log(`Processed ${undated.length} undated assets with tighter threshold (${UNDATED_THRESHOLD.toFixed(3)})`);
  }

  console.log(`Processed ${bucketCount} time buckets, created ${edgesCreated} edges`);

  // Extract connected components
  const components = uf.getComponents();
  let groups: PhotoGroup[] = [];
  let singletons = 0;

  for (const [, memberIndices] of components) {
    if (memberIndices.length < config.minGroupSize) {
      singletons += memberIndices.length;
      continue;
    }

    const groupAssets = memberIndices.map((i) => sorted[i]);

    // Split mega-groups by temporal gaps
    const subGroups = splitMegaGroup(groupAssets, config);

    for (const subGroup of subGroups) {
      if (subGroup.length < config.minGroupSize) {
        singletons += subGroup.length;
        continue;
      }

      const times = subGroup.map((a) => a.fileCreatedAt.getTime());
      const timeSpanMin = (Math.max(...times) - Math.min(...times)) / 60_000;

      // Compute average pairwise distance (sample if large)
      const avgDist = sampleAvgDistance(subGroup);

      groups.push({
        id: `group-${groups.length}`,
        assets: subGroup.map((asset) => ({
          asset,
          rank: null,
          keep: false,
          reason: null,
        })),
        bestAssetId: null,
        summary: null,
        confidence: null,
        timeSpanMinutes: Math.round(timeSpanMin * 10) / 10,
        avgDistance: Math.round(avgDist * 1000) / 1000,
      });
    }
  }

  // Sort groups by size descending for review priority
  groups.sort((a, b) => b.assets.length - a.assets.length);

  // Re-index
  groups = groups.map((g, i) => ({ ...g, id: `group-${i}` }));

  const stats: ClusterStats = {
    totalAssets: n,
    assetsWithEmbeddings: n,
    totalGroups: groups.length,
    singletons,
    largestGroup: groups.length > 0 ? Math.max(...groups.map((g) => g.assets.length)) : 0,
    avgGroupSize:
      groups.length > 0
        ? Math.round((groups.reduce((s, g) => s + g.assets.length, 0) / groups.length) * 10) / 10
        : 0,
    edgesCreated,
  };

  return { groups, stats };
}

/** Split a group if there are temporal gaps > 12 minutes */
function splitMegaGroup(assets: Asset[], config: ClusterConfig): Asset[][] {
  if (assets.length <= config.maxGroupSize) return [assets];

  const sorted = [...assets].sort(
    (a, b) => a.fileCreatedAt.getTime() - b.fileCreatedAt.getTime()
  );

  const GAP_THRESHOLD_MS = 12 * 60_000; // 12 minutes
  const subGroups: Asset[][] = [];
  let current: Asset[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].fileCreatedAt.getTime() - sorted[i - 1].fileCreatedAt.getTime();
    if (gap > GAP_THRESHOLD_MS) {
      subGroups.push(current);
      current = [];
    }
    current.push(sorted[i]);
  }
  subGroups.push(current);

  // If still too large, split further by re-clustering with tighter threshold
  const result: Asset[][] = [];
  for (const sg of subGroups) {
    if (sg.length <= config.maxGroupSize) {
      result.push(sg);
    } else {
      // Just split in half by time as a fallback
      const mid = Math.floor(sg.length / 2);
      result.push(sg.slice(0, mid));
      result.push(sg.slice(mid));
    }
  }

  return result;
}

/** Sample average pairwise cosine distance (cap at 50 pairs for large groups) */
function sampleAvgDistance(assets: Asset[]): number {
  if (assets.length < 2) return 0;
  const maxPairs = 50;
  let totalDist = 0;
  let count = 0;

  if (assets.length <= 10) {
    // All pairs
    for (let i = 0; i < assets.length; i++) {
      for (let j = i + 1; j < assets.length; j++) {
        totalDist += cosineDistance(assets[i].embedding, assets[j].embedding);
        count++;
      }
    }
  } else {
    // Random sampling
    for (let k = 0; k < maxPairs; k++) {
      const i = Math.floor(Math.random() * assets.length);
      let j = Math.floor(Math.random() * assets.length);
      while (j === i) j = Math.floor(Math.random() * assets.length);
      totalDist += cosineDistance(assets[i].embedding, assets[j].embedding);
      count++;
    }
  }

  return count > 0 ? totalDist / count : 0;
}

function emptyStats(): ClusterStats {
  return {
    totalAssets: 0,
    assetsWithEmbeddings: 0,
    totalGroups: 0,
    singletons: 0,
    largestGroup: 0,
    avgGroupSize: 0,
    edgesCreated: 0,
  };
}
