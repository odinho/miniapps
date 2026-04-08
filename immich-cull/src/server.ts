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
import { StateDb, batchFingerprint } from "./db/state-db.js";
import { batchBySession, SessionBatch } from "./batching/session-batcher.js";
import { LlmClient } from "./ranking/llm-client.js";
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
let fileSizeCache = new Map<string, number>();
let dimensionCache = new Map<string, { w: number; h: number }>();
const stateDbPath = getArg("--state-db", resolve(__dirname, "../data/state.db"));
const stateDb = new StateDb(stateDbPath);

/** Resolve the file path, handling Facet's extension-stripped paths */
function resolveFilePath(asset: { path: string }): string | null {
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
  groups = result.groups.toSorted((a, b) => {
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
    decided: stateDb.getViewStatus(g.id) !== null,
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
    }),
  );

  return {
    id: group.id,
    count: group.assets.length,
    timeSpanMinutes: group.timeSpanMinutes,
    avgDistance: group.avgDistance,
    totalBytes: group.assets.reduce((s, a) => s + getFileSize(a.asset), 0),
    viewStatus: stateDb.getViewStatus(group.id),
    assets: assetsWithDims,
  };
});

/** Mark a group as reviewed/skipped */
app.post<{
  Params: { id: string };
  Body: { keep: string[]; cull: string[]; skipped?: boolean };
}>("/api/groups/:id/decide", async (req) => {
  const group = groups.find((g) => g.id === req.params.id);
  if (!group) return { error: "Not found" };

  if (req.body.skipped) {
    stateDb.setViewStatus(group.id, "group", "skipped");
  } else {
    // Save per-photo decisions (preserve existing user_stars)
    const assetIds = [...req.body.keep, ...req.body.cull];
    const existing = stateDb.getPhotoDecisions(assetIds);
    const decisions: Array<{ assetId: string; state: string | null; userStars: number | null }> =
      [];
    for (const id of req.body.keep)
      decisions.push({ assetId: id, state: "keep", userStars: existing[id]?.userStars ?? null });
    for (const id of req.body.cull)
      decisions.push({ assetId: id, state: "cull", userStars: existing[id]?.userStars ?? null });
    stateDb.savePhotoDecisions(decisions);
    stateDb.setViewStatus(group.id, "group", "reviewed");
  }

  return { ok: true };
});

/** Undo a group review */
app.delete<{ Params: { id: string } }>("/api/groups/:id/decide", async (req) => {
  stateDb.clearViewStatus(req.params.id);
  return { ok: true };
});

app.get("/api/stats", async () => {
  const s = stateDb.getStats();
  return {
    totalGroups: groups.length,
    decided: s.groupsReviewed + s.groupsSkipped,
    skipped: s.groupsSkipped,
    photosToKeep: s.photosKept,
    photosToCull: s.photosCulled,
    remaining: groups.length - s.groupsReviewed - s.groupsSkipped,
    cullBytes: 0, // TODO: compute efficiently with a join query
  };
});

/** Preview: auto-rotated, max PREVIEW_MAX_PX */
app.get<{ Querystring: { id: string } }>("/api/preview", async (req, reply) => {
  const asset = assetMap.get(req.query.id);
  if (!asset) {
    reply.code(404);
    return { error: "Not found" };
  }
  const fp = resolveFilePath(asset);
  if (!fp) {
    reply.code(404);
    return { error: "File not found" };
  }

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
  if (!asset) {
    reply.code(404);
    return { error: "Not found" };
  }
  const fp = resolveFilePath(asset);
  if (!fp) {
    reply.code(404);
    return { error: "File not found" };
  }

  try {
    const full = await sharp(fp).rotate().jpeg({ quality: 90 }).toBuffer();
    reply.type("image/jpeg").header("Cache-Control", "public, max-age=3600");
    return full;
  } catch (e: any) {
    reply.code(500);
    return { error: e.message };
  }
});

// === LLM Batch endpoints ===

let sessionBatches: SessionBatch[] = [];
let llmClient: LlmClient | null = null;

