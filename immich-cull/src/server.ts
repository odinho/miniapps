/**
 * Review server: Fastify API + static file serving for the review UI.
 *
 * Modes:
 *   --local   Use Facet SQLite (default, for development)
 *   --immich  Use Immich PostgreSQL via SSH tunnel
 */
import Fastify from "fastify";
import { resolve, dirname } from "path";
import { readFileSync, existsSync, statSync } from "fs";
import { FacetAdapter } from "./db/facet-adapter.js";
import { ImmichAdapter } from "./db/immich-adapter.js";
import { clusterAssets } from "./clustering/engine.js";
import { DEFAULT_CLUSTER_CONFIG, PhotoGroup, Asset } from "./shared/types.js";
import { getImmichDbConfig } from "./shared/config.js";
import sharp from "sharp";
import { fileURLToPath } from "url";
import { config as loadEnv } from "dotenv";
loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function getArg(flag: string, defaultVal: string): string {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : defaultVal;
}

const useImmich = args.includes("--immich");
const port = parseInt(getArg("--port", "3000"));
const sampleSize = parseInt(getArg("--sample", "0"));

const PREVIEW_MAX_PX = 1400;

const app = Fastify({ logger: false });

// State
let groups: PhotoGroup[] = [];
let assetMap = new Map<string, Asset>();
let fileSizeCache = new Map<string, number>(); // assetId -> bytes
let dimensionCache = new Map<string, { w: number; h: number }>(); // assetId -> dimensions
let decisions = new Map<string, { keep: string[]; cull: string[]; skipped: boolean }>();

/** Resolve the file path, handling Facet's extension-stripped paths */
function resolveFilePath(asset: Asset): string | null {
  if (existsSync(asset.path)) return asset.path;
  for (const ext of [".jpg", ".jpeg", ".JPG", ".JPEG", ".png", ".PNG", ".heic", ".HEIC"]) {
    if (existsSync(asset.path + ext)) return asset.path + ext;
  }
  return null;
}

/** Get file size in bytes, cached */
function getFileSize(asset: Asset): number {
  if (fileSizeCache.has(asset.id)) return fileSizeCache.get(asset.id)!;
  const fp = resolveFilePath(asset);
  if (!fp) return 0;
  try {
    const size = statSync(fp).size;
    fileSizeCache.set(asset.id, size);
    return size;
  } catch {
    return 0;
  }
}

