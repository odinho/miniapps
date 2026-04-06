#!/usr/bin/env tsx
/**
 * CLI to test clustering against Facet's local SQLite database.
 * Usage: npx tsx src/cli/cluster-local.ts [--db path] [--strong 0.18] [--burst 0.22] [--json output.json]
 */
import { FacetAdapter } from "../db/facet-adapter.js";
import { clusterAssets } from "../clustering/engine.js";
import { ClusterConfig, DEFAULT_CLUSTER_CONFIG } from "../shared/types.js";
import { writeFileSync } from "fs";
import { resolve } from "path";

const args = process.argv.slice(2);

function getArg(flag: string, defaultVal: string): string {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : defaultVal;
}

const dbPath = getArg("--db", resolve(import.meta.dirname ?? ".", "../../..", "facet/photo_scores_pro.db"));
const strongDist = parseFloat(getArg("--strong", String(DEFAULT_CLUSTER_CONFIG.strongEdgeDistance)));
const burstDist = parseFloat(getArg("--burst", String(DEFAULT_CLUSTER_CONFIG.burstEdgeDistance)));
const bucketMin = parseInt(getArg("--bucket", String(DEFAULT_CLUSTER_CONFIG.bucketMinutes)));
const jsonOutput = getArg("--json", "");
const dryRun = args.includes("--dry-run");

const config: ClusterConfig = {
  ...DEFAULT_CLUSTER_CONFIG,
  strongEdgeDistance: strongDist,
  burstEdgeDistance: burstDist,
  bucketMinutes: bucketMin,
};

console.log("=== immich-cull: Local Clustering Test ===");
console.log(`DB: ${dbPath}`);
console.log(`Config: strong=${config.strongEdgeDistance}, burst=${config.burstEdgeDistance}, bucket=${config.bucketMinutes}min`);
console.log();

const adapter = new FacetAdapter(dbPath);
const assetCount = adapter.getAssetCount();
console.log(`Loading ${assetCount} assets...`);

const assets = adapter.getAllAssets();
adapter.close();

console.log(`Loaded ${assets.length} assets with embeddings`);
console.log();

const { groups, stats } = clusterAssets(assets, config);

console.log();
console.log("=== Clustering Results ===");
console.log(`Total assets:     ${stats.totalAssets}`);
console.log(`Groups found:     ${stats.totalGroups}`);
console.log(`Singletons:       ${stats.singletons} (unique photos, not in any group)`);
console.log(`Largest group:    ${stats.largestGroup}`);
console.log(`Avg group size:   ${stats.avgGroupSize}`);
console.log(`Edges created:    ${stats.edgesCreated}`);
console.log();

// Show top 20 groups
const showCount = Math.min(20, groups.length);
console.log(`=== Top ${showCount} Groups (by size) ===`);
for (let i = 0; i < showCount; i++) {
  const g = groups[i];
  const times = g.assets.map((a) => a.asset.fileCreatedAt);
  const earliest = new Date(Math.min(...times.map((t) => t.getTime())));
  const filenames = g.assets.map((a) => a.asset.filename).join(", ");

  console.log(
    `\n[${g.id}] ${g.assets.length} photos | span: ${g.timeSpanMinutes}min | avg dist: ${g.avgDistance} | ${earliest.toISOString().slice(0, 16)}`
  );

  // Show filenames (truncated)
  if (filenames.length > 120) {
    console.log(`  Files: ${filenames.slice(0, 120)}...`);
  } else {
    console.log(`  Files: ${filenames}`);
  }

  // Show existing ratings
  const rated = g.assets.filter((a) => a.asset.rating != null && a.asset.rating > 0);
  if (rated.length > 0) {
    console.log(`  Rated: ${rated.map((a) => `${a.asset.filename}=${a.asset.rating}★`).join(", ")}`);
  }
}

// Distribution summary
console.log("\n=== Group Size Distribution ===");
const sizeDist = new Map<number, number>();
for (const g of groups) {
  const size = g.assets.length;
  sizeDist.set(size, (sizeDist.get(size) || 0) + 1);
}
for (const [size, count] of [...sizeDist.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${size} photos: ${count} groups (${count * size} photos total)`);
}

const photosInGroups = groups.reduce((s, g) => s + g.assets.length, 0);
console.log(`\nPhotos in groups: ${photosInGroups} / ${stats.totalAssets} (${Math.round((photosInGroups / stats.totalAssets) * 100)}%)`);
console.log(`Potential culls: ~${photosInGroups - groups.length} (keeping 1 per group)`);

// Write JSON output
if (jsonOutput) {
  const output = groups.map((g) => ({
    id: g.id,
    count: g.assets.length,
    timeSpanMinutes: g.timeSpanMinutes,
    avgDistance: g.avgDistance,
    assets: g.assets.map((a) => ({
      id: a.asset.id,
      filename: a.asset.filename,
      date: a.asset.fileCreatedAt.toISOString(),
      rating: a.asset.rating,
    })),
  }));
  writeFileSync(jsonOutput, JSON.stringify(output, null, 2));
  console.log(`\nJSON written to ${jsonOutput}`);
}
