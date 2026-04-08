/**
 * Session batcher: groups photos into day/trip-sized batches for LLM review.
 *
 * Strategy:
 * - DSLR photos with folder patterns (YYYYMMDD-name): use folder as batch boundary
 * - Phone/other photos: split at 4-hour time gaps
 * - Sub-split batches >maxBatchSize at the largest internal gap
 */
import { Asset } from "../shared/types.js";
import { createHash } from "crypto";

export interface SessionBatch {
  id: string;
  assets: Asset[];
  source: "folder" | "time-gap";
  folderName: string | null;
  dateRange: { start: Date; end: Date };
}

export interface SessionBatchConfig {
  /** Time gap in hours to split phone photo sessions */
  gapHours: number;
  /** Max photos per batch before sub-splitting */
  maxBatchSize: number;
  /** Min photos per batch — smaller ones get merged into neighbors */
  minBatchSize: number;
  /** Regex to detect DSLR folder patterns in paths */
  folderPattern: RegExp;
}

export const DEFAULT_SESSION_CONFIG: SessionBatchConfig = {
  gapHours: 4,
  maxBatchSize: 30,
  minBatchSize: 3,
  folderPattern: /\/(\d{8}-[^/]+)\//,
};

export function batchBySession(
  assets: Asset[],
  config: SessionBatchConfig = DEFAULT_SESSION_CONFIG,
): SessionBatch[] {
  // Separate DSLR (folder-grouped) from phone (time-gap grouped)
  const folderAssets = new Map<string, Asset[]>();
  const timeAssets: Asset[] = [];

  for (const a of assets) {
    const match = a.path.match(config.folderPattern);
    if (match) {
      const folder = match[1];
      if (!folderAssets.has(folder)) folderAssets.set(folder, []);
      folderAssets.get(folder)!.push(a);
    } else {
      timeAssets.push(a);
    }
  }

  let batches: SessionBatch[] = [];

  // DSLR folder batches
  for (const [folder, folderPhotos] of folderAssets) {
    const sorted = folderPhotos.toSorted(
      (a, b) => a.fileCreatedAt.getTime() - b.fileCreatedAt.getTime(),
    );
    const subBatches = splitIfTooLarge(sorted, config.maxBatchSize);
    for (const sub of subBatches) {
      batches.push({
        id: `folder-${folder}-${batches.length}`,
        assets: sub,
        source: "folder",
        folderName: folder,
        dateRange: {
          start: sub[0].fileCreatedAt,
          end: sub[sub.length - 1].fileCreatedAt,
        },
      });
    }
  }

  // Phone photos: split by time gaps
  const sorted = timeAssets.toSorted(
    (a, b) => a.fileCreatedAt.getTime() - b.fileCreatedAt.getTime(),
  );
  const gapMs = config.gapHours * 3600_000;

  if (sorted.length > 0) {
    let current: Asset[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].fileCreatedAt.getTime() - sorted[i - 1].fileCreatedAt.getTime();
      if (gap > gapMs) {
        // Split here
        const subBatches = splitIfTooLarge(current, config.maxBatchSize);
        for (const sub of subBatches) {
          batches.push({
            id: `session-${batches.length}`,
            assets: sub,
            source: "time-gap",
            folderName: null,
            dateRange: {
              start: sub[0].fileCreatedAt,
              end: sub[sub.length - 1].fileCreatedAt,
            },
          });
        }
        current = [];
      }
      current.push(sorted[i]);
    }

    // Last session
    if (current.length > 0) {
      const subBatches = splitIfTooLarge(current, config.maxBatchSize);
      for (const sub of subBatches) {
        batches.push({
          id: `session-${batches.length}`,
          assets: sub,
          source: "time-gap",
          folderName: null,
          dateRange: {
            start: sub[0].fileCreatedAt,
            end: sub[sub.length - 1].fileCreatedAt,
          },
        });
      }
    }
  }

  // Merge small batches into their nearest neighbor
  if (config.minBatchSize > 1) {
    // Sort by date first so neighbors are temporally adjacent
    batches = batches.toSorted((a, b) => a.dateRange.start.getTime() - b.dateRange.start.getTime());

    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < batches.length; i++) {
        if (batches[i].assets.length >= config.minBatchSize) continue;
        // Don't merge DSLR folder batches (they have intentional boundaries)
        if (batches[i].source === "folder") continue;

        // Find the closest neighbor that won't exceed maxBatchSize
        let bestIdx = -1;
        let bestGap = Infinity;
        for (const j of [i - 1, i + 1]) {
          if (j < 0 || j >= batches.length) continue;
          if (batches[j].source === "folder") continue; // don't merge into folders
          if (batches[i].assets.length + batches[j].assets.length > config.maxBatchSize) continue;
          const gap = Math.abs(
            batches[i].dateRange.start.getTime() - batches[j].dateRange.end.getTime(),
          );
          if (gap < bestGap) {
            bestGap = gap;
            bestIdx = j;
          }
        }

        if (bestIdx >= 0) {
          // Merge i into bestIdx
          const target = batches[bestIdx];
          const source = batches[i];
          target.assets = [...target.assets, ...source.assets].toSorted(
            (a, b) => a.fileCreatedAt.getTime() - b.fileCreatedAt.getTime(),
          );
          target.dateRange = {
            start: target.assets[0].fileCreatedAt,
            end: target.assets[target.assets.length - 1].fileCreatedAt,
          };
          batches.splice(i, 1);
          merged = true;
          break; // restart scan
        }
      }
    }
  }

  // Sort batches by date (newest first for review)
  batches = batches.toSorted((a, b) => b.dateRange.start.getTime() - a.dateRange.start.getTime());

  // Assign stable content-addressed IDs (hash of asset IDs, not positional)
  return batches.map((b) => ({
    ...b,
    id: stableBatchId(b),
  }));
}