/** Get image dimensions (rotated), cached */
async function getDimensions(asset: Asset): Promise<{ w: number; h: number }> {
  if (dimensionCache.has(asset.id)) return dimensionCache.get(asset.id)!;
  const fp = resolveFilePath(asset);
  if (!fp) return { w: 4, h: 3 };
  try {
    const meta = await sharp(fp).metadata();
    let w = meta.width ?? 4;
    let h = meta.height ?? 3;
    // EXIF orientations 5-8 involve a 90° rotation, so swap w/h
    if (meta.orientation && meta.orientation >= 5 && meta.orientation <= 8) {
      [w, h] = [h, w];
    }
    // Scale down to match the preview endpoint's max dimension
    if (w > PREVIEW_MAX_PX || h > PREVIEW_MAX_PX) {
      const scale = PREVIEW_MAX_PX / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    const dims = { w, h };
    dimensionCache.set(asset.id, dims);
    return dims;
  } catch {
    return { w: 4, h: 3 };
  }
}

async function loadData() {
  let assets: Asset[];

  if (useImmich) {
    console.log("Connecting to Immich PostgreSQL...");
    const adapter = new ImmichAdapter(getImmichDbConfig());
    const count = await adapter.getAssetCount();
    console.log(`Immich has ${count} images with embeddings`);

    if (sampleSize > 0) {
      console.log(`Loading ${sampleSize} most recent...`);
      assets = await adapter.getSampleAssets(sampleSize);
    } else {
      console.log("Loading all assets...");
      assets = await adapter.getAllAssets((loaded, total) => {
        process.stdout.write(`\r  ${loaded}/${total}`);
      });
      console.log();
    }
    await adapter.close();
  } else {
    const dbPath = getArg("--db", resolve(__dirname, "../../../facet/photo_scores_pro.db"));
    console.log(`Loading from Facet DB: ${dbPath}`);
    const adapter = new FacetAdapter(dbPath);
    assets = adapter.getAllAssets();
    adapter.close();
  }

  console.log(`Loaded ${assets.length} assets, clustering...`);
  const result = clusterAssets(assets, DEFAULT_CLUSTER_CONFIG);

  // Sort groups by earliest date (temporally close groups adjacent)
  groups = result.groups.sort((a, b) => {
    const aTime = Math.min(...a.assets.map((x) => x.asset.fileCreatedAt.getTime()));
    const bTime = Math.min(...b.assets.map((x) => x.asset.fileCreatedAt.getTime()));
    return bTime - aTime; // newest first
  });
  // Re-index after sort
  groups = groups.map((g, i) => ({ ...g, id: `group-${i}` }));

  for (const a of assets) assetMap.set(a.id, a);
  console.log(`${groups.length} groups found (${result.stats.singletons} singletons)`);
}

// === API Routes ===

app.get("/api/groups", async () => {
  return groups.map((g, i) => ({
    id: g.id,
    index: i,
    count: g.assets.length,
    timeSpanMinutes: g.timeSpanMinutes,
    avgDistance: g.avgDistance,
    decided: decisions.has(g.id),
    earliestDate: Math.min(...g.assets.map((a) => a.asset.fileCreatedAt.getTime())),
    totalBytes: g.assets.reduce((s, a) => s + getFileSize(a.asset), 0),
    assets: g.assets.map((a) => ({
      id: a.asset.id,
      filename: a.asset.filename,
      date: a.asset.fileCreatedAt.toISOString(),
      rating: a.asset.rating,
      isFavorite: a.asset.isFavorite,
      bytes: getFileSize(a.asset),
    })),
  }));
});

app.get<{ Params: { id: string } }>("/api/groups/:id", async (req) => {
  const group = groups.find((g) => g.id === req.params.id);
  if (!group) return { error: "Not found" };

  // Include dimensions for layout computation
  const assetsWithDims = await Promise.all(
    group.assets.map(async (a) => {
      const dims = await getDimensions(a.asset);
      return {
        id: a.asset.id,
        filename: a.asset.filename,
        path: a.asset.path,
        date: a.asset.fileCreatedAt.toISOString(),
        rating: a.asset.rating,
        isFavorite: a.asset.isFavorite,
        bytes: getFileSize(a.asset),
        w: dims.w,
        h: dims.h,
      };
    })
  );

  return {
    id: group.id,
    count: group.assets.length,
    timeSpanMinutes: group.timeSpanMinutes,
    avgDistance: group.avgDistance,
    totalBytes: group.assets.reduce((s, a) => s + getFileSize(a.asset), 0),
    decision: decisions.get(group.id) || null,
    assets: assetsWithDims,
  };
});

function groupToJson(group: PhotoGroup) {
  return {
    id: group.id,
    count: group.assets.length,
    timeSpanMinutes: group.timeSpanMinutes,
    avgDistance: group.avgDistance,
    totalBytes: group.assets.reduce((s, a) => s + getFileSize(a.asset), 0),
    assets: group.assets.map((a) => ({
      id: a.asset.id,
      filename: a.asset.filename,
      path: a.asset.path,
      date: a.asset.fileCreatedAt.toISOString(),
      rating: a.asset.rating,
      isFavorite: a.asset.isFavorite,
      bytes: getFileSize(a.asset),
    })),
  };
}

app.post<{
  Params: { id: string };
  Body: { keep: string[]; cull: string[]; skipped?: boolean };
}>("/api/groups/:id/decide", async (req) => {
  const group = groups.find((g) => g.id === req.params.id);
  if (!group) return { error: "Not found" };
  decisions.set(group.id, {
    keep: req.body.keep,
    cull: req.body.cull,
    skipped: req.body.skipped ?? false,
  });
  return { ok: true, decided: decisions.size, total: groups.length };
});

/** Undo a decision (remove it entirely) */
app.delete<{ Params: { id: string } }>("/api/groups/:id/decide", async (req) => {
  decisions.delete(req.params.id);
  return { ok: true, decided: decisions.size };
});

app.get("/api/stats", async () => {
  let totalKeep = 0;
  let totalCull = 0;
  let totalSkipped = 0;
  let cullBytes = 0;
  for (const [groupId, d] of decisions.entries()) {
    if (d.skipped) { totalSkipped++; continue; }
    totalKeep += d.keep.length;
    totalCull += d.cull.length;
    for (const id of d.cull) {
      const a = assetMap.get(id);
      if (a) cullBytes += getFileSize(a);
    }
  }
  return {
    totalGroups: groups.length,
    decided: decisions.size,
    skipped: totalSkipped,
    photosToKeep: totalKeep,
    photosToCull: totalCull,
    remaining: groups.length - decisions.size,
    cullBytes,
  };
});

/** Preview: auto-rotated, max PREVIEW_MAX_PX */
app.get<{ Querystring: { id: string } }>("/api/preview", async (req, reply) => {
  const asset = assetMap.get(req.query.id);
  if (!asset) { reply.code(404); return { error: "Not found" }; }
  const fp = resolveFilePath(asset);
  if (!fp) { reply.code(404); return { error: "File not found" }; }

  try {
    const preview = await sharp(fp)
      .rotate() // auto-rotate based on EXIF orientation
      .resize(PREVIEW_MAX_PX, PREVIEW_MAX_PX, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    reply.type("image/jpeg").header("Cache-Control", "public, max-age=3600");
    return preview;
  } catch (e: any) {
    reply.code(500);
    return { error: e.message };
  }
});

/** Full-size: auto-rotated, original resolution (for preview overlay) */
app.get<{ Querystring: { id: string } }>("/api/full", async (req, reply) => {
  const asset = assetMap.get(req.query.id);
  if (!asset) { reply.code(404); return { error: "Not found" }; }
  const fp = resolveFilePath(asset);
  if (!fp) { reply.code(404); return { error: "File not found" }; }

  try {
    const full = await sharp(fp)
      .rotate()
      .jpeg({ quality: 90 })
      .toBuffer();
    reply.type("image/jpeg").header("Cache-Control", "public, max-age=3600");
    return full;
  } catch (e: any) {
    reply.code(500);
    return { error: e.message };
  }
});

app.get("/", async (_, reply) => {
  reply.type("text/html");
  return readFileSync(resolve(__dirname, "../web/index.html"), "utf-8");
});

await loadData();
await app.listen({ port, host: "0.0.0.0" });
console.log(`\nReview UI: http://localhost:${port}`);
console.log(`Network:   http://192.168.10.88:${port}`);