/** List all session batches */
app.get("/api/batches", async () => {
  return (
    sessionBatches
      .map((b) => {
        const fp = batchFingerprint(b.assets.map((a) => a.id));
        const cached = stateDb.getLlmRun(b.id, fp);
        return {
          id: b.id,
          source: b.source,
          folderName: b.folderName,
          count: b.assets.length,
          dateRange: { start: b.dateRange.start.toISOString(), end: b.dateRange.end.toISOString() },
          hasLlmResult: cached !== null,
          viewStatus: stateDb.getViewStatus(b.id),
        };
      })
      // Sort: LLM-processed first, then by date
      .toSorted((a: any, b: any) => {
        if (a.hasLlmResult && !b.hasLlmResult) return -1;
        if (!a.hasLlmResult && b.hasLlmResult) return 1;
        return 0; // preserve date order within each group
      })
  );
});

/** Get a batch with its LLM results (if available) */
app.get<{ Params: { id: string } }>("/api/batches/:id", async (req) => {
  const batch = sessionBatches.find((b) => b.id === req.params.id);
  if (!batch) return { error: "Not found" };

  const fp = batchFingerprint(batch.assets.map((a) => a.id));
  const cached = stateDb.getLlmRun(batch.id, fp);
  let llmResult: any = null;
  if (cached) {
    try {
      const raw = JSON.parse(cached.responseJson);
      // Expand compact format to full format for the UI
      llmResult = {
        batchSummary: raw.sum ?? raw.batchSummary ?? "",
        overallConfidence: raw.conf ?? raw.overallConfidence ?? 0,
        images: (raw.img ?? raw.images ?? [])
          .map((img: any) => {
            if (Array.isArray(img)) {
              const [idx, stars, cat, note, sg, kc] = img;
              const asset = batch.assets[idx];
              return {
                imageId: asset?.id ?? `unknown-${idx}`,
                suggestedStars: stars ?? 0,
                categories: typeof cat === "string" ? [cat] : (cat ?? []),
                briefNote: note ?? "",
                similaritySubgroupId: sg ?? null,
                llmKeepCull: kc === "k" ? "keep" : kc === "c" ? "cull" : null,
              };
            }
            return img;
          })
          .filter((img: any) => img && !String(img.imageId).startsWith("unknown-")),
        similaritySubgroups: (raw.sg ?? raw.similaritySubgroups ?? []).map((sg: any) => {
          const mapIdx = (idx: number) => batch.assets[idx]?.id ?? `unknown-${idx}`;
          const allIds = (sg.all ?? sg.imageIds ?? []).map((v: any) =>
            typeof v === "number" ? mapIdx(v) : v,
          );
          const rawKeepIds = new Set(
            (sg.keep ?? sg.recommendedKeepIds ?? []).map((v: any) =>
              typeof v === "number" ? mapIdx(v) : v,
            ),
          );
          // Guardrail: enforce ceiling of ceil(N*0.5) keeps per subgroup
          // Use allIds order (best-first) to pick which to keep
          const maxKeep = Math.max(1, Math.ceil(allIds.length * 0.5));
          let keepIds = allIds.filter((id: string) => rawKeepIds.has(id));
          if (keepIds.length > maxKeep && allIds.length >= 3) {
            keepIds = keepIds.slice(0, maxKeep);
          }
          return {
            subgroupId: sg.id ?? sg.subgroupId ?? "",
            imageIds: allIds,
            subgroupType: sg.type ?? sg.subgroupType ?? "scene",
            recommendedKeepCount: keepIds.length,
            recommendedKeepIds: keepIds,
            cullIds: allIds.filter((id: string) => !keepIds.includes(id)),
            rationale: sg.why ?? sg.rationale ?? "",
          };
        }),
      };
    } catch {}
  }

  return {
    id: batch.id,
    source: batch.source,
    folderName: batch.folderName,
    count: batch.assets.length,
    dateRange: {
      start: batch.dateRange.start.toISOString(),
      end: batch.dateRange.end.toISOString(),
    },
    assets: await Promise.all(
      batch.assets.map(async (a) => {
        const dims = await getDimensions(a);
        return {
          id: a.id,
          filename: a.filename,
          date: a.fileCreatedAt.toISOString(),
          rating: a.rating,
          bytes: getFileSize(a),
          w: dims.w,
          h: dims.h,
        };
      }),
    ),
    llm: llmResult,
  };
});

