#!/usr/bin/env tsx
/** Find specific groups by size and date for LLM testing */
import { FacetAdapter } from "../db/facet-adapter.js";
import { clusterAssets } from "../clustering/engine.js";
import { DEFAULT_CLUSTER_CONFIG } from "../shared/types.js";
import { batchBySession } from "../batching/session-batcher.js";
import { resolve } from "path";

const dbPath = process.argv[2] ?? resolve(import.meta.dirname ?? ".", "../../..", "facet/photo_scores_pro.db");
const adapter = new FacetAdapter(dbPath);
const assets = adapter.getAllAssets();
adapter.close();

const { groups } = clusterAssets(assets, DEFAULT_CLUSTER_CONFIG, () => {});

console.log("=== Looking for specific groups ===\n");

// 12 photos, ~14 feb 25, 13.4min
for (const g of groups) {
  if (g.assets.length === 12) {
    const d = g.assets[0].asset.fileCreatedAt;
    if (d.getFullYear() === 2025 && d.getMonth() === 1 && d.getDate() === 14 && g.timeSpanMinutes > 13) {
      console.log("GROUP A (14 feb 25, 12 photos, 13.4min):", g.id);
      g.assets.forEach(a => console.log("  ", a.asset.filename));
    }
  }
}

// 12 photos, ~7 aug 24, 1.4min
for (const g of groups) {
  if (g.assets.length === 12) {
    const d = g.assets[0].asset.fileCreatedAt;
    if (d.getFullYear() === 2024 && d.getMonth() === 7 && g.timeSpanMinutes > 1.3 && g.timeSpanMinutes < 1.5) {
      console.log("\nGROUP B (7 aug 24, 12 photos, 1.4min):", g.id);
      g.assets.forEach(a => console.log("  ", a.asset.filename));
    }
  }
}

// Also show as session batches — find which batch they're in
console.log("\n=== Session batches containing these dates ===\n");
const batches = batchBySession(assets);
for (const b of batches) {
  const hasAug7 = b.assets.some(a => {
    const d = a.fileCreatedAt;
    return d.getFullYear() === 2024 && d.getMonth() === 7 && d.getDate() === 7;
  });
  const hasFeb14 = b.assets.some(a => {
    const d = a.fileCreatedAt;
    return d.getFullYear() === 2025 && d.getMonth() === 1 && d.getDate() === 14;
  });
  if (hasAug7) {
    console.log(`Aug 7 batch: ${b.id}, ${b.assets.length} photos, ${b.source}`);
    b.assets.slice(0, 5).forEach(a => console.log("  ", a.filename, a.fileCreatedAt.toISOString().slice(0, 19)));
    if (b.assets.length > 5) console.log(`  ... and ${b.assets.length - 5} more`);
  }
  if (hasFeb14) {
    console.log(`Feb 14 batch: ${b.id}, ${b.assets.length} photos, ${b.source}`);
    b.assets.slice(0, 5).forEach(a => console.log("  ", a.filename, a.fileCreatedAt.toISOString().slice(0, 19)));
    if (b.assets.length > 5) console.log(`  ... and ${b.assets.length - 5} more`);
  }
}