/** Split a sorted array of assets at the largest internal time gap if it exceeds maxSize */
function splitIfTooLarge(assets: Asset[], maxSize: number): Asset[][] {
  if (assets.length <= maxSize) return [assets];

  // Find the largest gap
  let maxGap = 0;
  let maxGapIdx = 0;
  for (let i = 1; i < assets.length; i++) {
    const gap = assets[i].fileCreatedAt.getTime() - assets[i - 1].fileCreatedAt.getTime();
    if (gap > maxGap) {
      maxGap = gap;
      maxGapIdx = i;
    }
  }

  // If no gap (all same timestamp), split in half
  if (maxGap === 0) maxGapIdx = Math.ceil(assets.length / 2);

  const left = assets.slice(0, maxGapIdx);
  const right = assets.slice(maxGapIdx);

  const result: Asset[][] = [];
  for (const chunk of [left, right]) {
    if (chunk.length > maxSize) {
      result.push(...splitIfTooLarge(chunk, maxSize));
    } else if (chunk.length > 0) {
      result.push(chunk);
    }
  }
  return result;
}

/** Content-addressed batch ID: stable even if batch order changes */
function stableBatchId(batch: SessionBatch): string {
  const ids = batch.assets
    .map((a) => a.id)
    .toSorted()
    .join("\n");
  const hash = createHash("sha256").update(ids).digest("hex").slice(0, 12);
  const date = batch.dateRange.start.toISOString().slice(0, 10);
  return `${date}-${hash}`;
}

/** Print batch statistics */
export function batchStats(batches: SessionBatch[]): string {
  if (batches.length === 0) return "0 batches from 0 photos";
  const totalPhotos = batches.reduce((s, b) => s + b.assets.length, 0);
  const sizes = batches.map((b) => b.assets.length);
  const sorted = [...sizes].toSorted((a, b) => a - b);
  const folderBatches = batches.filter((b) => b.source === "folder").length;
  const timeBatches = batches.filter((b) => b.source === "time-gap").length;

  return [
    `${batches.length} batches from ${totalPhotos} photos`,
    `  Folder-based: ${folderBatches}, Time-gap: ${timeBatches}`,
    `  Sizes: min=${sorted[0]}, max=${sorted[sorted.length - 1]}, avg=${(totalPhotos / batches.length).toFixed(1)}, median=${sorted[Math.floor(sorted.length / 2)]}`,
  ].join("\n");
}
