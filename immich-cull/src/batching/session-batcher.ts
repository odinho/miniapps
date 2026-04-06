/**
 * Session batcher: groups photos into day/trip-sized batches for LLM review.
 *
 * Strategy:
 * - DSLR photos with folder patterns (YYYYMMDD-name): use folder as batch boundary
 * - Phone/other photos: split at 4-hour time gaps
 * - Sub-split batches >maxBatchSize at the largest internal gap
 */
import { Asset } from "../shared/types.js";

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
  /** Regex to detect DSLR folder patterns in paths */
  folderPattern: RegExp;
}

export const DEFAULT_SESSION_CONFIG: SessionBatchConfig = {
  gapHours: 4,
  maxBatchSize: 150,
  folderPattern: /\/(\d{8}-[^/]+)\//,
};

export function batchBySession(
  assets: Asset[],
  config: SessionBatchConfig = DEFAULT_SESSION_CONFIG
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

  const batches: SessionBatch[] = [];

  // DSLR folder batches
  for (const [folder, folderPhotos] of folderAssets) {
    const sorted = folderPhotos.sort((a, b) => a.fileCreatedAt.getTime() - b.fileCreatedAt.getTime());
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
  const sorted = timeAssets.sort((a, b) => a.fileCreatedAt.getTime() - b.fileCreatedAt.getTime());
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

  // Sort batches by date (newest first for review)
  batches.sort((a, b) => b.dateRange.start.getTime() - a.dateRange.start.getTime());

  // Re-index
  return batches.map((b, i) => ({ ...b, id: `batch-${i}` }));
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

/** Print batch statistics */
export function batchStats(batches: SessionBatch[]): string {
  const totalPhotos = batches.reduce((s, b) => s + b.assets.length, 0);
  const sizes = batches.map((b) => b.assets.length);
  const folderBatches = batches.filter((b) => b.source === "folder").length;
  const timeBatches = batches.filter((b) => b.source === "time-gap").length;

  return [
    `${batches.length} batches from ${totalPhotos} photos`,
    `  Folder-based: ${folderBatches}, Time-gap: ${timeBatches}`,
    `  Sizes: min=${Math.min(...sizes)}, max=${Math.max(...sizes)}, avg=${(totalPhotos / batches.length).toFixed(1)}, median=${sizes.sort((a, b) => a - b)[Math.floor(sizes.length / 2)]}`,
  ].join("\n");
}