/** Run LLM on a batch */
app.post<{ Params: { id: string } }>("/api/batches/:id/rank", async (req) => {
  const batch = sessionBatches.find((b) => b.id === req.params.id);
  if (!batch) return { error: "Not found" };
  if (!llmClient) return { error: "No LLM client configured (need --vertex or OPENROUTER key)" };

  const fp = batchFingerprint(batch.assets.map((a) => a.id));

  // Check cache
  const cached = stateDb.getLlmRun(batch.id, fp);
  if (cached) {
    return { cached: true, response: JSON.parse(cached.responseJson) };
  }

  try {
    const { response, rawJson, inputTokens, outputTokens } = await llmClient.rankBatch(
      batch,
      resolveFilePath,
      (s) => console.log(`  [LLM] ${s}`),
    );

    // Store in DB
    stateDb.saveLlmRun(batch.id, fp, modelArg, "v3", rawJson, inputTokens, outputTokens);

    return { cached: false, response, inputTokens, outputTokens };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [LLM] Error: ${msg}`);
    return { error: msg };
  }
});

/** Delete cached LLM result for a batch (to allow re-run) */
app.delete<{ Params: { id: string } }>("/api/batches/:id/rank", async (req) => {
  const batch = sessionBatches.find((b) => b.id === req.params.id);
  if (!batch) return { error: "Not found" };
  const fp = batchFingerprint(batch.assets.map((a) => a.id));
  stateDb.deleteLlmRun(batch.id, fp);
  return { ok: true };
});

// === View status ===

app.post<{ Params: { id: string }; Body: { viewType: string; status: string } }>(
  "/api/view-status/:id",
  async (req) => {
    stateDb.setViewStatus(req.params.id, req.body.viewType, req.body.status);
    return { ok: true };
  },
);

// === Per-photo decisions (shared across all views) ===

/** Save decisions for multiple photos */
app.post<{
  Body: { decisions: Array<{ assetId: string; state: string | null; userStars: number | null }> };
}>("/api/photos/decisions", async (req) => {
  stateDb.savePhotoDecisions(req.body.decisions);
  return { ok: true, count: req.body.decisions.length };
});

/** Get decisions for a list of photos */
app.post<{ Body: { assetIds: string[] } }>("/api/photos/decisions/get", async (req) => {
  return stateDb.getPhotoDecisions(req.body.assetIds);
});

app.get("/", async (_, reply) => {
  reply.type("text/html");
  return readFileSync(resolve(__dirname, "../web/index.html"), "utf-8");
});

await loadData();

// Build session batches from loaded assets
const allAssets = [...assetMap.values()];
sessionBatches = batchBySession(allAssets);
console.log(`${sessionBatches.length} session batches`);

// Initialize LLM client
const modelArg =
  args.find((a) => a.startsWith("--model="))?.split("=")[1] ?? "gemini-2.5-flash-lite";
const orKeyPath = resolve("/home/odin/Kode/miniapps/babysovelogg/OPENROUTER.key");
if (args.includes("--vertex")) {
  llmClient = new LlmClient({
    apiKey: "",
    provider: "vertexai",
    model: modelArg,
    vertexProject: "tagrdevin",
  });
  console.log(`LLM: Vertex AI (tagrdevin) — ${modelArg}`);
} else if (existsSync(orKeyPath)) {
  const orModel = modelArg.startsWith("google/") ? modelArg : `google/${modelArg}`;
  llmClient = new LlmClient({
    apiKey: readFileSync(orKeyPath, "utf-8").trim(),
    provider: "openrouter",
    model: orModel,
  });
  console.log(`LLM: OpenRouter — ${orModel}`);
} else {
  console.log("LLM: not configured (use --vertex or provide OpenRouter key)");
}

await app.listen({ port, host: "0.0.0.0" });
console.log(`\nReview UI: http://localhost:${port}`);
console.log(`Network:   http://192.168.10.88:${port}`);
