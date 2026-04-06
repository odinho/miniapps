#!/usr/bin/env tsx
/**
 * Test the session batcher against local or Immich data.
 * Usage: npx tsx src/cli/batch-test.ts [--immich] [--sample 2000]
 */
import { FacetAdapter } from "../db/facet-adapter.js";
import { ImmichAdapter } from "../db/immich-adapter.js";
import { getImmichDbConfig } from "../shared/config.js";
import { batchBySession, batchStats, DEFAULT_SESSION_CONFIG } from "../batching/session-batcher.js";
import { Asset } from "../shared/types.js";
import { config as loadEnv } from "dotenv";
import { resolve } from "path";
loadEnv();

const args = process.argv.slice(2);
const useImmich = args.includes("--immich");
const sampleSize = parseInt(args.find((_, i, a) => a[i - 1] === "--sample") ?? "0");

let assets: Asset[];

if (useImmich) {
  const adapter = new ImmichAdapter(getImmichDbConfig());
  const count = await adapter.getAssetCount();
  console.log(`Immich: ${count} images`);
  if (sampleSize > 0) {
    assets = await adapter.getSampleAssets(sampleSize);
  } else {
    assets = await adapter.getAllAssets((loaded, total) => {
      process.stdout.write(`\r  Loading ${loaded}/${total}`);
    });
    console.log();
  }
  await adapter.close();
} else {
  const dbPath = args.find((_, i, a) => a[i - 1] === "--db") ?? resolve(import.meta.dirname ?? ".", "../../..", "facet/photo_scores_pro.db");
  const adapter = new FacetAdapter(dbPath);
  assets = adapter.getAllAssets();
  adapter.close();
}

console.log(`\nLoaded ${assets.length} assets`);
console.log();

const batches = batchBySession(assets, DEFAULT_SESSION_CONFIG);
console.log("=== Session Batching Results ===");
console.log(batchStats(batches));
console.log();

// Show top 20 batches
const showCount = Math.min(20, batches.length);
console.log(`=== Top ${showCount} Batches ===`);
for (let i = 0; i < showCount; i++) {
  const b = batches[i];
  const dateStr = b.dateRange.start.toISOString().slice(0, 10);
  const spanMin = (b.dateRange.end.getTime() - b.dateRange.start.getTime()) / 60_000;
  console.log(
    `[${b.id}] ${b.assets.length} photos | ${b.source} | ${b.folderName ?? dateStr} | ${spanMin.toFixed(0)}min span`
  );
}

// Size distribution
console.log("\n=== Batch Size Distribution ===");
const sizeBuckets = new Map<string, number>();
for (const b of batches) {
  const size = b.assets.length;
  let bucket: string;
  if (size === 1) bucket = "1";
  else if (size <= 5) bucket = "2-5";
  else if (size <= 10) bucket = "6-10";
  else if (size <= 20) bucket = "11-20";
  else if (size <= 50) bucket = "21-50";
  else if (size <= 100) bucket = "51-100";
  else bucket = "100+";
  sizeBuckets.set(bucket, (sizeBuckets.get(bucket) ?? 0) + 1);
}
for (const bucket of ["1", "2-5", "6-10", "11-20", "21-50", "51-100", "100+"]) {
  const count = sizeBuckets.get(bucket) ?? 0;
  if (count > 0) console.log(`  ${bucket}: ${count} batches`);
}

// Estimated LLM cost
const totalTokens = assets.length * 256 + batches.length * 2000; // images + prompts
const outputTokens = assets.length * 140; // ~140 tokens per image output
const inputCost = (totalTokens / 1_000_000) * 0.10;
const outputCost = (outputTokens / 1_000_000) * 0.40;
console.log(`\n=== Estimated LLM Cost (Gemini 2.5 Flash Lite) ===`);
console.log(`  Input: ${totalTokens.toLocaleString()} tokens → $${inputCost.toFixed(2)}`);
console.log(`  Output: ${outputTokens.toLocaleString()} tokens → $${outputCost.toFixed(2)}`);
console.log(`  Total: $${(inputCost + outputCost).toFixed(2)}`);
