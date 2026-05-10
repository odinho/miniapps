/**
 * Pure state derivation functions for immich-cull.
 *
 * Three-layer model:
 *   1. llmState      — derived from LLM data + keepLevel (read-only)
 *   2. manualOverrides — sparse map of explicit user choices
 *   3. effectiveState — manualOverrides[id] ?? llmState[id]
 */

import type { LlmResult, LlmImage } from "./api";

export type AssetState = "keep" | "cull" | null;

/** Derive keep/cull for every photo from LLM data at a given keepLevel. */
export function deriveLlmState(
  llm: LlmResult | null,
  keepLevel: number,
): Record<string, AssetState> {
  const out: Record<string, AssetState> = {};
  if (!llm) return out;

  const sgs = llm.similaritySubgroups ?? [];
  const inSubgroup = new Set<string>();

  // Subgroup photos: at level 0 use LLM's exact picks,
  // at other levels expand/contract from quality-ordered list
  for (const sg of sgs) {
    const ids = sg.imageIds; // quality-ordered (best first)
    const keepIds = new Set(sg.recommendedKeepIds);
    const adjustedKeep = Math.max(1, Math.min(ids.length, sg.recommendedKeepCount + keepLevel));

    if (adjustedKeep === sg.recommendedKeepCount) {
      // Level 0 (or equivalent): use LLM's exact picks
      for (const id of ids) {
        out[id] = keepIds.has(id) ? "keep" : "cull";
        inSubgroup.add(id);
      }
    } else if (adjustedKeep > sg.recommendedKeepCount) {
      // Expanding: keep LLM picks + add next-best from quality order
      let extra = adjustedKeep - sg.recommendedKeepCount;
      for (const id of ids) {
        if (keepIds.has(id)) {
          out[id] = "keep";
        } else if (extra > 0) {
          out[id] = "keep";
          extra--;
        } else {
          out[id] = "cull";
        }
        inSubgroup.add(id);
      }
    } else {
      // Contracting: drop worst kept photos (from end of quality order)
      const keptInOrder = ids.filter((id) => keepIds.has(id));
      const keepNow = new Set(keptInOrder.slice(0, adjustedKeep));
      for (const id of ids) {
        out[id] = keepNow.has(id) ? "keep" : "cull";
        inSubgroup.add(id);
      }
    }
  }

  // Singleton photos:
  // - At level 0: use LLM's per-image keep/cull
  // - At negative levels (below subgroup floor): also cull low-star singletons
  // - At positive levels (above subgroup ceiling): promote culled singletons by star rating
  const minSgLevel =
    sgs.length > 0 ? -Math.max(...sgs.map((sg) => sg.recommendedKeepCount - 1), 0) : 0;
  const maxSgLevel =
    sgs.length > 0
      ? Math.max(...sgs.map((sg) => sg.imageIds.length - sg.recommendedKeepCount), 0)
      : 0;
  const aggressiveLevel = keepLevel - minSgLevel; // negative = cull singletons
  const generousLevel = keepLevel - maxSgLevel; // positive = promote singletons

  for (const img of llm.images ?? []) {
    if (inSubgroup.has(img.imageId)) continue;
    if (aggressiveLevel < 0) {
      // Below subgroup floor: cull singletons by star rating
      if (aggressiveLevel <= -2 && img.suggestedStars <= 1) {
        out[img.imageId] = "cull";
      } else if (aggressiveLevel <= -1 && img.suggestedStars === 0) {
        out[img.imageId] = "cull";
      } else {
        out[img.imageId] = img.llmKeepCull ?? "keep";
      }
    } else if (generousLevel > 0) {
      // Above subgroup ceiling: promote culled singletons by star rating
      if (generousLevel >= 2) {
        out[img.imageId] = "keep"; // promote everything
      } else {
        // generousLevel === 1: promote singletons with stars >= 1
        out[img.imageId] = img.suggestedStars >= 1 ? "keep" : (img.llmKeepCull ?? "keep");
      }
    } else {
      out[img.imageId] = img.llmKeepCull ?? "keep";
    }
  }

  return out;
}

