/**
 * Time-constrained similarity graph clustering engine.
 *
 * Algorithm:
 * 1. Sort assets by time, create overlapping time buckets
 * 2. Within each bucket, find top-K neighbors per asset using cosine distance
 * 3. Add edges: strong (distance ≤ threshold) or near-burst (distance ≤ burst threshold + time proximity)
 * 4. Find connected components via Union-Find
 * 5. Split groups by temporal gaps (all groups, not just oversized ones)
 */
import { Asset, ClusterConfig, DEFAULT_CLUSTER_CONFIG, PhotoGroup } from "../shared/types.js";
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

/** Binary search: find first index where sorted[i].time >= target */
function lowerBound(times: number[], target: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function clusterAssets(
  assets: Asset[],
  config: ClusterConfig = DEFAULT_CLUSTER_CONFIG,
  log: (msg: string) => void = console.log
): { groups: PhotoGroup[]; stats: ClusterStats } {
  const sorted = [...assets].sort(
    (a, b) => a.fileCreatedAt.getTime() - b.fileCreatedAt.getTime()
  );

  const n = sorted.length;
  const uf = new UnionFind(n);
  let edgesCreated = 0;

  const bucketMs = config.bucketMinutes * 60_000;
  const strideMs = config.bucketStride * 60_000;

  if (n === 0) {
    return { groups: [], stats: emptyStats() };
  }

  // Separate dated from undated
  const EPOCH_THRESHOLD = 86_400_000;
  const times = sorted.map((a) => a.fileCreatedAt.getTime());

  // Find the boundary between undated and dated using binary search
  const datedStartIdx = lowerBound(times, EPOCH_THRESHOLD + 1);
  const undatedCount = datedStartIdx;
  const datedCount = n - datedStartIdx;

  log(`Clustering ${datedCount} dated + ${undatedCount} undated assets`);
  if (datedCount > 0) {
    log(`Date range: ${sorted[datedStartIdx].fileCreatedAt.toISOString()} to ${sorted[n - 1].fileCreatedAt.toISOString()}`);
  }

  // Process dated assets with time buckets (using binary search for bucket membership)
  if (datedCount >= 2) {
    const datedStart = times[datedStartIdx];
    const datedEnd = times[n - 1];

    let bucketCount = 0;
    for (let bucketStart = datedStart; bucketStart <= datedEnd; bucketStart += strideMs) {
      const bucketEnd = bucketStart + bucketMs;

      // Binary search for bucket boundaries
      const lo = lowerBound(times, bucketStart);
      const hi = lowerBound(times, bucketEnd);

      if (hi - lo < 2) continue;
      bucketCount++;

      const bucketIndices: number[] = [];
      for (let i = lo; i < hi; i++) bucketIndices.push(i);

      const bucketEmbeddings = bucketIndices.map((i) => sorted[i].embedding);

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

          if (neighbor.distance <= config.strongEdgeDistance) {
            shouldLink = true;
          } else if (
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

    log(`Processed ${bucketCount} time buckets`);
  }

  // Process undated assets: tighter threshold, no time signal
  if (undatedCount >= 2) {
    if (undatedCount > 5000) {
      log(`WARNING: ${undatedCount} undated assets — O(n²) may be slow. Consider fixing dates.`);
    }
    const UNDATED_THRESHOLD = config.strongEdgeDistance * 0.75;

    const undatedEmbeddings: Float32Array[] = [];
    for (let i = 0; i < undatedCount; i++) {
      undatedEmbeddings.push(sorted[i].embedding);
    }

    for (let localIdx = 0; localIdx < undatedCount; localIdx++) {
      const neighbors = topKNeighbors(undatedEmbeddings[localIdx], undatedEmbeddings, config.topK, localIdx);
      for (const neighbor of neighbors) {
        if (neighbor.distance <= UNDATED_THRESHOLD) {
          uf.union(localIdx, neighbor.index);
          edgesCreated++;
        }
      }
    }
    log(`Processed ${undatedCount} undated assets (threshold ${UNDATED_THRESHOLD.toFixed(3)})`);
  }

  log(`Created ${edgesCreated} edges`);

  // Extract connected components and split by temporal gaps
  const components = uf.getComponents();
  let groups: PhotoGroup[] = [];
  let singletons = 0;

  for (const [, memberIndices] of components) {
    if (memberIndices.length < config.minGroupSize) {
      singletons += memberIndices.length;
      continue;
    }

    const groupAssets = memberIndices.map((i) => sorted[i]);

    // Always split by temporal gaps (not just mega-groups)
    const subGroups = splitByTemporalGaps(groupAssets, config);

    for (const subGroup of subGroups) {
      if (subGroup.length < config.minGroupSize) {
        singletons += subGroup.length;
        continue;
      }

      const subTimes = subGroup.map((a) => a.fileCreatedAt.getTime());
      const timeSpanMin = (Math.max(...subTimes) - Math.min(...subTimes)) / 60_000;
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

  groups.sort((a, b) => b.assets.length - a.assets.length);
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

/** Split any group by temporal gaps > 12 minutes, then cap oversized subgroups. */
function splitByTemporalGaps(assets: Asset[], config: ClusterConfig): Asset[][] {
  if (assets.length < 2) return [assets];

  const sorted = [...assets].sort(
    (a, b) => a.fileCreatedAt.getTime() - b.fileCreatedAt.getTime()
  );

  const GAP_THRESHOLD_MS = 12 * 60_000;
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

  // Cap oversized subgroups by splitting in half
  const result: Asset[][] = [];
  for (const sg of subGroups) {
    if (sg.length <= config.maxGroupSize) {
      result.push(sg);
    } else {
      const mid = Math.floor(sg.length / 2);
      result.push(sg.slice(0, mid));
      result.push(sg.slice(mid));
    }
  }

  return result;
}

function sampleAvgDistance(assets: Asset[]): number {
  if (assets.length < 2) return 0;
  const maxPairs = 50;
  let totalDist = 0;
  let count = 0;

  if (assets.length <= 10) {
    for (let i = 0; i < assets.length; i++) {
      for (let j = i + 1; j < assets.length; j++) {
        totalDist += cosineDistance(assets[i].embedding, assets[j].embedding);
        count++;
      }
    }
  } else {
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
  return { totalAssets: 0, assetsWithEmbeddings: 0, totalGroups: 0, singletons: 0, largestGroup: 0, avgGroupSize: 0, edgesCreated: 0 };
}
