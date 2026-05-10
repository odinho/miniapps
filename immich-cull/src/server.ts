/**
 * Review server: Fastify API + static file serving for the review UI.
 * Connects to Immich via REST API (--immich-api).
 */
import Fastify from "fastify";
import { resolve, dirname } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { ImmichApiAdapter } from "./db/immich-api-adapter.js";
import { ImmichFaceFetcher } from "./db/immich-face-fetcher.js";
import { Asset } from "./shared/types.js";
import { fileURLToPath } from "url";
import { StateDb, batchFingerprint } from "./db/state-db.js";
import { batchBySession, SessionBatch } from "./batching/session-batcher.js";
import { LlmClient, DEFAULT_LLM_CONFIG, expandCompactResponse } from "./ranking/llm-client.js";
import { mapLlmStarsToWriteback } from "./ranking/types.js";
import { classifyBatchForAutoCull, type AutoCullSummary } from "./ranking/auto-cull.js";
import { applyFaceCoveragePostCheck } from "./ranking/face-coverage.js";
import { classifyBurstAutoCull } from "./ranking/burst-auto-cull.js";
import { ImmichWriteback } from "./db/immich-writeback.js";
import { config as loadEnv } from "dotenv";
loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function getArg(flag: string, defaultVal: string): string {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : defaultVal;
}

const port = parseInt(getArg("--port", "3000"));

const app = Fastify({ logger: false, requestTimeout: 300000 }); // 5min for slow local models

// State
let assetMap = new Map<string, Asset>();
let fileSizeCache = new Map<string, number>();
let dimensionCache = new Map<string, { w: number; h: number }>();
const stateDbPath = getArg("--state-db", resolve(__dirname, "../data/state.db"));
const stateDb = new StateDb(stateDbPath);

/** Resolve the file path on the local filesystem */
/** Get file size in bytes */
function getFileSize(asset: Asset): number {
  if (fileSizeCache.has(asset.id)) return fileSizeCache.get(asset.id)!;
  const size = asset.fileSize ?? 0;
  fileSizeCache.set(asset.id, size);
  return size;
}

/** Get image dimensions */
function getDimensions(asset: Asset): { w: number; h: number } {
  if (dimensionCache.has(asset.id)) return dimensionCache.get(asset.id)!;
  const dims = { w: asset.width ?? 4, h: asset.height ?? 3 };
  dimensionCache.set(asset.id, dims);
  return dims;
}

let immichApiAdapter: ImmichApiAdapter | null = null;

async function loadData() {
  const url = process.env.IMMICH_URL;
  const key = process.env.IMMICH_API_KEY;
  if (!url || !key) {
    console.error("IMMICH_URL and IMMICH_API_KEY env vars are required");
    process.exit(1);
  }
  console.log(`Connecting to Immich API at ${url}...`);
  immichApiAdapter = new ImmichApiAdapter({ serverUrl: url, apiKey: key });
  if (faceCoverageEnabled) {
    faceFetcher = new ImmichFaceFetcher(url, key);
    console.log(`Face-coverage post-check enabled (set DISABLE_FACE_COVERAGE=1 to bypass)`);
  } else {
    console.log(`Face-coverage post-check DISABLED via env`);
  }

  // Cache asset list to disk — only fetch new/updated assets on subsequent starts
  const cachePath = resolve(__dirname, "../data/immich-assets-cache.json");
  let cachedAssets: Asset[] = [];
  let newestDate: Date | null = null;
  let assets: Asset[] = [];

  if (existsSync(cachePath)) {
    try {
      const raw = JSON.parse(readFileSync(cachePath, "utf-8"));
      cachedAssets = raw.map((a: any) => ({
        ...a,
        fileCreatedAt: new Date(a.fileCreatedAt),
        embedding: new Float32Array(0),
      }));
      newestDate = cachedAssets.reduce(
        (max, a) => (a.fileCreatedAt > max ? a.fileCreatedAt : max),
        new Date(0),
      );
      console.log(
        `Cache: ${cachedAssets.length} assets (newest: ${newestDate.toISOString().slice(0, 10)})`,
      );
    } catch {
      cachedAssets = [];
    }
  }

  if (cachedAssets.length > 0) {
    // Fetch only assets newer than cache (with 1-day buffer for edge cases)
    const fetchSince = new Date(newestDate!.getTime() - 86400_000);
    console.log("Fetching new assets since cache...");
    const newAssets = await immichApiAdapter.getAssetsByDateRange(fetchSince, new Date(), (n) =>
      process.stdout.write(`\r  ${n} new...`),
    );
    console.log();
    // Merge: start from cache, add/update with new
    const merged = new Map(cachedAssets.map((a) => [a.id, a]));
    let added = 0;
    for (const a of newAssets) {
      if (!merged.has(a.id)) added++;
      merged.set(a.id, a);
    }
    assets = [...merged.values()];
    console.log(`${added} new, ${newAssets.length - added} updated, ${assets.length} total`);
  } else {
    const count = await immichApiAdapter.getAssetCount();
    console.log(`Immich has ${count} images`);
    console.log("Loading all assets via API...");
    assets = await immichApiAdapter.getAllAssets((loaded) => {
      process.stdout.write(`\r  ${loaded} loaded...`);
    });
    console.log();
  }

  // Update cache (strip embedding — always empty in API mode)
  const toCache = assets.map((a) => ({ ...a, embedding: undefined }));
  writeFileSync(cachePath, JSON.stringify(toCache));
  console.log(`Cached ${assets.length} assets`);

  console.log(`Loaded ${assets.length} assets`);

  for (const a of assets) assetMap.set(a.id, a);
}

// === API Routes ===

app.get("/api/stats", async () => {
  const s = stateDb.getStats();
  return {
    photosToKeep: s.photosKept,
    photosToCull: s.photosCulled,
    cullBytes: stateDb
      .getCulledAssetIds()
      .reduce((sum, id) => sum + (assetMap.has(id) ? getFileSize(assetMap.get(id)!) : 0), 0),
  };
});

/** Preview: proxy thumbnail from Immich */
app.get<{ Querystring: { id: string; size?: string } }>("/api/preview", async (req, reply) => {
  const asset = assetMap.get(req.query.id);
  if (!asset) {
    reply.code(404);
    return { error: "Not found" };
  }

  const size = req.query.size === "thumbnail" ? "thumbnail" : "preview";
  try {
    const buf = await immichApiAdapter!.getThumbnail(asset.id, size);
    reply.type("image/jpeg").header("Cache-Control", "public, max-age=3600");
    return buf;
  } catch (e: any) {
    reply.code(500);
    return { error: e.message };
  }
});

