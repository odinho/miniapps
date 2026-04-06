#!/usr/bin/env tsx
/**
 * CLI to test clustering against Immich's PostgreSQL database.
 * Requires SSH tunnel: ssh -f -N -L 15432:172.20.0.2:5432 odin@192.168.10.74
 *
 * Usage: npx tsx src/cli/cluster-immich.ts [--sample 2000] [--json output.json]
 */
import { ImmichAdapter } from "../db/immich-adapter.js";
import { clusterAssets } from "../clustering/engine.js";
import { ClusterConfig, DEFAULT_CLUSTER_CONFIG } from "../shared/types.js";
import { getImmichDbConfig } from "../shared/config.js";
import { writeFileSync } from "fs";
import { config as loadEnv } from "dotenv";
loadEnv();

const args = process.argv.slice(2);

function getArg(flag: string, defaultVal: string): string {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : defaultVal;
}

const sampleSize = parseInt(getArg("--sample", "0")); // 0 = all
const jsonOutput = getArg("--json", "");
const strongDist = parseFloat(getArg("--strong", String(DEFAULT_CLUSTER_CONFIG.strongEdgeDistance)));
const burstDist = parseFloat(getArg("--burst", String(DEFAULT_CLUSTER_CONFIG.burstEdgeDistance)));
const bucketMin = parseInt(getArg("--bucket", String(DEFAULT_CLUSTER_CONFIG.bucketMinutes)));

const config: ClusterConfig = {
  ...DEFAULT_CLUSTER_CONFIG,
  strongEdgeDistance: strongDist,
  burstEdgeDistance: burstDist,
  bucketMinutes: bucketMin,
};

console.log("=== immich-cull: Immich Clustering ===");
console.log(`Config: strong=${config.strongEdgeDistance}, burst=${config.burstEdgeDistance}, bucket=${config.bucketMinutes}min`);
if (sampleSize > 0) console.log(`Sample: ${sampleSize} most recent photos`);
console.log();

const adapter = new ImmichAdapter(getImmichDbConfig());

try {
  const totalCount = await adapter.getAssetCount();
  console.log(`Immich has ${totalCount} images with embeddings`);

  // Show rating distribution
  const ratings = await adapter.getRatingDistribution();
  console.log("Rating distribution:");
  for (const [rating, count] of [...ratings.entries()].sort((a, b) => (a[0] ?? 99) - (b[0] ?? 99))) {
    console.log(`  ${rating === null ? "unrated" : rating + "★"}: ${count}`);
  }
  console.log();

  // Load assets
  let assets;
  if (sampleSize > 0) {
    console.log(`Loading ${sampleSize} most recent assets...`);
    assets = await adapter.getSampleAssets(sampleSize);
  } else {
    console.log(`Loading all ${totalCount} assets (this may take a moment)...`);
    assets = await adapter.getAllAssets((loaded, total) => {
      process.stdout.write(`\r  ${loaded}/${total} loaded`);
    });
    console.log();
  }

  console.log(`Loaded ${assets.length} assets with embeddings\n`);

  // Cluster
  const { groups, stats } = clusterAssets(assets, config);

  console.log();
  console.log("=== Clustering Results ===");
  console.log(`Total assets:     ${stats.totalAssets}`);
  console.log(`Groups found:     ${stats.totalGroups}`);
  console.log(`Singletons:       ${stats.singletons}`);
  console.log(`Largest group:    ${stats.largestGroup}`);
  console.log(`Avg group size:   ${stats.avgGroupSize}`);
  console.log(`Edges created:    ${stats.edgesCreated}`);
  console.log();

  // Show top groups
  const showCount = Math.min(15, groups.length);
  console.log(`=== Top ${showCount} Groups ===`);
  for (let i = 0; i < showCount; i++) {
    const g = groups[i];
    const times = g.assets.map((a) => a.asset.fileCreatedAt);
    const earliest = new Date(Math.min(...times.map((t) => t.getTime())));
    const rated = g.assets.filter((a) => a.asset.rating != null && a.asset.rating > 0);

    console.log(
      `\n[${g.id}] ${g.assets.length} photos | span: ${g.timeSpanMinutes}min | dist: ${g.avgDistance} | ${earliest.toISOString().slice(0, 16)}`
    );
    const names = g.assets.map((a) => a.asset.filename).join(", ");
    console.log(`  ${names.length > 120 ? names.slice(0, 120) + "..." : names}`);
    if (rated.length > 0) {
      console.log(`  Rated: ${rated.map((a) => `${a.asset.filename}=${a.asset.rating}★`).join(", ")}`);
    }
  }

  // Size distribution
  console.log("\n=== Group Size Distribution ===");
  const sizeDist = new Map<number, number>();
  for (const g of groups) sizeDist.set(g.assets.length, (sizeDist.get(g.assets.length) || 0) + 1);
  for (const [size, count] of [...sizeDist.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${size} photos: ${count} groups (${count * size} total)`);
  }

  const inGroups = groups.reduce((s, g) => s + g.assets.length, 0);
  console.log(`\nPhotos in groups: ${inGroups} / ${stats.totalAssets} (${Math.round((inGroups / stats.totalAssets) * 100)}%)`);
  console.log(`Potential culls: ~${inGroups - groups.length}`);

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
        path: a.asset.path,
      })),
    }));
    writeFileSync(jsonOutput, JSON.stringify(output, null, 2));
    console.log(`\nJSON written to ${jsonOutput}`);
  }
} finally {
  await adapter.close();
}
