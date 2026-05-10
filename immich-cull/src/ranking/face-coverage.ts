/**
 * Face-coverage post-check for LLM cull decisions.
 *
 * Problem: the LLM sometimes picks photos that are individually great but
 * collectively drop a person from the batch. Example from grading:
 *   "Thomas is missing from all the breakfast-table pictures."
 * F1 = 0.89 (numerically great) but severity = 2 (real regret).
 *
 * Fix: after the LLM emits its keep/cull decisions, run a deterministic
 * post-check. For each NAMED person appearing in the batch, ensure at least
 * one keeper contains them. If not, promote the photo that covers the most
 * still-missing people (greedy set-cover).
 *
 * Why named-only: Immich's face clustering often splits the same person
 * into named + unnamed clusters. Including unnamed clusters causes spurious
 * promotions of near-duplicates. Validated empirically on 80 graded batches:
 *
 *   - v1_prod alone:                96.2% acceptable (3 sev-2)
 *   - all-cluster face-coverage:    95.0% (4 sev-2 — NET WORSE)
 *   - NAMED-only face-coverage:     97.5% (2 sev-2 — STRICTLY BETTER)
 *
 * This module contains only the pure logic. The Immich face-data fetch lives
 * in src/db/immich-face-fetcher.ts.
 */

import type { ImageAssessment } from "./types.js";

export interface FaceCoverageResult {
  /** Images with promoted cull→keep flips applied. */
  images: ImageAssessment[];
  /** Asset IDs of photos promoted from cull to keep by face-coverage. */
  promoted: string[];
  /** Named people the LLM had missed before post-check. */
  missingBefore: string[];
  /** Named people still missing after post-check (culled photos don't include them). */
  missingAfter: string[];
}

/**
 * Apply named-only greedy face-coverage to a batch of LLM-rated images.
 *
 * @param images         LLM's per-photo assessment for the batch
 * @param peoplePerAsset Map of assetId → list of named-people tags (name-prefixed)
 *                       for that photo. Unnamed clusters MUST be excluded upstream.
 *                       If an asset has no entry, treated as having no faces.
 */
export function applyFaceCoveragePostCheck(
  images: ImageAssessment[],
  peoplePerAsset: Map<string, readonly string[]>,
): FaceCoverageResult {
  const allPeople = new Set<string>();
  for (const img of images) {
    for (const p of peoplePerAsset.get(img.imageId) ?? []) allPeople.add(p);
  }
  if (allPeople.size === 0) {
    return { images, promoted: [], missingBefore: [], missingAfter: [] };
  }

  // Covered = people present in at least one current keeper
  const keepSet = new Set<string>();
  for (const img of images) if (img.llmKeepCull === "keep") keepSet.add(img.imageId);

  const covered = new Set<string>();
  for (const id of keepSet) {
    for (const p of peoplePerAsset.get(id) ?? []) covered.add(p);
  }

  const missingBefore = [...allPeople].filter((p) => !covered.has(p));
  if (missingBefore.length === 0) {
    return { images, promoted: [], missingBefore: [], missingAfter: [] };
  }

  // Greedy set-cover across non-keepers.
  // Tiebreakers (in order): more still-missing covered > more total faces > earlier in batch.
  const candidateIds = images
    .filter((img) => !keepSet.has(img.imageId) && img.llmKeepCull === "cull")
    .map((img) => img.imageId);
  const promoted: string[] = [];
  const missing = new Set(missingBefore);
  const remainingCandidates = new Set(candidateIds);

  while (missing.size > 0) {
    let best: string | null = null;
    let bestNewCov = 0;
    let bestTotal = 0;
    for (const id of remainingCandidates) {
      const people = peoplePerAsset.get(id) ?? [];
      const newCov = people.filter((p) => missing.has(p)).length;
      if (newCov === 0) continue;
      const total = people.length;
      if (newCov > bestNewCov || (newCov === bestNewCov && total > bestTotal)) {
        best = id;
        bestNewCov = newCov;
        bestTotal = total;
      }
    }
    if (best === null) break;
    promoted.push(best);
    remainingCandidates.delete(best);
    for (const p of peoplePerAsset.get(best) ?? []) missing.delete(p);
  }

  if (promoted.length === 0) {
    return { images, promoted: [], missingBefore, missingAfter: [...missing] };
  }

  const promotedSet = new Set(promoted);
  const modified = images.map((img) =>
    promotedSet.has(img.imageId)
      ? {
          ...img,
          llmKeepCull: "keep" as const,
          briefNote: `${img.briefNote} [face-cover: protects named person]`.trim(),
        }
      : img,
  );

  return { images: modified, promoted, missingBefore, missingAfter: [...missing] };
}
