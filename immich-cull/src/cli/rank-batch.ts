#!/usr/bin/env tsx
/**
 * Rank a specific session batch by its ID.
 * Usage: npx tsx src/cli/rank-batch.ts --batch-id 2024-08-07-71a9dbc64368 [--db path]
 */
import { FacetAdapter } from "../db/facet-adapter.js";
import { batchBySession } from "../batching/session-batcher.js";
import { LlmClient } from "../ranking/llm-client.js";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { config as loadEnv } from "dotenv";
loadEnv();

const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

const dbPath = getArg("--db", resolve(import.meta.dirname ?? ".", "../../..", "facet/photo_scores_pro.db"));
const targetBatchId = getArg("--batch-id", "");

const keyPath = resolve("/home/odin/Kode/miniapps/babysovelogg/OPENROUTER.key");
const apiKey = existsSync(keyPath) ? readFileSync(keyPath, "utf-8").trim() : "";
if (!apiKey) { console.error("No OpenRouter API key"); process.exit(1); }

console.log("Loading and batching...");
const adapter = new FacetAdapter(dbPath);
const assets = adapter.getAllAssets();
adapter.close();

const batches = batchBySession(assets);

const batch = targetBatchId
  ? batches.find(b => b.id === targetBatchId)
  : batches[0];

if (!batch) {
  console.error(`Batch not found: ${targetBatchId}`);
  console.log("Available:", batches.slice(0, 10).map(b => b.id).join(", "));
  process.exit(1);
}

console.log(`\nBatch: ${batch.id}`);
console.log(`${batch.assets.length} photos, ${batch.source}, span: ${((batch.dateRange.end.getTime() - batch.dateRange.start.getTime()) / 60000).toFixed(0)}min`);
console.log(`Files: ${batch.assets.map(a => a.filename).join(", ")}`);

function resolveFilePath(asset: { path: string }): string | null {
  if (existsSync(asset.path)) return asset.path;
  for (const ext of [".jpg", ".jpeg", ".JPG", ".JPEG", ".png", ".PNG"]) {
    if (existsSync(asset.path + ext)) return asset.path + ext;
  }
  return null;
}

const useVertex = args.includes("--vertex");
console.log(`\nSending to LLM via ${useVertex ? "Vertex AI" : "OpenRouter"}...`);
const client = new LlmClient({
  apiKey: useVertex ? "" : apiKey,
  model: getArg("--model", "gemini-2.5-flash-lite"),
  provider: useVertex ? "vertexai" : "openrouter",
  vertexProject: "tagrdevin",
});

const t0 = Date.now();
const { response, rawJson, inputTokens, outputTokens } = await client.rankBatch(
  batch, resolveFilePath,
  (status) => console.log(`  ${status}`)
);
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`\n=== LLM Response (${elapsed}s) ===`);
console.log(`Summary: ${response.batchSummary}`);
console.log(`Confidence: ${response.overallConfidence}`);
console.log(`Images: ${response.images?.length ?? 0}, Subgroups: ${response.similaritySubgroups?.length ?? 0}`);

if (response.images) {
  console.log(`\n--- Per-image assessments ---`);
  for (const img of response.images) {
    const stars = "★".repeat(img.suggestedStars) + "☆".repeat(3 - img.suggestedStars);
    const asset = batch.assets.find(a => a.id === img.imageId);
    const fn = asset?.filename ?? img.imageId.slice(-30);
    const prot = img.protectFromCull ? " [PROTECTED]" : "";
    const sg = img.similaritySubgroupId ? ` (sg:${img.similaritySubgroupId})` : "";
    console.log(`  ${stars} ${fn} — ${img.briefNote}${prot}${sg}`);
  }

  const starDist = [0, 0, 0, 0];
  for (const img of response.images) starDist[img.suggestedStars]++;
  console.log(`\n  Star distribution: 0★:${starDist[0]} 1★:${starDist[1]} 2★:${starDist[2]} 3★:${starDist[3]}`);
}

if (response.similaritySubgroups?.length) {
  console.log(`\n--- Similarity subgroups ---`);
  for (const sg of response.similaritySubgroups) {
    console.log(`\n  [${sg.subgroupId}] ${sg.subgroupType} — ${sg.imageIds.length} photos, keep ${sg.recommendedKeepCount}`);
    console.log(`  Keep: ${sg.recommendedKeepIds.map(id => batch.assets.find(a => a.id === id)?.filename ?? id.slice(-20)).join(", ")}`);
    console.log(`  Cull: ${sg.cullIds.map(id => batch.assets.find(a => a.id === id)?.filename ?? id.slice(-20)).join(", ")}`);
    console.log(`  Reason: ${sg.rationale}`);
  }
}

const cost = (inputTokens / 1e6) * 0.10 + (outputTokens / 1e6) * 0.40;
console.log(`\nTokens: ${inputTokens} in, ${outputTokens} out`);
console.log(`Cost: $${cost.toFixed(4)}`);

writeFileSync(`/tmp/llm-response-${batch.id}.json`, rawJson);
console.log(`Raw JSON: /tmp/llm-response-${batch.id}.json`);
