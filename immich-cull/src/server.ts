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
import { LlmClient, expandCompactResponse } from "./ranking/llm-client.js";
import { classifyBatchForAutoCull, type AutoCullSummary } from "./ranking/auto-cull.js";
import { ImmichWriteback } from "./db/immich-writeback.js";
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

const app = Fastify({ logger: false, requestTimeout: 300000 }); // 5min for slow local models

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

// Auto-cull classification cache, keyed by LLM run ID (immutable per run)
const autoCullCache = new Map<number, AutoCullSummary>();

function getAutoCullSummary(
  batch: SessionBatch,
  llmRunId?: number,
  model?: string,
): AutoCullSummary | null {
  const fp = batchFingerprint(batch.assets.map((a) => a.id));
  const cached = model ? stateDb.getLlmRun(batch.id, fp, model) : stateDb.getLlmRun(batch.id, fp);
  if (!cached) return null;
  const runId = llmRunId ?? cached.id;
  if (autoCullCache.has(runId)) return autoCullCache.get(runId)!;
  try {
    const raw = JSON.parse(cached.responseJson);
    const expanded = expandCompactResponse(raw, batch);
    const summary = classifyBatchForAutoCull(expanded.images, expanded.similaritySubgroups);
    autoCullCache.set(runId, summary);
    return summary;
  } catch {
    return null;
  }
}