/** Merge llmState with consensus and manual overrides. Manual wins, then consensus, then LLM. */
export function mergeStates(
  assetIds: string[],
  llmState: Record<string, AssetState>,
  manualOverrides: Record<string, AssetState>,
  consensusOverrides: Record<string, AssetState> = {},
): Record<string, AssetState> {
  const out: Record<string, AssetState> = {};
  for (const id of assetIds) {
    out[id] = manualOverrides[id] ?? consensusOverrides[id] ?? llmState[id] ?? null;
  }
  return out;
}

/** Count keeps and culls. */
export function countStates(
  assetIds: string[],
  states: Record<string, AssetState>,
): { kept: number; culled: number } {
  let kept = 0,
    culled = 0;
  for (const id of assetIds) {
    if (states[id] === "keep") kept++;
    else if (states[id] === "cull") culled++;
  }
  return { kept, culled };
}

/** Count keeps/culls at a given level from LLM data only (no manual overrides). */
export function countAtLevel(
  llm: LlmResult | null,
  level: number,
): { kept: number; culled: number } {
  const s = deriveLlmState(llm, level);
  let kept = 0,
    culled = 0;
  for (const v of Object.values(s)) {
    if (v === "keep") kept++;
    else if (v === "cull") culled++;
  }
  return { kept, culled };
}

/** Find the next keepLevel in a direction that actually changes the keep/cull split. */
export function findNextEffectiveLevel(
  llm: LlmResult | null,
  currentLevel: number,
  direction: 1 | -1,
): number | null {
  const cur = countAtLevel(llm, currentLevel);
  for (let l = currentLevel + direction, i = 0; i < 30; l += direction, i++) {
    const c = countAtLevel(llm, l);
    if (c.kept !== cur.kept || c.culled !== cur.culled) return l;
  }
  return null;
}

/** Compute effective stars: primary keeper in each subgroup gets max, others get 0. */
export function computeEffectiveStars(
  llm: LlmResult | null,
  effectiveState: Record<string, AssetState>,
  llmMap: Record<string, LlmImage>,
): Record<string, number> {
  const map: Record<string, number> = {};
  if (!llm) return map;
  const sgs = llm.similaritySubgroups ?? [];
  const inSg = new Set(sgs.flatMap((sg) => sg.imageIds));

  for (const sg of sgs) {
    const maxStars = Math.max(...sg.imageIds.map((id) => llmMap[id]?.suggestedStars ?? 0));
    const primaryKeeper = sg.imageIds.find((id) => effectiveState[id] === "keep");
    for (const id of sg.imageIds) {
      map[id] = id === primaryKeeper ? maxStars : 0;
    }
  }

  // Singletons keep their own rating
  for (const img of llm.images ?? []) {
    if (!inSg.has(img.imageId)) {
      map[img.imageId] = img.suggestedStars;
    }
  }
  return map;
}

/** Compute aggressive-level info for labels. */
export function computeSgStats(
  llm: LlmResult | null,
  keepLevel: number,
): { isAggressive: boolean; singletonCount: number; singletonsCulled: number } {
  if (!llm) return { isAggressive: false, singletonCount: 0, singletonsCulled: 0 };
  const sgs = llm.similaritySubgroups ?? [];
  const imgs = llm.images ?? [];
  const inSg = new Set(sgs.flatMap((sg) => sg.imageIds));
  const singletons = imgs.filter((img) => !inSg.has(img.imageId));

  const minSgLevel =
    sgs.length > 0 ? -Math.max(...sgs.map((sg) => sg.recommendedKeepCount - 1), 0) : 0;
  const aggLevel = keepLevel - minSgLevel;
  const singletonsCulled =
    aggLevel < 0
      ? singletons.filter(
          (img) =>
            (aggLevel <= -2 && img.suggestedStars <= 1) ||
            (aggLevel <= -1 && img.suggestedStars === 0),
        ).length
      : 0;

  return { isAggressive: aggLevel < 0, singletonCount: singletons.length, singletonsCulled };
}
