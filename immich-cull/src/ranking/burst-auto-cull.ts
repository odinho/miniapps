/**
 * Burst/duplicate auto-cull: identifies photos in burst and near-duplicate
 * subgroups that can be auto-culled with zero review.
 *
 * Much more conservative than regular auto-cull — only targets groups where
 * the photos are technically interchangeable (bursts, exact duplicates).
 * Does NOT touch scene/subject subgroups (those may have contextual value).
 *
 * Criteria for zero-review auto-cull:
 *   - Subgroup type is "burst" or "near_duplicate"
 *   - The LLM recommends culling the photo
 *   - The photo has 0 stars
 *   - Subgroup has 3+ photos (enough to be confident there's redundancy)
 *     OR subgroup has 2 photos and multi-model consensus agrees on the winner
 */

import type { ImageAssessment, SimilaritySubgroup } from "./types.js";

export interface BurstCullCandidate {
  assetId: string;
  winnerId: string;
  subgroupId: string;
  subgroupType: string;
  subgroupSize: number;
  reason: string;
}

export interface BurstCullSummary {
  candidates: BurstCullCandidate[];
  groupsCulled: number;
  photosAutoCulled: number;
  photosInBurstGroups: number;
}

/**
 * Find photos safe for zero-review burst auto-cull.
 *
 * @param images    Expanded LLM image assessments
 * @param subgroups Expanded LLM similarity subgroups
 * @param consensusKeep Optional set of asset IDs where multi-model consensus says "keep"
 *                      (used to validate winner picks in 2-photo groups)
 */
export function classifyBurstAutoCull(
  images: ImageAssessment[],
  subgroups: SimilaritySubgroup[],
  consensusKeep?: Set<string>,
): BurstCullSummary {
  const imgMap = new Map<string, ImageAssessment>();
  for (const img of images) imgMap.set(img.imageId, img);

  const candidates: BurstCullCandidate[] = [];
  let groupsCulled = 0;
  let photosInBurstGroups = 0;

  for (const sg of subgroups) {
    // Only target bursts and near-duplicates — these are technically interchangeable
    if (sg.subgroupType !== "burst" && sg.subgroupType !== "near_duplicate") continue;

    photosInBurstGroups += sg.imageIds.length;

    // Need a clear winner: at least one recommended keep
    if (sg.recommendedKeepIds.length === 0) continue;

    // For 2-photo groups, require multi-model consensus on the winner
    if (sg.imageIds.length === 2 && consensusKeep) {
      const winnerId = sg.recommendedKeepIds[0];
      if (!consensusKeep.has(winnerId)) continue;
    } else if (sg.imageIds.length < 3) {
      // No consensus data and only 2 photos — skip, not confident enough
      if (!consensusKeep) continue;
      const winnerId = sg.recommendedKeepIds[0];
      if (!consensusKeep.has(winnerId)) continue;
    }

    const winnerId = sg.recommendedKeepIds[0];
    let groupHasCull = false;

    for (const assetId of sg.cullIds) {
      const img = imgMap.get(assetId);
      if (!img) continue;

      // Must be LLM-recommended cull with 0 stars
      if (img.llmKeepCull !== "cull") continue;
      if (img.suggestedStars > 0) continue;

      candidates.push({
        assetId,
        winnerId,
        subgroupId: sg.subgroupId,
        subgroupType: sg.subgroupType,
        subgroupSize: sg.imageIds.length,
        reason: `${sg.subgroupType} (${sg.imageIds.length} photos), winner: ${winnerId.slice(0, 8)}`,
      });
      groupHasCull = true;
    }

    if (groupHasCull) groupsCulled++;
  }

  return {
    candidates,
    groupsCulled,
    photosAutoCulled: candidates.length,
    photosInBurstGroups,
  };
}