/** List all session batches */
app.get("/api/batches", async () => {
  return (
    sessionBatches
      .map((b) => {
        const fp = batchFingerprint(b.assets.map((a) => a.id));
        const cached = stateDb.getLlmRun(b.id, fp);
        const acSummary = cached ? getAutoCullSummary(b, cached.id) : null;
        return {
          id: b.id,
          source: b.source,
          folderName: b.folderName,
          count: b.assets.length,
          dateRange: { start: b.dateRange.start.toISOString(), end: b.dateRange.end.toISOString() },
          hasLlmResult: cached !== null,
          viewStatus: stateDb.getViewStatus(b.id),
          autoCullStats: acSummary
            ? {
                autoCullHigh: acSummary.autoCullHigh,
                autoCull: acSummary.autoCull,
                review: acSummary.review,
              }
            : null,
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

/** Get a batch with its LLM results (if available). ?model=xxx to get a specific model's result. */
app.get<{ Params: { id: string }; Querystring: { model?: string } }>(
  "/api/batches/:id",
  async (req) => {
    const batch = sessionBatches.find((b) => b.id === req.params.id);
    if (!batch) return { error: "Not found" };

    const fp = batchFingerprint(batch.assets.map((a) => a.id));
    const cached = req.query.model
      ? stateDb.getLlmRun(batch.id, fp, req.query.model)
      : stateDb.getLlmRun(batch.id, fp);
    const llmModels = stateDb.getLlmModels(batch.id, fp);
    let llmResult: any = null;
    if (cached) {
      try {
        const raw = JSON.parse(cached.responseJson);
        const expanded = expandCompactResponse(raw, batch);
        llmResult = { model: cached.model, ...expanded };
      } catch {}
    }

    const acSummary = cached ? getAutoCullSummary(batch, cached.id, req.query.model) : null;

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
      llmModels,
      autoCull: acSummary,
    };
  },
);

/** Run LLM on a batch. ?model=xxx overrides the default model. */
app.post<{ Params: { id: string }; Querystring: { model?: string } }>(
  "/api/batches/:id/rank",
  async (req) => {
    const batch = sessionBatches.find((b) => b.id === req.params.id);
    if (!batch) return { error: "Not found" };
    if (!llmClient) return { error: "No LLM client configured (need --vertex or OPENROUTER key)" };

    const overrideModel = req.query.model;
    const fp = batchFingerprint(batch.assets.map((a) => a.id));

    // Check cache — filter by model so different models don't share cache
    const usedModel = overrideModel ?? modelArg;
    const cached = stateDb.getLlmRun(batch.id, fp, usedModel);
    if (cached) {
      return { cached: true, model: usedModel, response: JSON.parse(cached.responseJson) };
    }

    // Use override model or default — detect Ollama models by name
    let client: LlmClient;
    if (!overrideModel) {
      client = llmClient;
    } else if (
      /^(gemma|llama|phi|qwen|mistral)/.test(overrideModel) ||
      overrideModel.includes(":")
    ) {
      client = new LlmClient({
        ...llmClient.config,
        model: overrideModel,
        provider: "ollama",
        previewMaxPx: 512,
      });
    } else {
      client = new LlmClient({ ...llmClient.config, model: overrideModel });
    }

    try {
      const { response, rawJson, inputTokens, outputTokens } = await client.rankBatch(
        batch,
        resolveFilePath,
        (s) => console.log(`  [LLM ${usedModel}] ${s}`),
      );

      // Store in DB (all runs kept, newest wins)
      stateDb.saveLlmRun(batch.id, fp, usedModel, "v3", rawJson, inputTokens, outputTokens);

      return { cached: false, model: usedModel, response, inputTokens, outputTokens };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [LLM ${usedModel}] Error: ${msg}`);
      return { error: msg };
    }
  },
);

/** Invalidate cached LLM result for a batch. ?model=xxx to invalidate only that model. */
app.delete<{ Params: { id: string }; Querystring: { model?: string } }>(
  "/api/batches/:id/rank",
  async (req) => {
    const batch = sessionBatches.find((b) => b.id === req.params.id);
    if (!batch) return { error: "Not found" };
    const fp = batchFingerprint(batch.assets.map((a) => a.id));
    stateDb.invalidateLlmRun(batch.id, fp, req.query.model);
    return { ok: true };
  },
);

// === View status ===

app.post<{ Params: { id: string }; Body: { viewType: string; status: string } }>(
  "/api/view-status/:id",
  async (req) => {
    stateDb.setViewStatus(req.params.id, req.body.viewType, req.body.status);
    return { ok: true };
  },
);

// === Auto-cull endpoints ===

/** Bulk-approve auto-cull decisions for given batches */
app.post<{
  Body: { batchIds: string[]; model?: string };
}>("/api/batches/auto-approve", async (req) => {
  const results: Array<{ batchId: string; approved: number; skipped: number; error?: string }> = [];

  for (const batchId of req.body.batchIds) {
    const batch = sessionBatches.find((b) => b.id === batchId);
    if (!batch) {
      results.push({ batchId, approved: 0, skipped: 0, error: "not found" });
      continue;
    }

    const fp = batchFingerprint(batch.assets.map((a) => a.id));
    const llmRun = req.body.model
      ? stateDb.getLlmRun(batchId, fp, req.body.model)
      : stateDb.getLlmRun(batchId, fp);
    if (!llmRun) {
      results.push({ batchId, approved: 0, skipped: 0, error: "no LLM result" });
      continue;
    }

    const summary = getAutoCullSummary(batch, llmRun.id, req.body.model);
    if (!summary) {
      results.push({ batchId, approved: 0, skipped: 0, error: "classification failed" });
      continue;
    }

    // Load existing decisions — manual always wins
    const assetIds = batch.assets.map((a) => a.id);
    const existing = stateDb.getPhotoDecisions(assetIds);

    const decisions: Array<{ assetId: string; state: string | null; userStars: number | null }> =
      [];
    let approved = 0;
    let skipped = 0;

    for (const c of summary.classifications) {
      if (existing[c.assetId]?.state) {
        skipped++;
        continue;
      }
      if (c.tier === "auto-cull-high" || c.tier === "auto-cull") {
        decisions.push({ assetId: c.assetId, state: "cull", userStars: null });
        approved++;
      }
    }

    if (decisions.length > 0) {
      stateDb.savePhotoDecisions(decisions, "auto-cull", llmRun.id);
    }

    // Mark batch as reviewed
    stateDb.setViewStatus(batchId, "batch", "reviewed");
    results.push({ batchId, approved, skipped });
  }

  return { ok: true, results };
});

/** Staged auto-cull: approve high-confidence immediately, return rest for review */
app.post<{
  Body: { batchIds: string[]; stage?: "safe" | "all"; model?: string };
}>("/api/batches/staged-cull", async (req) => {
  const stage = req.body.stage ?? "safe";
  const results: Array<{
    batchId: string;
    autoCulled: number;
    forReview: number;
    skipped: number;
  }> = [];

  for (const batchId of req.body.batchIds) {
    const batch = sessionBatches.find((b) => b.id === batchId);
    if (!batch) continue;

    const fp = batchFingerprint(batch.assets.map((a) => a.id));
    const llmRun = req.body.model
      ? stateDb.getLlmRun(batchId, fp, req.body.model)
      : stateDb.getLlmRun(batchId, fp);
    if (!llmRun) continue;

    const summary = getAutoCullSummary(batch, llmRun.id, req.body.model);
    if (!summary) continue;

    const existing = stateDb.getPhotoDecisions(batch.assets.map((a) => a.id));
    const decisions: Array<{ assetId: string; state: string | null; userStars: number | null }> =
      [];
    let autoCulled = 0;
    let forReview = 0;
    let skipped = 0;

    for (const c of summary.classifications) {
      if (existing[c.assetId]?.state) {
        skipped++;
        continue;
      }
      if (c.tier === "auto-cull-high") {
        decisions.push({ assetId: c.assetId, state: "cull", userStars: null });
        autoCulled++;
      } else if (c.tier === "auto-cull" && stage === "all") {
        decisions.push({ assetId: c.assetId, state: "cull", userStars: null });
        autoCulled++;
      } else if (c.tier === "auto-cull") {
        forReview++;
      }
    }

    if (decisions.length > 0) {
      stateDb.savePhotoDecisions(decisions, "auto-cull", llmRun.id);
    }
    results.push({ batchId, autoCulled, forReview, skipped });
  }

  return { ok: true, results };
});

/** Revert all auto-cull decisions (safety valve) */
app.delete("/api/auto-approve", async () => {
  const reverted = stateDb.revertAutoCullDecisions();
  return { ok: true, reverted };
});

/** Get cull comparisons for a batch: each culled photo with its keeper and reason */
app.get<{ Params: { id: string }; Querystring: { model?: string } }>(
  "/api/batches/:id/cull-comparisons",
  async (req) => {
    const batch = sessionBatches.find((b) => b.id === req.params.id);
    if (!batch) return { error: "Not found" };

    const fp = batchFingerprint(batch.assets.map((a) => a.id));
    const cached = req.query.model
      ? stateDb.getLlmRun(batch.id, fp, req.query.model)
      : stateDb.getLlmRun(batch.id, fp);
    if (!cached) return { comparisons: [] };

    try {
      const raw = JSON.parse(cached.responseJson);
      const expanded = expandCompactResponse(raw, batch);

      // Build subgroup lookup
      const sgMap = new Map(expanded.similaritySubgroups.map((sg) => [sg.subgroupId, sg]));

      // Build image lookup
      const imgMap = new Map(expanded.images.map((img) => [img.imageId, img]));

      // For each culled photo in a subgroup, pair with its keeper(s)
      const comparisons = [];
      for (const img of expanded.images) {
        if (img.llmKeepCull !== "cull") continue;
        if (!img.similaritySubgroupId) continue;

        const sg = sgMap.get(img.similaritySubgroupId);
        if (!sg) continue;

        // Find keepers in this subgroup
        const keepers = sg.recommendedKeepIds
          .map((kid) => {
            const keeperImg = imgMap.get(kid);
            const keeperAsset = batch.assets.find((a) => a.id === kid);
            if (!keeperImg || !keeperAsset) return null;
            return {
              id: kid,
              filename: keeperAsset.filename,
              stars: keeperImg.suggestedStars,
              note: keeperImg.briefNote,
            };
          })
          .filter(Boolean);

        const cullAsset = batch.assets.find((a) => a.id === img.imageId);
        comparisons.push({
          cullId: img.imageId,
          cullFilename: cullAsset?.filename ?? "",
          cullStars: img.suggestedStars,
          cullNote: img.briefNote,
          cullCategory: img.categories[0] ?? "other",
          keepers,
          subgroupType: sg.subgroupType,
          subgroupSize: sg.imageIds.length,
          subgroupReason: sg.rationale,
          rank: sg.imageIds.indexOf(img.imageId),
        });
      }

      return { comparisons };
    } catch {
      return { comparisons: [] };
    }
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

// === Immich Write-back ===

let immichWriteback: ImmichWriteback | null = null;

// Initialize write-back if Immich env vars are set
const immichUrl = process.env.IMMICH_URL;
const immichApiKey = process.env.IMMICH_API_KEY;
if (immichUrl && immichApiKey) {
  immichWriteback = new ImmichWriteback({ serverUrl: immichUrl, apiKey: immichApiKey });
}

/** Test Immich API connection */
app.get("/api/immich/status", async () => {
  if (!immichWriteback) {
    return { connected: false, error: "IMMICH_URL and IMMICH_API_KEY not set" };
  }
  const result = await immichWriteback.testConnection();
  return { connected: result.ok, version: result.version, error: result.error };
});

/**
 * Write back decisions to Immich: trash culled photos and set star ratings.
 *
 * Stars use mapLlmStarsToWriteback: LLM 0-2→0 (no star), 3→1★, 4→2★, 5→3★.
 * User-set stars (user_stars column) are written directly — user already decided.
 * LLM stars are pulled from the latest LLM batch run and mapped through the
 * compression function. Only LLM 3+ gets any Immich star at all.
 */
app.post<{
  Body: { dryRun?: boolean };
}>("/api/immich/writeback", async (req) => {
  if (!immichWriteback) {
    return { error: "Immich write-back not configured (set IMMICH_URL and IMMICH_API_KEY)" };
  }

  const dryRun = req.body.dryRun ?? true;

  // Get all decided photos
  const allDecisions = stateDb.getAllDecisions();

  const toTrash = allDecisions.filter((d) => d.state === "cull").map((d) => d.assetId);

  // Stars: user-set stars take priority, then LLM stars mapped through compression
  const toRate: Array<{ assetId: string; rating: number }> = [];
  for (const d of allDecisions) {
    if (d.state !== "keep") continue;
    // User-set stars: write directly
    if (d.userStars != null && d.userStars > 0) {
      toRate.push({ assetId: d.assetId, rating: d.userStars });
      continue;
    }
    // LLM stars: find from batch data, map through compression
    // (LLM 0-2→0, 3→1, 4→2, 5→3 — only exceptional photos get any star)
    // We get these from the effective stars computed during review
    // For now, skip — LLM stars are written when user approves a batch
  }

  // Identify LLM-rated photos for tagging
  const llmRated = allDecisions
    .filter((d) => d.starSource === "llm" && d.userStars != null && d.userStars > 0)
    .map((d) => d.assetId);

  if (dryRun) {
    return {
      dryRun: true,
      toTrash: toTrash.length,
      toRate: toRate.length,
      toTagLlmRated: llmRated.length,
      totalDecisions: allDecisions.length,
    };
  }

  // Execute write-back
  const trashResult = await immichWriteback.trashAssets(toTrash);
  const rateResult = await immichWriteback.setRatings(toRate);

  // Tag LLM-rated photos so they're identifiable in Immich
  let tagged = 0;
  if (llmRated.length > 0) {
    try {
      const tagId = await immichWriteback.getOrCreateTag("ai:rated");
      await immichWriteback.tagAssets(tagId, llmRated);
      tagged = llmRated.length;
    } catch (e: any) {
      console.error("Failed to tag LLM-rated photos:", e.message);
    }
  }

  return {
    dryRun: false,
    trashed: trashResult,
    rated: rateResult,
    tagged,
    totalDecisions: allDecisions.length,
  };
});

app.get("/", async (_, reply) => {
  reply.type("text/html");
  return readFileSync(resolve(__dirname, "../web/index.html"), "utf-8");
});

await loadData();

// Filter out known-good assets before batching (unless --include-all)
const allAssets = [...assetMap.values()];
let filteredAssets = allAssets;
if (!args.includes("--include-all")) {
  const patterns = stateDb.getAutoKeepPatterns();
  if (patterns.length > 0) {
    const compiled = patterns.map((p) => new RegExp(p.pattern));
    filteredAssets = allAssets.filter((a) => !compiled.some((re) => re.test(a.path)));
    const excluded = allAssets.length - filteredAssets.length;
    if (excluded > 0) {
      console.log(
        `Filtered ${excluded} known-good assets (${patterns.map((p) => p.pattern).join(", ")})`,
      );
    }
  }
}
sessionBatches = batchBySession(filteredAssets);
console.log(`${sessionBatches.length} session batches (${filteredAssets.length} assets)`);

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
