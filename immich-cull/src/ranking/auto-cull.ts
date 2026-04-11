/**
 * Auto-cull classification: pure functions to classify photos as
 * safe to auto-cull vs needing human review.
 *
 * Based on analysis of 3174 manual decisions vs LLM recommendations.
 * Best single-model strategy (3.1-flash-lite):
 *   stars=0 + in_subgroup + sg_has_keeper + sg_size>=3
 *   → 9.7% wrong-cull rate, 56.4% coverage
 */

import type { ImageAssessment, SimilaritySubgroup } from "./types.js";

export type AutoCullTier = "auto-cull" | "review";

export interface AutoCullClassification {
  assetId: string;
  tier: AutoCullTier;
  reason: string;
}

export interface AutoCullSummary {
  autoCull: number;
  review: number;
  total: number;
  classifications: AutoCullClassification[];
}

/**
 * Classify every photo in an LLM result into auto-cull vs review.
 *
 * Auto-cull criteria (ALL must be true):
 * 1. LLM says cull
 * 2. suggestedStars === 0
 * 3. In a subgroup (not singleton)
 * 4. Subgroup has at least one photo with llmKeepCull === "keep"
 * 5. Subgroup has >= 3 photos (stronger safety signal)
 * 6. Photo has an explicit LLM assessment (not omitted)
 */
export function classifyBatchForAutoCull(
  images: ImageAssessment[],
  subgroups: SimilaritySubgroup[],
): AutoCullSummary {
  const sgMap = new Map<string, SimilaritySubgroup>();
  for (const sg of subgroups) sgMap.set(sg.subgroupId, sg);

  // Pre-compute per-subgroup keeper status from images
  const sgHasKeeper = new Map<string, boolean>();
  for (const sg of subgroups) {
    const hasKeep = images.some(
      (img) => img.similaritySubgroupId === sg.subgroupId && img.llmKeepCull === "keep",
    );
    sgHasKeeper.set(sg.subgroupId, hasKeep);
  }

  // Track which assets have explicit assessments
  const assessed = new Set(images.map((img) => img.imageId));

  const classifications: AutoCullClassification[] = [];
  let autoCull = 0;
  let review = 0;

  for (const img of images) {
    const c = classifyPhoto(img, sgMap, sgHasKeeper, assessed);
    classifications.push(c);
    if (c.tier === "auto-cull") autoCull++;
    else review++;
  }

  return { autoCull, review, total: images.length, classifications };
}

function classifyPhoto(
  img: ImageAssessment,
  sgMap: Map<string, SimilaritySubgroup>,
  sgHasKeeper: Map<string, boolean>,
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

  // All criteria met
  return {
    assetId,
    tier: "auto-cull",
    reason: `0-star cull in ${sg.subgroupType} subgroup (${sg.imageIds.length} photos)`,
  };
}