/** Full-size original from Immich */
app.get<{ Querystring: { id: string } }>("/api/full", async (req, reply) => {
  const asset = assetMap.get(req.query.id);
  if (!asset) {
    reply.code(404);
    return { error: "Not found" };
  }

  try {
    const buf = await immichApiAdapter!.getOriginal(asset.id);
    reply.type("image/jpeg").header("Cache-Control", "public, max-age=3600");
    return buf;
  } catch (e: any) {
    reply.code(500);
    return { error: e.message };
  }
});

// === LLM Batch endpoints ===

let sessionBatches: SessionBatch[] = [];
let llmClient: LlmClient | null = null;

// Face-coverage post-check. Enabled by default; set DISABLE_FACE_COVERAGE=1 to bypass.
// Validated on 80 graded batches: 96.2% → 97.5% acceptable-rate, 3 → 2 sev-2.
let faceFetcher: ImmichFaceFetcher | null = null;
const faceCoverageEnabled = process.env.DISABLE_FACE_COVERAGE !== "1";

// Auto-cull classification cache, keyed by LLM run ID (immutable per run).
// Face-cover applied lazily inside getAutoCullSummary and reflected in this cache.
const autoCullCache = new Map<number, AutoCullSummary>();

async function getAutoCullSummary(
  batch: SessionBatch,
  llmRunId?: number,
  model?: string,
): Promise<AutoCullSummary | null> {
  const fp = batchFingerprint(batch.assets.map((a) => a.id));
  const cached = model ? stateDb.getLlmRun(batch.id, fp, model) : stateDb.getLlmRun(batch.id, fp);
  if (!cached) return null;
  const runId = llmRunId ?? cached.id;
  if (autoCullCache.has(runId)) return autoCullCache.get(runId)!;
  try {
    const raw = JSON.parse(cached.responseJson);
    const expanded = expandCompactResponse(raw, batch);

    // Face-coverage post-check: promote culls to keeps when needed to cover named people.
    // Non-blocking failures — we'd rather classify without face-cover than 500.
    let images = expanded.images;
    if (faceCoverageEnabled && faceFetcher) {
      try {
        const assetIds = images.map((i) => i.imageId);
        const people = await faceFetcher.fetchPeopleForAssets(assetIds);
        const fc = applyFaceCoveragePostCheck(images, people);
        images = fc.images;
      } catch (err) {
        console.warn(`face-coverage skipped for batch ${batch.id}:`, err);
      }
    }

    const summary = classifyBatchForAutoCull(images, expanded.similaritySubgroups);
    autoCullCache.set(runId, summary);
    return summary;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Multi-model agreement helpers
// ---------------------------------------------------------------------------

interface BatchAgreementStats {
  modelCount: number;
  unanimousKeep: number;
  unanimousCull: number;
  disagreements: number;
  total: number;
  agreementPct: number;
  tier: "full-agreement" | "partial-agreement" | "single-model" | "unrated";
  /** Per-photo consensus for batch detail view */
  photos: Array<{ assetId: string; consensus: "keep" | "cull" | "disagree"; unanimous: boolean }>;
}

const agreementCache = new Map<string, BatchAgreementStats>();

function computeBatchAgreement(batch: SessionBatch): BatchAgreementStats | null {
  const fp = batchFingerprint(batch.assets.map((a) => a.id));
  const allRuns = stateDb.getAllLlmRuns(batch.id, fp);

  if (allRuns.length === 0) return null;
  if (allRuns.length === 1) {
    return {
      modelCount: 1,
      unanimousKeep: 0,
      unanimousCull: 0,
      disagreements: 0,
      total: batch.assets.length,
      agreementPct: 0,
      tier: "single-model",
      photos: [],
    };
  }

  // Cache key: sorted run IDs
  const cacheKey = allRuns
    .map((r) => r.id)
    .toSorted()
    .join(",");
  if (agreementCache.has(cacheKey)) return agreementCache.get(cacheKey)!;

  // Parse each model's keep/cull decisions
  const modelDecisions = new Map<string, Map<string, string>>();
  for (const run of allRuns) {
    try {
      const raw = JSON.parse(run.responseJson);
      const expanded = expandCompactResponse(raw, batch);
      const decisions = new Map<string, string>();
      for (const img of expanded.images) {
        if (img.llmKeepCull) decisions.set(img.imageId, img.llmKeepCull);
      }
      modelDecisions.set(run.model, decisions);
    } catch {
      /* skip unparseable */
    }
  }

  const models = [...modelDecisions.keys()];
  if (models.length < 2) return null;

  let unanimousKeep = 0;
  let unanimousCull = 0;
  let disagreements = 0;
  const photos: BatchAgreementStats["photos"] = [];

  for (const asset of batch.assets) {
    let keepVotes = 0;
    let cullVotes = 0;
    for (const model of models) {
      const d = modelDecisions.get(model)?.get(asset.id);
      if (d === "keep") keepVotes++;
      else if (d === "cull") cullVotes++;
    }
    const totalVotes = keepVotes + cullVotes;
    let consensus: "keep" | "cull" | "disagree";
    let isUnanimous = false;
    // Majority wins: strict majority (>50%) decides; ties are disagreements
    if (totalVotes > 0 && keepVotes > cullVotes) {
      consensus = "keep";
      isUnanimous = cullVotes === 0;
      unanimousKeep++;
    } else if (totalVotes > 0 && cullVotes > keepVotes) {
      consensus = "cull";
      isUnanimous = keepVotes === 0;
      unanimousCull++;
    } else {
      consensus = "disagree";
      disagreements++;
    }
    photos.push({ assetId: asset.id, consensus, unanimous: isUnanimous });
  }

  const total = batch.assets.length;
  const agreed = unanimousKeep + unanimousCull;
  const agreementPct = total > 0 ? Math.round((agreed / total) * 100) : 0;
  const tier = disagreements === 0 ? "full-agreement" : "partial-agreement";

  const result: BatchAgreementStats = {
    modelCount: models.length,
    unanimousKeep,
    unanimousCull,
    disagreements,
    total,
    agreementPct,
    tier,
    photos,
  };
  agreementCache.set(cacheKey, result);
  return result;
}

// ---------------------------------------------------------------------------
// Auto-mark batch as reviewed when all photos have decisions
// ---------------------------------------------------------------------------

let assetToBatch: Map<string, string> | null = null;

function getAssetToBatch(): Map<string, string> {
  if (!assetToBatch) {
    assetToBatch = new Map();
    for (const batch of sessionBatches) {
      for (const asset of batch.assets) {
        assetToBatch.set(asset.id, batch.id);
      }
    }
  }
  return assetToBatch;
}

function checkAndAutoMarkBatch(batchId: string) {
  const batch = sessionBatches.find((b) => b.id === batchId);
  if (!batch) return;
  const currentStatus = stateDb.getViewStatus(batchId);
  if (currentStatus === "reviewed" || currentStatus === "skipped") return;
  const assetIds = batch.assets.map((a) => a.id);
  const decisions = stateDb.getPhotoDecisions(assetIds);
  const allDecided = assetIds.every((id) => decisions[id]?.state != null);
  if (allDecided) {
    stateDb.setViewStatus(batchId, "batch", "reviewed");
  }
}

/** List all session batches */
app.get("/api/batches", async () => {
  const recentlyReviewed = stateDb.getRecentlyReviewed("batch", 3);
  const modelCounts = stateDb.getBatchModelCounts();
  const items = await Promise.all(
    sessionBatches.map(async (b) => {
      const fp = batchFingerprint(b.assets.map((a) => a.id));
      const cached = stateDb.getLlmRun(b.id, fp);
      const acSummary = cached ? await getAutoCullSummary(b, cached.id) : null;
      // Get keep/cull counts: user decisions first, fall back to LLM recommendations
      const decisions = stateDb.getPhotoDecisions(b.assets.map((a) => a.id));
      let keeps = 0;
      let culls = 0;
      const hasUserDecisions = Object.values(decisions).some((d) => d.state);
      if (hasUserDecisions) {
        for (const d of Object.values(decisions)) {
          if (d.state === "keep") keeps++;
          else if (d.state === "cull") culls++;
        }
      } else if (cached) {
        try {
          const raw = JSON.parse(cached.responseJson);
          const expanded = expandCompactResponse(raw, b);
          for (const img of expanded.images) {
            if (img.llmKeepCull === "keep") keeps++;
            else if (img.llmKeepCull === "cull") culls++;
          }
        } catch {
          // ignore parse errors
        }
      }
      // Multi-model agreement (fast-path: skip for single-model batches)
      const mc = modelCounts.get(`${b.id}:${fp}`) ?? 0;
      const agree = mc >= 2 ? computeBatchAgreement(b) : null;

      return {
        id: b.id,
        source: b.source,
        folderName: b.folderName,
        count: b.assets.length,
        dateRange: {
          start: b.dateRange.start.toISOString(),
          end: b.dateRange.end.toISOString(),
        },
        hasLlmResult: cached !== null,
        viewStatus: stateDb.getViewStatus(b.id),
        keeps,
        culls,
        autoCullStats: acSummary
          ? {
              autoCullHigh: acSummary.autoCullHigh,
              autoCull: acSummary.autoCull,
              review: acSummary.review,
            }
          : null,
        agreement: agree
          ? {
              modelCount: agree.modelCount,
              unanimousKeep: agree.unanimousKeep,
              unanimousCull: agree.unanimousCull,
              disagreements: agree.disagreements,
              agreementPct: agree.agreementPct,
              tier: agree.tier,
            }
          : null,
      };
    }),
  );
  // Sort: full-agreement first, then partial, then single-model, then unrated
  const sorted = items.toSorted((a: any, b: any) => {
    const tierOrder: Record<string, number> = {
      "full-agreement": 0,
      "partial-agreement": 1,
      "single-model": 2,
      unrated: 3,
    };
    const aTier = a.agreement?.tier ?? (a.hasLlmResult ? "single-model" : "unrated");
    const bTier = b.agreement?.tier ?? (b.hasLlmResult ? "single-model" : "unrated");
    const aOrd = tierOrder[aTier] ?? 3;
    const bOrd = tierOrder[bTier] ?? 3;
    if (aOrd !== bOrd) return aOrd - bOrd;
    return 0; // preserve date order within tier
  });
  return { batches: sorted, recentlyReviewed };
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
    let faceCoverPromoted: string[] = [];
    if (cached) {
      try {
        const raw = JSON.parse(cached.responseJson);
        const expanded = expandCompactResponse(raw, batch);
        // Apply face-coverage so the UI shows the same picks the auto-cull pipeline uses.
        let images = expanded.images;
        if (faceCoverageEnabled && faceFetcher) {
          try {
            const people = await faceFetcher.fetchPeopleForAssets(images.map((i) => i.imageId));
            const fc = applyFaceCoveragePostCheck(images, people);
            images = fc.images;
            faceCoverPromoted = fc.promoted;
          } catch (err) {
            console.warn(`face-coverage skipped for batch detail ${batch.id}:`, err);
          }
        }
        llmResult = { model: cached.model, ...expanded, images };
      } catch {}
    }

    const acSummary = cached ? await getAutoCullSummary(batch, cached.id, req.query.model) : null;

    return {
      id: batch.id,
      source: batch.source,
      folderName: batch.folderName,
      count: batch.assets.length,
      dateRange: {
        start: batch.dateRange.start.toISOString(),
        end: batch.dateRange.end.toISOString(),
      },
      assets: batch.assets.map((a) => {
        const dims = getDimensions(a);
        return {
          id: a.id,
          filename: a.filename,
          path: a.path,
          date: a.fileCreatedAt.toISOString(),
          rating: a.rating,
          bytes: getFileSize(a),
          w: dims.w,
          h: dims.h,
        };
      }),
      llm: llmResult,
      llmModels,
      autoCull: acSummary,
      faceCoverPromoted,
      photoAgreement: (() => {
        const agree = computeBatchAgreement(batch);
        return agree && agree.modelCount >= 2 ? agree.photos : null;
      })(),
      collapsedGroups: (() => {
        // Find burst-auto-culled photos in this batch and group by keepers
        if (!cached) return [];
        try {
          const raw = JSON.parse(cached.responseJson);
          const expanded = expandCompactResponse(raw, batch);
          const sources = stateDb.getDecisionSources(batch.assets.map((a) => a.id));
          const groups: Array<{ winnerIds: string[]; losers: string[]; type: string }> = [];
          for (const sg of expanded.similaritySubgroups) {
            if (sg.subgroupType !== "burst" && sg.subgroupType !== "near_duplicate") continue;
            const burstCulled = sg.cullIds.filter((id) => {
              const src = sources[id];
              return src === "burst-auto-cull" || src === "immich-duplicate";
            });
            if (burstCulled.length > 0 && sg.recommendedKeepIds.length > 0) {
              groups.push({
                winnerIds: sg.recommendedKeepIds,
                losers: burstCulled,
                type: sg.subgroupType,
              });
            }
          }
          return groups;
        } catch {
          return [];
        }
      })(),
    };
  },
);

/** Run LLM on a batch. ?model=xxx overrides the default model. */
app.post<{ Params: { id: string }; Querystring: { model?: string } }>(
  "/api/batches/:id/rank",
  async (req) => {
    const batch = sessionBatches.find((b) => b.id === req.params.id);
    if (!batch) return { error: "Not found" };
    if (!llmClient)
      return {
        error: "No LLM client configured (need --vertex or OPENROUTER key)",
      };

    const overrideModel = req.query.model;
    const fp = batchFingerprint(batch.assets.map((a) => a.id));

    // Check cache — filter by model so different models don't share cache
    const usedModel = overrideModel ?? modelArg;
    const cached = stateDb.getLlmRun(batch.id, fp, usedModel);
    if (cached) {
      return {
        cached: true,
        model: usedModel,
        response: JSON.parse(cached.responseJson),
      };
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

    const imageResolver = async (asset: { path: string; id: string }) => {
      try {
        return await immichApiAdapter!.getThumbnail(asset.id, "preview");
      } catch {
        console.warn(`  Thumbnail fetch failed for ${asset.id}, using placeholder`);
        return null;
      }
    };

    try {
      const { response, rawJson, inputTokens, outputTokens } = await client.rankBatch(
        batch,
        imageResolver,
        (s) => console.log(`  [LLM ${usedModel}] ${s}`),
      );

      // Store in DB (all runs kept, newest wins)
      stateDb.saveLlmRun(batch.id, fp, usedModel, "v3", rawJson, inputTokens, outputTokens);

      return {
        cached: false,
        model: usedModel,
        response,
        inputTokens,
        outputTokens,
      };
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

/**
 * Build the Gemini request body (contents + generationConfig) for a batch.
 * Used by the batch prediction CLI to assemble a JSONL file for Vertex AI.
 * Returns the same structure the real-time rank endpoint sends to the model.
 */
app.get<{ Params: { id: string } }>("/api/batches/:id/llm-request", async (req) => {
  const batch = sessionBatches.find((b) => b.id === req.params.id);
  if (!batch) return { error: "Not found" };
  if (!llmClient) return { error: "No LLM client configured" };

  const imageResolver = async (asset: { path: string; id: string }) => {
    try {
      return await immichApiAdapter!.getThumbnail(asset.id, "preview");
    } catch {
      return null;
    }
  };

  const imageBuffers = await llmClient.prepareImageBuffers(batch, imageResolver);
  const { contents, generationConfig } = llmClient.buildGeminiContents(batch, imageBuffers);
  const fp = batchFingerprint(batch.assets.map((a) => a.id));
  return { batchId: batch.id, fingerprint: fp, contents, generationConfig };
});

/**
 * Save an LLM run result from an external source (e.g. batch prediction job).
 * Body: { model, promptVersion?, rawJson, inputTokens, outputTokens }
 */
app.post<{
  Params: { id: string };
  Body: {
    model: string;
    promptVersion?: string;
    rawJson: string;
    inputTokens: number;
    outputTokens: number;
  };
}>("/api/batches/:id/llm-run", async (req) => {
  const batch = sessionBatches.find((b) => b.id === req.params.id);
  if (!batch) return { error: "Not found" };
  const fp = batchFingerprint(batch.assets.map((a) => a.id));
  const runId = stateDb.saveLlmRun(
    batch.id,
    fp,
    req.body.model,
    req.body.promptVersion ?? "v3",
    req.body.rawJson,
    req.body.inputTokens,
    req.body.outputTokens,
  );
  return { ok: true, llmRunId: runId };
});

// === View status ===

app.post<{
  Params: { id: string };
  Body: { viewType: string; status: string };
}>("/api/view-status/:id", async (req) => {
  stateDb.setViewStatus(req.params.id, req.body.viewType, req.body.status);
  return { ok: true };
});

// === Auto-cull endpoints ===

/** Bulk-approve auto-cull decisions for given batches */
app.post<{
  Body: { batchIds: string[]; model?: string };
}>("/api/batches/auto-approve", async (req) => {
  const results: Array<{
    batchId: string;
    approved: number;
    skipped: number;
    error?: string;
  }> = [];

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
      results.push({
        batchId,
        approved: 0,
        skipped: 0,
        error: "no LLM result",
      });
      continue;
    }

    // eslint-disable-next-line no-await-in-loop -- serial is fine; face-cache hits are fast and state writes must be sequential
    const summary = await getAutoCullSummary(batch, llmRun.id, req.body.model);
    if (!summary) {
      results.push({
        batchId,
        approved: 0,
        skipped: 0,
        error: "classification failed",
      });
      continue;
    }

    // Load existing decisions — manual always wins
    const assetIds = batch.assets.map((a) => a.id);
    const existing = stateDb.getPhotoDecisions(assetIds);

    const decisions: Array<{
      assetId: string;
      state: string | null;
      userStars: number | null;
    }> = [];
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

    // eslint-disable-next-line no-await-in-loop -- same as auto-approve above
    const summary = await getAutoCullSummary(batch, llmRun.id, req.body.model);
    if (!summary) continue;

    const existing = stateDb.getPhotoDecisions(batch.assets.map((a) => a.id));
    const decisions: Array<{
      assetId: string;
      state: string | null;
      userStars: number | null;
    }> = [];
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
    checkAndAutoMarkBatch(batchId);
    results.push({ batchId, autoCulled, forReview, skipped });
  }

  return { ok: true, results };
});

// === Multi-model agreement ===

/**
 * Compute per-photo agreement across all models that have rated this batch.
 * Returns each photo with each model's keep/cull decision and a consensus.
 */
app.get<{ Params: { id: string }; Querystring: { models?: string } }>(
  "/api/batches/:id/agreement",
  async (req) => {
    const batch = sessionBatches.find((b) => b.id === req.params.id);
    if (!batch) return { error: "Not found" };

    const fp = batchFingerprint(batch.assets.map((a) => a.id));
    const allRuns = stateDb.getAllLlmRuns(batch.id, fp);

    // Optionally filter to specific models
    const filterModels = req.query.models?.split(",");
    const runs = filterModels
      ? allRuns.filter((r) => filterModels.some((m) => r.model.includes(m)))
      : allRuns;

    if (runs.length < 2) {
      return {
        error: `Need >=2 model runs, have ${runs.length}`,
        models: runs.map((r) => r.model),
      };
    }

    // Parse each model's keep/cull decisions into a map: assetId → "k"|"c"
    const modelDecisions = new Map<string, Map<string, string>>();
    for (const run of runs) {
      try {
        const raw = JSON.parse(run.responseJson);
        const expanded = expandCompactResponse(raw, batch);
        const decisions = new Map<string, string>();
        for (const img of expanded.images) {
          if (img.llmKeepCull) decisions.set(img.imageId, img.llmKeepCull);
        }
        modelDecisions.set(run.model, decisions);
      } catch {
        /* skip unparseable */
      }
    }

    const models = [...modelDecisions.keys()];
    if (models.length < 2) {
      return { error: "Need >=2 parseable model runs", models };
    }

    // Build per-asset agreement
    const photos: Array<{
      assetId: string;
      filename: string;
      decisions: Record<string, string>;
      consensus: "keep" | "cull" | "disagree";
      keepVotes: number;
      cullVotes: number;
    }> = [];

    let unanimousKeep = 0,
      unanimousCull = 0,
      disagreements = 0;

    for (const asset of batch.assets) {
      const decisions: Record<string, string> = {};
      let keepVotes = 0,
        cullVotes = 0;

      for (const model of models) {
        const d = modelDecisions.get(model)?.get(asset.id);
        if (d) {
          decisions[model] = d;
          if (d === "keep") keepVotes++;
          else if (d === "cull") cullVotes++;
        }
      }

      const totalVotes = keepVotes + cullVotes;
      let consensus: "keep" | "cull" | "disagree";
      if (totalVotes === 0) {
        consensus = "disagree";
      } else if (keepVotes === totalVotes) {
        consensus = "keep";
        unanimousKeep++;
      } else if (cullVotes === totalVotes) {
        consensus = "cull";
        unanimousCull++;
      } else {
        consensus = "disagree";
        disagreements++;
      }

      photos.push({
        assetId: asset.id,
        filename: asset.filename,
        decisions,
        consensus,
        keepVotes,
        cullVotes,
      });
    }

    return {
      models,
      photoCount: batch.assets.length,
      unanimousKeep,
      unanimousCull,
      disagreements,
      photos,
    };
  },
);

/** Revert all auto-cull decisions (safety valve) */
app.delete("/api/auto-approve", async () => {
  const reverted = stateDb.revertAutoCullDecisions();
  return { ok: true, reverted };
});

/** Bulk-approve batches where all models unanimously agree on every photo */
app.post<{ Body: { dryRun?: boolean } }>("/api/batches/approve-confident", async (req) => {
  const dryRun = req.body.dryRun ?? false;
  const results: Array<{ batchId: string; kept: number; culled: number }> = [];

  for (const batch of sessionBatches) {
    if (stateDb.getViewStatus(batch.id)) continue; // already reviewed/skipped
    const agree = computeBatchAgreement(batch);
    if (!agree || agree.tier !== "full-agreement") continue;

    // Use first model's expanded result for the actual keep/cull + stars
    const fp = batchFingerprint(batch.assets.map((a) => a.id));
    const allRuns = stateDb.getAllLlmRuns(batch.id, fp);
    if (!allRuns.length) continue;

    let expanded;
    try {
      const raw = JSON.parse(allRuns[0].responseJson);
      expanded = expandCompactResponse(raw, batch);
    } catch {
      continue;
    }

    // Skip if any existing manual decisions (don't overwrite user work)
    const existing = stateDb.getPhotoDecisions(batch.assets.map((a) => a.id));
    if (Object.values(existing).some((d) => d.state != null)) continue;

    const decisions = expanded.images.map((img) => ({
      assetId: img.imageId,
      state: img.llmKeepCull ?? "keep",
      userStars: null as number | null,
    }));

    let kept = 0;
    let culled = 0;
    for (const d of decisions) {
      if (d.state === "keep") kept++;
      else culled++;
    }

    if (!dryRun) {
      stateDb.savePhotoDecisions(decisions, "consensus", allRuns[0].id);
      stateDb.setViewStatus(batch.id, "batch", "reviewed");
    }
    results.push({ batchId: batch.id, kept, culled });
  }

  return {
    ok: true,
    dryRun,
    batchCount: results.length,
    totalKept: results.reduce((s, r) => s + r.kept, 0),
    totalCulled: results.reduce((s, r) => s + r.culled, 0),
    results,
  };
});

/** Revert consensus-approved decisions (safety valve) */
app.delete("/api/approve-confident", async () => {
  const reverted = stateDb.revertConsensusDecisions();
  return { ok: true, reverted };
});

// ---------------------------------------------------------------------------
// Burst/duplicate auto-cull
// ---------------------------------------------------------------------------

/** Build Immich duplicate groups from duplicateId field */
function buildImmichDuplicateGroups(): Map<string, Asset[]> {
  const groups = new Map<string, Asset[]>();
  for (const batch of sessionBatches) {
    for (const asset of batch.assets) {
      if (asset.duplicateId) {
        let g = groups.get(asset.duplicateId);
        if (!g) {
          g = [];
          groups.set(asset.duplicateId, g);
        }
        g.push(asset);
      }
    }
  }
  // Only keep groups with 2+ assets
  for (const [k, v] of groups) {
    if (v.length < 2) groups.delete(k);
  }
  return groups;
}

/** Run burst auto-cull across all scored batches */
app.post<{ Body: { dryRun?: boolean } }>("/api/batches/burst-auto-cull", async (req) => {
  const dryRun = req.body?.dryRun ?? false;
  let totalCandidates = 0;
  let totalGroups = 0;
  let totalBatches = 0;
  let totalPhotosInBurstGroups = 0;
  const allCandidates: Array<{
    batchId: string;
    assetId: string;
    winnerId: string;
    reason: string;
  }> = [];

  // Build consensus keep/cull sets from multi-model agreement
  const consensusKeep = new Set<string>();
  const consensusCull = new Set<string>();
  for (const batch of sessionBatches) {
    const agree = computeBatchAgreement(batch);
    if (agree && agree.modelCount >= 2) {
      for (const p of agree.photos) {
        if (p.consensus === "keep") consensusKeep.add(p.assetId);
        else if (p.consensus === "cull") consensusCull.add(p.assetId);
      }
    }
  }

  for (const batch of sessionBatches) {
    const fp = batchFingerprint(batch.assets.map((a) => a.id));
    const cached = stateDb.getLlmRun(batch.id, fp);
    if (!cached) continue;

    try {
      const raw = JSON.parse(cached.responseJson);
      const expanded = expandCompactResponse(raw, batch);
      const result = classifyBurstAutoCull(
        expanded.images,
        expanded.similaritySubgroups,
        consensusKeep.size > 0 ? consensusKeep : undefined,
        consensusCull.size > 0 ? consensusCull : undefined,
      );

      if (result.photosAutoCulled > 0) {
        totalCandidates += result.photosAutoCulled;
        totalGroups += result.groupsCulled;
        totalBatches++;
        totalPhotosInBurstGroups += result.photosInBurstGroups;
        for (const c of result.candidates) {
          allCandidates.push({
            batchId: batch.id,
            assetId: c.assetId,
            winnerId: c.winnerId,
            reason: c.reason,
          });
        }
      }
    } catch {
      /* skip unparseable */
    }
  }

  // Also handle Immich duplicate groups
  const immichGroups = buildImmichDuplicateGroups();
  let immichCulled = 0;
  for (const [, assets] of immichGroups) {
    // Pick winner: highest rating, then largest file, then newest
    const sorted = [...assets].toSorted((a, b) => {
      if ((a.rating ?? 0) !== (b.rating ?? 0)) return (b.rating ?? 0) - (a.rating ?? 0);
      if ((a.fileSize ?? 0) !== (b.fileSize ?? 0)) return (b.fileSize ?? 0) - (a.fileSize ?? 0);
      return b.fileCreatedAt.getTime() - a.fileCreatedAt.getTime();
    });
    const winner = sorted[0];
    for (const loser of sorted.slice(1)) {
      // saveAutoDecisions handles conflict safety at SQL level
      allCandidates.push({
        batchId: "immich-duplicate",
        assetId: loser.id,
        winnerId: winner.id,
        reason: `Immich duplicate (${assets.length} photos)`,
      });
      immichCulled++;
    }
  }

  if (!dryRun) {
    // Use INSERT ... ON CONFLICT DO NOTHING — never overwrites existing decisions
    const burstCandidates = allCandidates.filter((c) => c.batchId !== "immich-duplicate");
    const immichCandidates = allCandidates.filter((c) => c.batchId === "immich-duplicate");

    let burstInserted = 0;
    let immichInserted = 0;
    if (burstCandidates.length > 0) {
      burstInserted = stateDb.saveAutoDecisions(
        burstCandidates.map((c) => ({ assetId: c.assetId, state: "cull" })),
        "burst-auto-cull",
      );
    }
    if (immichCandidates.length > 0) {
      immichInserted = stateDb.saveAutoDecisions(
        immichCandidates.map((c) => ({ assetId: c.assetId, state: "cull" })),
        "immich-duplicate",
      );
    }
    // Auto-mark batches as reviewed if all photos now have decisions
    for (const batch of sessionBatches) {
      checkAndAutoMarkBatch(batch.id);
    }
    // Report actual inserts (excluding skipped due to existing decisions)
    totalCandidates = burstInserted;
    immichCulled = immichInserted;
  }

  return {
    ok: true,
    dryRun,
    burstGroups: totalGroups,
    burstPhotos: totalCandidates,
    burstBatches: totalBatches,
    immichGroups: immichGroups.size,
    immichPhotos: immichCulled,
    totalAutoCulled: totalCandidates + immichCulled,
  };
});

/** List all burst/near-duplicate subgroups across all batches (for inspector UI) */
app.get("/api/burst-groups", async () => {
  const rows: Array<{
    batchId: string;
    batchDate: string;
    batchReviewed: boolean;
    subgroupId: string;
    subgroupType: string;
    rationale: string;
    summary: string;
    keeperIds: string[];
    recommendedCullIds: string[]; // LLM cull but NOT auto-culled
    autoCulledIds: string[]; // actually auto-applied
  }> = [];

  for (const batch of sessionBatches) {
    const fp = batchFingerprint(batch.assets.map((a) => a.id));
    const cached = stateDb.getLlmRun(batch.id, fp);
    if (!cached) continue;

    const viewStatus = stateDb.getViewStatus(batch.id);
    const batchReviewed = viewStatus === "reviewed";

    try {
      const raw = JSON.parse(cached.responseJson);
      const expanded = expandCompactResponse(raw, batch);
      const assetIds = batch.assets.map((a) => a.id);
      const sources = stateDb.getDecisionSources(assetIds);

      for (const sg of expanded.similaritySubgroups) {
        if (sg.subgroupType !== "burst" && sg.subgroupType !== "near_duplicate") continue;
        const autoCulledIds: string[] = [];
        const recommendedCullIds: string[] = [];
        for (const id of sg.cullIds) {
          const src = sources[id];
          if (src === "burst-auto-cull" || src === "immich-duplicate") {
            autoCulledIds.push(id);
          } else {
            recommendedCullIds.push(id);
          }
        }
        rows.push({
          batchId: batch.id,
          batchDate: batch.dateRange.start.toISOString(),
          batchReviewed,
          subgroupId: sg.subgroupId,
          subgroupType: sg.subgroupType,
          rationale: sg.rationale ?? "",
          summary: expanded.batchSummary ?? "",
          keeperIds: sg.recommendedKeepIds,
          recommendedCullIds,
          autoCulledIds,
        });
      }
    } catch {
      /* skip unparseable */
    }
  }

  // Sort newest first
  const sorted = rows.toSorted((a, b) => b.batchDate.localeCompare(a.batchDate));
  return { groups: sorted };
});

app.delete("/api/batches/burst-auto-cull", async () => {
  const reverted = stateDb.revertBurstAutoCullDecisions();
  // Clear batch review status for affected batches (they may no longer be fully decided)
  if (reverted > 0) {
    for (const batch of sessionBatches) {
      const status = stateDb.getViewStatus(batch.id);
      if (status === "reviewed") {
        // Re-check if still fully decided
        const assetIds = batch.assets.map((a) => a.id);
        const decisions = stateDb.getPhotoDecisions(assetIds);
        const allDecided = assetIds.every((id) => decisions[id]?.state != null);
        if (!allDecided) stateDb.setViewStatus(batch.id, "batch", null as any);
      }
    }
  }
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

      // Filter out photos the user has already decided on
      const allCullIds = expanded.images
        .filter((img) => img.llmKeepCull === "cull" && img.similaritySubgroupId)
        .map((img) => img.imageId);
      const existingDecisions = stateDb.getPhotoDecisions(allCullIds);

      // For each culled photo in a subgroup, pair with its keeper(s)
      const comparisons = [];
      for (const img of expanded.images) {
        if (img.llmKeepCull !== "cull") continue;
        if (!img.similaritySubgroupId) continue;
        if (existingDecisions[img.imageId]?.state) continue;

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

/** Get all subgroups across batches for review. Each subgroup shows all photos with keep/cull status. */
app.get("/api/review-groups", async () => {
  interface ReviewPhoto {
    id: string;
    filename: string;
    path: string;
    date: string;
    w: number;
    h: number;
    bytes: number;
    stars: number;
    note: string;
    category: string;
    llmAction: "keep" | "cull";
  }
  interface ReviewGroup {
    batchId: string;
    subgroupId: string;
    subgroupType: string;
    rationale: string;
    batchSummary: string;
    photos: ReviewPhoto[];
    tier: "high" | "standard" | "review";
  }

  const reviewGroups: ReviewGroup[] = [];
  const singletons: ReviewPhoto[] = [];

  for (const batch of sessionBatches) {
    const fp = batchFingerprint(batch.assets.map((a) => a.id));
    const cached = stateDb.getLlmRun(batch.id, fp);
    if (!cached) continue;

    try {
      const raw = JSON.parse(cached.responseJson);
      const expanded = expandCompactResponse(raw, batch);
      const imgMap = new Map(expanded.images.map((img) => [img.imageId, img]));

      const toPhoto = (aid: string, action: "keep" | "cull"): ReviewPhoto => {
        const img = imgMap.get(aid);
        const asset = batch.assets.find((a) => a.id === aid);
        return {
          id: aid,
          filename: asset?.filename ?? "",
          path: asset?.path ?? "",
          date: asset?.fileCreatedAt.toISOString() ?? "",
          w: asset?.width ?? 4,
          h: asset?.height ?? 3,
          bytes: fileSizeCache.get(aid) ?? 0,
          stars: img?.suggestedStars ?? 0,
          note: img?.briefNote ?? "",
          category: img?.categories[0] ?? "other",
          llmAction: action,
        };
      };

      // Compute auto-cull tiers for this batch
      const acResult = classifyBatchForAutoCull(expanded.images, expanded.similaritySubgroups);
      const tierMap = new Map(acResult.classifications.map((c) => [c.assetId, c.tier]));

      for (const sg of expanded.similaritySubgroups) {
        if (sg.imageIds.length < 2) continue;
        const keepSet = new Set(sg.recommendedKeepIds);
        // Group tier = best tier among its culls (high > standard > review)
        const cullTiers = new Set(sg.cullIds.map((id) => tierMap.get(id) ?? "review"));
        const groupTier = cullTiers.has("auto-cull-high")
          ? "high"
          : cullTiers.has("auto-cull")
            ? "standard"
            : "review";
        reviewGroups.push({
          batchId: batch.id,
          subgroupId: sg.subgroupId,
          subgroupType: sg.subgroupType,
          rationale: sg.rationale,
          batchSummary: expanded.batchSummary,
          photos: sg.imageIds.map((aid) => toPhoto(aid, keepSet.has(aid) ? "keep" : "cull")),
          tier: groupTier,
        });
      }

      // Collect singleton culls for batching
      for (const img of expanded.images) {
        if (img.llmKeepCull !== "cull") continue;
        if (img.similaritySubgroupId) continue;
        singletons.push(toPhoto(img.imageId, "cull"));
      }
    } catch {
      // skip bad batch
    }
  }

  // Batch singletons into groups of 8
  for (let i = 0; i < singletons.length; i += 8) {
    const chunk = singletons.slice(i, i + 8);
    reviewGroups.push({
      batchId: "singletons",
      subgroupId: `singletons-${i}`,
      subgroupType: "singleton-batch",
      rationale: `${chunk.length} standalone culls — no similar photo to compare against`,
      batchSummary: "",
      photos: chunk,
      tier: "review",
    });
  }

  // Filter out groups where all culls are already decided
  const allIds = reviewGroups.flatMap((g) => g.photos.map((p) => p.id));
  const decisions = stateDb.getPhotoDecisions(allIds);
  const filtered = reviewGroups.filter((g) => {
    const culls = g.photos.filter((p) => p.llmAction === "cull");
    return culls.some((p) => !decisions[p.id]?.state);
  });

  // Sort: high confidence first, then standard, then review
  const tierOrder = { high: 0, standard: 1, review: 2 };
  filtered.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier]);

  const tierCounts = {
    high: filtered.filter((g) => g.tier === "high").length,
    standard: filtered.filter((g) => g.tier === "standard").length,
    review: filtered.filter((g) => g.tier === "review").length,
  };

  return { groups: filtered, total: reviewGroups.length, tierCounts };
});

// === Per-photo decisions (shared across all views) ===

/** Save decisions for multiple photos */
app.post<{
  Body: {
    decisions: Array<{
      assetId: string;
      state: string | null;
      userStars: number | null;
    }>;
  };
}>("/api/photos/decisions", async (req) => {
  stateDb.savePhotoDecisions(req.body.decisions);
  // Auto-mark batches as reviewed if all their photos now have decisions
  const a2b = getAssetToBatch();
  const affected = new Set<string>();
  for (const d of req.body.decisions) {
    const bid = a2b.get(d.assetId);
    if (bid) affected.add(bid);
  }
  for (const bid of affected) checkAndAutoMarkBatch(bid);
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
  immichWriteback = new ImmichWriteback({
    serverUrl: immichUrl,
    apiKey: immichApiKey,
  });
}

/** Get star rating summary and sample photos at each star level */
app.get("/api/stars/summary", async () => {
  const allDecisions = stateDb.getAllDecisions();
  const summary: Record<
    number,
    { count: number; samples: Array<{ id: string; filename: string }> }
  > = {};

  // Build lookups for filenames and LLM stars
  const assetLookup = new Map<string, string>();
  const llmStarsLookup = new Map<string, number>();
  for (const batch of sessionBatches) {
    for (const a of batch.assets) assetLookup.set(a.id, a.filename);
    const fp = batchFingerprint(batch.assets.map((a) => a.id));
    const cached = stateDb.getLlmRun(batch.id, fp);
    if (cached) {
      try {
        const raw = JSON.parse(cached.responseJson);
        const expanded = expandCompactResponse(raw, batch);
        for (const img of expanded.images) {
          llmStarsLookup.set(img.imageId, mapLlmStarsToWriteback(img.suggestedStars));
        }
      } catch {
        // skip
      }
    }
  }

  for (const d of allDecisions) {
    if (d.state !== "keep") continue;
    // User stars take priority, fall back to LLM stars (mapped through shift-1)
    const star = d.userStars ?? llmStarsLookup.get(d.assetId) ?? 0;
    if (!summary[star]) summary[star] = { count: 0, samples: [] };
    summary[star].count++;
    if (summary[star].samples.length < 20) {
      summary[star].samples.push({
        id: d.assetId,
        filename: assetLookup.get(d.assetId) ?? "",
      });
    }
  }

  return {
    summary,
    totalKept: allDecisions.filter((d) => d.state === "keep").length,
  };
});

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
    return {
      error: "Immich write-back not configured (set IMMICH_URL and IMMICH_API_KEY)",
    };
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

// === Experiment grading endpoints ===
// Reads experiment JSON from data/experiments/<id>.json (output from scripts/burst_discriminator_experiment.ts)
// Stores grades as a sidecar at data/experiments/<id>-grades.json
import { readdirSync } from "fs";

const experimentsDir = resolve(__dirname, "../data/experiments");

app.get<{ Querystring: { ids: string } }>("/api/assets/details", async (req) => {
  const ids = (req.query.ids ?? "").split(",").filter(Boolean);
  const details = ids
    .map((id) => {
      const a = assetMap.get(id);
      if (!a) return null;
      return {
        id: a.id,
        filename: a.filename,
        path: a.path,
        date: a.fileCreatedAt.toISOString(),
        rating: a.rating,
        isFavorite: a.isFavorite,
        bytes: a.fileSize ?? 0,
        w: a.width ?? 0,
        h: a.height ?? 0,
      };
    })
    .filter((d) => d !== null);
  return { assets: details };
});

app.get("/api/experiments", async () => {
  if (!existsSync(experimentsDir)) return { experiments: [] };
  const archivePath = resolve(experimentsDir, "archived.json");
  const archived = new Set<string>();
  if (existsSync(archivePath)) {
    try {
      const parsed = JSON.parse(readFileSync(archivePath, "utf-8")) as { archived?: string[] };
      for (const id of parsed.archived ?? []) archived.add(id);
    } catch {
      // fall through with empty archive
    }
  }
  const files = readdirSync(experimentsDir)
    .filter((f) => f.endsWith(".json") && !f.endsWith("-grades.json") && f !== "archived.json")
    .toSorted()
    .toReversed();
  const entries = files.map((f) => {
    const id = f.replace(/\.json$/, "");
    return { id, archived: archived.has(id) };
  });
  // Active first, archived last — preserves sort within each bucket.
  entries.sort((a, b) => (a.archived ? 1 : 0) - (b.archived ? 1 : 0));
  return { experiments: entries };
});

app.get<{ Params: { id: string } }>("/api/experiments/:id", async (req, reply) => {
  const expPath = resolve(experimentsDir, `${req.params.id}.json`);
  const gradesPath = resolve(experimentsDir, `${req.params.id}-grades.json`);
  if (!existsSync(expPath)) {
    reply.code(404);
    return { error: "Experiment not found" };
  }
  const experiment = JSON.parse(readFileSync(expPath, "utf-8"));
  const grades = existsSync(gradesPath) ? JSON.parse(readFileSync(gradesPath, "utf-8")) : {};
  return { experiment, grades };
});

app.post<{
  Params: { id: string };
  Body: { key: string; severity?: number | null; keepBias?: number | null; note?: string };
}>("/api/experiments/:id/grade", async (req, _reply) => {
  const gradesPath = resolve(experimentsDir, `${req.params.id}-grades.json`);
  const grades: Record<string, any> = existsSync(gradesPath)
    ? JSON.parse(readFileSync(gradesPath, "utf-8"))
    : {};
  grades[req.body.key] = {
    severity: req.body.severity ?? null,
    keepBias: req.body.keepBias ?? null,
    note: req.body.note ?? "",
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(gradesPath, JSON.stringify(grades, null, 2));
  return { ok: true };
});

// Replace the full grades file (used for migrations)
app.put<{
  Params: { id: string };
  Body: { grades: Record<string, unknown> };
}>("/api/experiments/:id/grades", async (req, _reply) => {
  const gradesPath = resolve(experimentsDir, `${req.params.id}-grades.json`);
  writeFileSync(gradesPath, JSON.stringify(req.body.grades, null, 2));
  return { ok: true };
});

// Aggregate grades from ALL experiment files. Returned as grade-key -> {grade, sourceExperiment}.
// When the same grade-key exists in multiple experiments, the most recently updated wins.
// Used by the grader to inherit grades across experiments when (group, picks) match exactly.
app.get("/api/grades/all", async () => {
  if (!existsSync(experimentsDir)) return { grades: {} };
  const files = readdirSync(experimentsDir).filter((f) => f.endsWith("-grades.json"));
  const merged: Record<string, { grade: any; sourceExperiment: string }> = {};
  for (const f of files) {
    const expId = f.replace(/-grades\.json$/, "");
    try {
      const g = JSON.parse(readFileSync(resolve(experimentsDir, f), "utf-8"));
      for (const [key, val] of Object.entries(g)) {
        if (!val || typeof val !== "object") continue;
        const existing = merged[key];
        const thisTs = (val as any).updatedAt ?? "";
        const existingTs = existing?.grade?.updatedAt ?? "";
        if (!existing || thisTs > existingTs) {
          merged[key] = { grade: val, sourceExperiment: expId };
        }
      }
    } catch {
      // skip broken files
    }
  }
  return { grades: merged };
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
    filteredAssets = allAssets.filter(
      (a) => !compiled.some((re) => re.test(a.path) || re.test(a.filename)),
    );
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
  args.find((a) => a.startsWith("--model="))?.split("=")[1] ??
  DEFAULT_LLM_CONFIG.model.replace("google/", "");
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
