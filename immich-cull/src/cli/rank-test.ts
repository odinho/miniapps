#!/usr/bin/env tsx
/**
 * Test LLM ranking on a single batch.
 * Usage: npx tsx src/cli/rank-test.ts [--batch-index 0] [--db path]
 */
import { FacetAdapter } from "../db/facet-adapter.js";
import { batchBySession } from "../batching/session-batcher.js";
import { LlmClient } from "../ranking/llm-client.js";
import { Asset } from "../shared/types.js";
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
const batchIndex = parseInt(getArg("--batch-index", "14")); // default to a mid-size batch

// Load OpenRouter key
const keyPath = resolve("/home/odin/Kode/miniapps/babysovelogg/OPENROUTER.key");
const apiKey = existsSync(keyPath) ? readFileSync(keyPath, "utf-8").trim() : "";
if (!apiKey) { console.error("No OpenRouter API key found"); process.exit(1); }

console.log("Loading photos...");
const adapter = new FacetAdapter(dbPath);
const assets = adapter.getAllAssets();
adapter.close();

console.log(`Batching ${assets.length} photos...`);
const batches = batchBySession(assets);
console.log(`${batches.length} batches`);

if (batchIndex >= batches.length) {
  console.error(`Batch index ${batchIndex} out of range (0-${batches.length - 1})`);
  process.exit(1);
}

const batch = batches[batchIndex];
console.log(`\nBatch ${batchIndex}: ${batch.assets.length} photos, ${batch.source}, ${batch.folderName ?? batch.dateRange.start.toISOString().slice(0, 10)}`);
console.log(`Files: ${batch.assets.map(a => a.filename).join(", ")}`);

function resolveFilePath(asset: { path: string }): string | null {
  if (existsSync(asset.path)) return asset.path;
  for (const ext of [".jpg", ".jpeg", ".JPG", ".JPEG", ".png", ".PNG"]) {
    if (existsSync(asset.path + ext)) return asset.path + ext;
  }
  return null;
}

console.log(`\nSending to LLM...`);
const client = new LlmClient({ apiKey, model: getArg("--model", "google/gemini-2.5-flash-lite") });

try {
  const { response, rawJson, inputTokens, outputTokens } = await client.rankBatch(
    batch,
    resolveFilePath,
    (status) => console.log(`  ${status}`)
  );

  console.log(`\n=== LLM Response ===`);
  console.log(`Summary: ${response.batchSummary}`);
  console.log(`Confidence: ${response.overallConfidence}`);
  console.log(`Images assessed: ${response.images?.length ?? 0}`);
  console.log(`Similarity subgroups: ${response.similaritySubgroups?.length ?? 0}`);

  if (response.images) {
    console.log(`\n--- Per-image ---`);
    for (const img of response.images) {
      const stars = "★".repeat(img.suggestedStars) + "☆".repeat(3 - img.suggestedStars);
      console.log(`  ${stars} [${img.categories?.join(",")}] ${img.briefNote}`);
    }
  }

  if (response.similaritySubgroups?.length) {
    console.log(`\n--- Similarity subgroups ---`);
    for (const sg of response.similaritySubgroups) {
      console.log(`  ${sg.subgroupId}: ${sg.subgroupType}, keep ${sg.recommendedKeepCount}/${sg.imageIds.length}`);
      console.log(`    ${sg.rationale}`);
    }
  }

  console.log(`\nTokens: ${inputTokens} in, ${outputTokens} out`);
  const cost = (inputTokens / 1e6) * 0.10 + (outputTokens / 1e6) * 0.40;
  console.log(`Estimated cost: $${cost.toFixed(4)}`);

  // Save raw response
  const outPath = `/tmp/llm-response-batch${batchIndex}.json`;
  writeFileSync(outPath, rawJson);
  console.log(`\nRaw JSON saved to ${outPath}`);
} catch (e: any) {
  console.error(`\nError: ${e.message}`);
}
