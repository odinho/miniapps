/**
 * Review server: Fastify API + static file serving for the review UI.
 *
 * Modes:
 *   --local   Use Facet SQLite (default, for development)
 *   --immich  Use Immich PostgreSQL via SSH tunnel
 *
 * Usage: npx tsx src/server.ts [--local|--immich] [--port 3000]
 */
import Fastify from "fastify";
import { resolve, join, dirname } from "path";
import { readFileSync, existsSync } from "fs";
import { FacetAdapter } from "./db/facet-adapter.js";
import { ImmichAdapter } from "./db/immich-adapter.js";
import { clusterAssets } from "./clustering/engine.js";
import { DEFAULT_CLUSTER_CONFIG, PhotoGroup, Asset } from "./shared/types.js";
import sharp from "sharp";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function getArg(flag: string, defaultVal: string): string {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : defaultVal;
}

const useImmich = args.includes("--immich");
const port = parseInt(getArg("--port", "3000"));
const sampleSize = parseInt(getArg("--sample", "0"));

const app = Fastify({ logger: false });

// State
let groups: PhotoGroup[] = [];
let assetMap = new Map<string, Asset>();
let decisions = new Map<string, { keep: string[]; cull: string[]; skipped: boolean }>();

async function loadData() {
  let assets: Asset[];

  if (useImmich) {
    console.log("Connecting to Immich PostgreSQL...");
    const adapter = new ImmichAdapter({
      host: "localhost",
      port: 15432,
      user: "postgres",
      password: "ga3wSqj6do7zt78TaHC8Oj9oUxz8YLrK",
      database: "immich",
    });

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
    const dbPath = resolve(__dirname, "../../../facet/photo_scores_pro.db");
    console.log(`Loading from Facet DB: ${dbPath}`);
    const adapter = new FacetAdapter(dbPath);
    assets = adapter.getAllAssets();
    adapter.close();
  }

  console.log(`Loaded ${assets.length} assets, clustering...`);
  const result = clusterAssets(assets, DEFAULT_CLUSTER_CONFIG);
  groups = result.groups;

  // Build asset map
  for (const a of assets) {
    assetMap.set(a.id, a);
  }

  console.log(`${groups.length} groups found (${result.stats.singletons} singletons)`);
}

// === API Routes ===

/** List all groups with summary info */
app.get("/api/groups", async () => {
  return groups.map((g, i) => ({
    id: g.id,
    index: i,
    count: g.assets.length,
    timeSpanMinutes: g.timeSpanMinutes,
    avgDistance: g.avgDistance,
    decided: decisions.has(g.id),
    assets: g.assets.map((a) => ({
      id: a.asset.id,
      filename: a.asset.filename,
      date: a.asset.fileCreatedAt.toISOString(),
      rating: a.asset.rating,
      isFavorite: a.asset.isFavorite,
    })),
  }));
});

/** Get a single group */
app.get<{ Params: { id: string } }>("/api/groups/:id", async (req) => {
  const group = groups.find((g) => g.id === req.params.id);
  if (!group) return { error: "Not found" };

  const decision = decisions.get(group.id);

  return {
    id: group.id,
    count: group.assets.length,
    timeSpanMinutes: group.timeSpanMinutes,
    avgDistance: group.avgDistance,
    decision: decision || null,
    assets: group.assets.map((a) => ({
      id: a.asset.id,
      filename: a.asset.filename,
      path: a.asset.path,
      date: a.asset.fileCreatedAt.toISOString(),
      rating: a.asset.rating,
      isFavorite: a.asset.isFavorite,
    })),
  };
});

/** Save a decision for a group */
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

/** Get review stats */
app.get("/api/stats", async () => {
  let totalKeep = 0;
  let totalCull = 0;
  let totalSkipped = 0;
  for (const d of decisions.values()) {
    if (d.skipped) {
      totalSkipped++;
    } else {
      totalKeep += d.keep.length;
      totalCull += d.cull.length;
    }
  }

  return {
    totalGroups: groups.length,
    decided: decisions.size,
    skipped: totalSkipped,
    photosToKeep: totalKeep,
    photosToCull: totalCull,
    remaining: groups.length - decisions.size,
  };
});

/** Serve a thumbnail for an asset (resized to 400px for the UI) */
app.get<{ Querystring: { id: string } }>("/api/thumb", async (req, reply) => {
  const asset = assetMap.get(req.query.id);
  if (!asset) {
    reply.code(404);
    return { error: "Not found" };
  }

  // Reconstruct the file path (add extension back for Facet paths)
  let filePath = asset.path;
  if (!existsSync(filePath)) {
    // Facet strips extensions; try common ones
    for (const ext of [".jpg", ".jpeg", ".JPG", ".JPEG", ".png", ".PNG"]) {
      if (existsSync(filePath + ext)) {
        filePath = filePath + ext;
        break;
      }
    }
  }

  if (!existsSync(filePath)) {
    reply.code(404);
    return { error: `File not found: ${asset.filename}` };
  }

  try {
    const thumb = await sharp(filePath)
      .resize(400, 400, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();

    reply.type("image/jpeg");
    return thumb;
  } catch (e: any) {
    reply.code(500);
    return { error: e.message };
  }
});

/** Serve a full preview for an asset */
app.get<{ Querystring: { id: string } }>("/api/preview", async (req, reply) => {
  const asset = assetMap.get(req.query.id);
  if (!asset) {
    reply.code(404);
    return { error: "Not found" };
  }

  let filePath = asset.path;
  if (!existsSync(filePath)) {
    for (const ext of [".jpg", ".jpeg", ".JPG", ".JPEG", ".png", ".PNG"]) {
      if (existsSync(filePath + ext)) {
        filePath = filePath + ext;
        break;
      }
    }
  }

  if (!existsSync(filePath)) {
    reply.code(404);
    return { error: `File not found: ${asset.filename}` };
  }

  try {
    const preview = await sharp(filePath)
      .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    reply.type("image/jpeg");
    return preview;
  } catch (e: any) {
    reply.code(500);
    return { error: e.message };
  }
});

// === Static file serving for the SPA ===
app.get("/", async (_, reply) => {
  reply.type("text/html");
  return readFileSync(resolve(__dirname, "../web/index.html"), "utf-8");
});

// === Start ===
await loadData();
await app.listen({ port, host: "0.0.0.0" });
console.log(`\nReview UI: http://localhost:${port}`);
console.log(`Network:   http://192.168.10.88:${port}`);
