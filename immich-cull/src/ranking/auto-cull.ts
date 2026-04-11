/**
 * Auto-cull classification: pure functions to classify photos as
 * safe to auto-cull vs needing human review.
 *
 * Based on analysis of 3174 manual decisions vs LLM recommendations.
 * Two confidence tiers on gemini-3.1-flash-lite-preview (2024+ data):
 *
 *   HIGH: stars=0, sg_size>=3, keeper has 2+ stars, bottom half of quality order
 *         → 2.1% wrong-cull, 30.9% coverage
 *
 *   STANDARD: stars=0, sg_size>=3, sg has keeper (remaining)
 *         → 9.7% wrong-cull, 56.4% coverage
 */

import type { ImageAssessment, SimilaritySubgroup } from "./types.js";

export type AutoCullTier = "auto-cull-high" | "auto-cull" | "review";

export interface AutoCullClassification {
  assetId: string;
  tier: AutoCullTier;
  reason: string;
}

export interface AutoCullSummary {
  autoCullHigh: number;
  autoCull: number;
  review: number;
  total: number;
  classifications: AutoCullClassification[];
}

/**
 * Classify every photo in an LLM result into tiers:
 * - auto-cull-high: very safe to cull (3.8% wrong-cull rate)
 * - auto-cull: safe to cull (9.7% wrong-cull rate)
 * - review: needs human eyes
 */
export function classifyBatchForAutoCull(
  images: ImageAssessment[],
  subgroups: SimilaritySubgroup[],
): AutoCullSummary {
  const sgMap = new Map<string, SimilaritySubgroup>();
  for (const sg of subgroups) sgMap.set(sg.subgroupId, sg);

  // Pre-compute per-subgroup: has keeper? max keeper stars?
  const sgHasKeeper = new Map<string, boolean>();
  const sgMaxKeeperStars = new Map<string, number>();
  for (const sg of subgroups) {
    let hasKeep = false;
    let maxStars = 0;
    for (const img of images) {
      if (img.similaritySubgroupId === sg.subgroupId && img.llmKeepCull === "keep") {
        hasKeep = true;
        maxStars = Math.max(maxStars, img.suggestedStars);
      }
    }
    sgHasKeeper.set(sg.subgroupId, hasKeep);
    sgMaxKeeperStars.set(sg.subgroupId, maxStars);
  }

  const assessed = new Set(images.map((img) => img.imageId));
  const classifications: AutoCullClassification[] = [];
  let autoCullHigh = 0;
  let autoCull = 0;
  let review = 0;

  for (const img of images) {
    const c = classifyPhoto(img, sgMap, sgHasKeeper, sgMaxKeeperStars, assessed);
    classifications.push(c);
    if (c.tier === "auto-cull-high") autoCullHigh++;
    else if (c.tier === "auto-cull") autoCull++;
    else review++;
  }

  return { autoCullHigh, autoCull, review, total: images.length, classifications };
}

function classifyPhoto(
  img: ImageAssessment,
  sgMap: Map<string, SimilaritySubgroup>,
  sgHasKeeper: Map<string, boolean>,
  sgMaxKeeperStars: Map<string, number>,
  assessed: Set<string>,
): AutoCullClassification {
  const assetId = img.imageId;

  // Must have explicit LLM assessment
  if (!assessed.has(assetId)) {
    return { assetId, tier: "review", reason: "No LLM assessment" };
  }

  // Must be a cull recommendation
  if (img.llmKeepCull !== "cull") {
    return { assetId, tier: "review", reason: `LLM says ${img.llmKeepCull ?? "undecided"}` };
  }

  // Must have stars === 0
  if (img.suggestedStars > 0) {
    return { assetId, tier: "review", reason: `Stars ${img.suggestedStars} > 0` };
  }

  // Must be in a subgroup
  const sgId = img.similaritySubgroupId;
  if (!sgId) {
    return { assetId, tier: "review", reason: "Singleton (no subgroup)" };
  }

  const sg = sgMap.get(sgId);
  if (!sg) {
    return { assetId, tier: "review", reason: "Subgroup not found" };
  }

  // Subgroup must have >= 3 photos
  if (sg.imageIds.length < 3) {
    return { assetId, tier: "review", reason: `Subgroup too small (${sg.imageIds.length})` };
  }

  // Subgroup must have at least one keeper
  if (!sgHasKeeper.get(sgId)) {
    return { assetId, tier: "review", reason: "Subgroup has no keeper" };
  }

  // Compute quality rank position (0 = best, 1 = worst)
  const rank = sg.imageIds.indexOf(img.imageId);
  const rankFrac = rank >= 0 ? rank / Math.max(sg.imageIds.length - 1, 1) : 1;

  // High confidence: keeper >= 2 stars AND photo in bottom half of quality order
  // Analysis: 2.1% wrong-cull, 30.9% coverage on 2024 discriminating batches
  const maxKeeperStars = sgMaxKeeperStars.get(sgId) ?? 0;
  if (maxKeeperStars >= 2 && rankFrac >= 0.5) {
    return {
      assetId,
      tier: "auto-cull-high",
      reason: `0-star cull, keeper ${maxKeeperStars}★, rank ${rank + 1}/${sg.imageIds.length} (${sg.subgroupType})`,
    };
  }

  // Standard confidence: remaining photos meeting base criteria
  return {
    assetId,
    tier: "auto-cull",
    reason: `0-star cull in ${sg.subgroupType} subgroup (${sg.imageIds.length} photos, keeper ${maxKeeperStars}★)`,
  };
}
