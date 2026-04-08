import { describe, it, expect } from "vitest";
import {
  deriveLlmState,
  mergeStates,
  countStates,
  countAtLevel,
  findNextEffectiveLevel,
  computeEffectiveStars,
  computeSgStats,
} from "../state";
import type { LlmResult, LlmImage } from "../api";

/** Helper to build minimal LLM data for tests */
function makeLlm(opts: {
  images?: Array<{ id: string; stars?: number; kc?: "keep" | "cull" | null; sg?: string | null }>;
  subgroups?: Array<{ id: string; imageIds: string[]; keepCount: number }>;
}): LlmResult {
  return {
    batchSummary: "",
    overallConfidence: 0.8,
    images: (opts.images ?? []).map((img) => ({
      imageId: img.id,
      suggestedStars: img.stars ?? 0,
      categories: [],
      briefNote: "",
      llmKeepCull: img.kc ?? null,
      similaritySubgroupId: img.sg ?? null,
    })),
    similaritySubgroups: (opts.subgroups ?? []).map((sg) => ({
      subgroupId: sg.id,
      imageIds: sg.imageIds,
      subgroupType: "burst",
      recommendedKeepCount: sg.keepCount,
      recommendedKeepIds: sg.imageIds.slice(0, sg.keepCount),
      cullIds: sg.imageIds.slice(sg.keepCount),
      rationale: "",
    })),
  };
}

function llmMapFrom(llm: LlmResult): Record<string, LlmImage> {
  const m: Record<string, LlmImage> = {};
  for (const img of llm.images) m[img.imageId] = img;
  return m;
}

describe("deriveLlmState", () => {
  it("returns empty for null llm", () => {
    expect(deriveLlmState(null, 0)).toEqual({});
  });

  it("keeps recommendedKeepCount photos in subgroup at level 0", () => {
    const llm = makeLlm({
      images: [
        { id: "a", sg: "g1" },
        { id: "b", sg: "g1" },
        { id: "c", sg: "g1" },
        { id: "d", sg: "g1" },
        { id: "e", sg: "g1" },
      ],
      subgroups: [{ id: "g1", imageIds: ["a", "b", "c", "d", "e"], keepCount: 2 }],
    });
    const state = deriveLlmState(llm, 0);
    expect(state).toEqual({ a: "keep", b: "keep", c: "cull", d: "cull", e: "cull" });
  });

  it("uses LLM's exact picks at level 0 (non-contiguous)", () => {
    const llm: LlmResult = {
      batchSummary: "",
      overallConfidence: 0.8,
      images: ["a", "b", "c", "d", "e"].map((id) => ({
        imageId: id,
        suggestedStars: 0,
        categories: [],
        briefNote: "",
        llmKeepCull: null,
        similaritySubgroupId: "g1",
      })),
      similaritySubgroups: [
        {
          subgroupId: "g1",
          imageIds: ["a", "b", "c", "d", "e"],
          subgroupType: "burst",
          recommendedKeepCount: 2,
          recommendedKeepIds: ["a", "d"], // non-contiguous: skip b,c
          cullIds: ["b", "c", "e"],
          rationale: "",
        },
      ],
    };
    const state = deriveLlmState(llm, 0);
    expect(state).toEqual({ a: "keep", b: "cull", c: "cull", d: "keep", e: "cull" });
  });

  it("expanding adds next-best from quality order", () => {
    const llm: LlmResult = {
      batchSummary: "",
      overallConfidence: 0.8,
      images: ["a", "b", "c", "d"].map((id) => ({
        imageId: id,
        suggestedStars: 0,
        categories: [],
        briefNote: "",
        llmKeepCull: null,
        similaritySubgroupId: "g1",
      })),
      similaritySubgroups: [
        {
          subgroupId: "g1",
          imageIds: ["a", "b", "c", "d"], // quality order
          subgroupType: "burst",
          recommendedKeepCount: 1,
          recommendedKeepIds: ["c"], // LLM picked c (not a)
          cullIds: ["a", "b", "d"],
          rationale: "",
        },
      ],
    };
    // At +1: keep c (LLM pick) + a (next best in quality order)
    const state = deriveLlmState(llm, 1);
    expect(state.c).toBe("keep"); // LLM's original pick
    expect(state.a).toBe("keep"); // added from quality order
    expect(state.b).toBe("cull");
    expect(state.d).toBe("cull");
  });

  it("adjusts keep count with positive keepLevel", () => {
    const llm = makeLlm({
      images: [
        { id: "a", sg: "g1" },
        { id: "b", sg: "g1" },
        { id: "c", sg: "g1" },
      ],
      subgroups: [{ id: "g1", imageIds: ["a", "b", "c"], keepCount: 1 }],
    });
    const state = deriveLlmState(llm, 1);
    expect(state).toEqual({ a: "keep", b: "keep", c: "cull" });
  });

  it("adjusts keep count with negative keepLevel", () => {
    const llm = makeLlm({
      images: [
        { id: "a", sg: "g1" },
        { id: "b", sg: "g1" },
        { id: "c", sg: "g1" },
        { id: "d", sg: "g1" },
        { id: "e", sg: "g1" },
      ],
      subgroups: [{ id: "g1", imageIds: ["a", "b", "c", "d", "e"], keepCount: 3 }],
    });
    const state = deriveLlmState(llm, -1);
    expect(state.a).toBe("keep");
    expect(state.b).toBe("keep");
    expect(state.c).toBe("cull");
  });

  it("never goes below 1 keep per subgroup", () => {
    const llm = makeLlm({
      images: [
        { id: "a", sg: "g1" },
        { id: "b", sg: "g1" },
      ],
      subgroups: [{ id: "g1", imageIds: ["a", "b"], keepCount: 1 }],
    });
    const state = deriveLlmState(llm, -10);
    expect(state.a).toBe("keep");
    expect(state.b).toBe("cull");
  });

  it("uses llmKeepCull for singletons at level 0", () => {
    const llm = makeLlm({
      images: [
        { id: "a", kc: "keep" },
        { id: "b", kc: "cull" },
        { id: "c", kc: null },
      ],
    });
    const state = deriveLlmState(llm, 0);
    expect(state).toEqual({ a: "keep", b: "cull", c: "keep" });
  });

  it("aggressively culls low-star singletons below subgroup floor", () => {
    const llm = makeLlm({
      images: [
        { id: "a", sg: "g1", stars: 2 },
        { id: "b", sg: "g1", stars: 2 },
        { id: "c", sg: "g1", stars: 2 },
        { id: "s1", stars: 0, kc: "keep" },
        { id: "s2", stars: 1, kc: "keep" },
        { id: "s3", stars: 2, kc: "keep" },
      ],
      subgroups: [{ id: "g1", imageIds: ["a", "b", "c"], keepCount: 2 }],
    });
    // minSgLevel = -(2-1) = -1. At level -2: aggLevel = -2 - (-1) = -1
    // aggLevel -1: cull 0-star singletons
    const state = deriveLlmState(llm, -2);
    expect(state.s1).toBe("cull"); // 0-star, culled
    expect(state.s2).toBe("keep"); // 1-star, kept
    expect(state.s3).toBe("keep"); // 2-star, kept
  });

  it("promotes culled singletons at generous levels", () => {
    const llm = makeLlm({
      images: [
        { id: "a", sg: "g1", stars: 2 },
        { id: "b", sg: "g1", stars: 2 },
        { id: "s1", stars: 0, kc: "cull" },
        { id: "s2", stars: 1, kc: "cull" },
        { id: "s3", stars: 2, kc: "cull" },
      ],
      subgroups: [{ id: "g1", imageIds: ["a", "b"], keepCount: 1 }],
    });
    // At level 0: singletons follow LLM (all cull)
    const state0 = deriveLlmState(llm, 0);
    expect(state0.s1).toBe("cull");
    expect(state0.s2).toBe("cull");

    // maxSgLevel = 2 - 1 = 1. At level 2: generousLevel = 2 - 1 = 1
    // generousLevel 1: promote singletons with stars >= 1
    const state2 = deriveLlmState(llm, 2);
    expect(state2.s1).toBe("cull"); // 0-star, stays culled
    expect(state2.s2).toBe("keep"); // 1-star, promoted
    expect(state2.s3).toBe("keep"); // 2-star, promoted

    // generousLevel 2+: promote everything
    const state3 = deriveLlmState(llm, 3);
    expect(state3.s1).toBe("keep"); // promoted
  });
});

describe("mergeStates", () => {
  it("manual overrides win over llm state", () => {
    const ids = ["a", "b", "c"];
    const llm = { a: "keep" as const, b: "cull" as const, c: "keep" as const };
    const manual = { b: "keep" as const };
    const result = mergeStates(ids, llm, manual);
    expect(result).toEqual({ a: "keep", b: "keep", c: "keep" });
  });

  it("falls back to null for unknown assets", () => {
    const result = mergeStates(["x"], {}, {});
    expect(result).toEqual({ x: null });
  });
});

describe("countStates", () => {
  it("counts correctly", () => {
    const states = { a: "keep" as const, b: "cull" as const, c: "keep" as const, d: null };
    expect(countStates(["a", "b", "c", "d"], states)).toEqual({ kept: 2, culled: 1 });
  });
});

describe("countAtLevel", () => {
  it("matches deriveLlmState counts", () => {
    const llm = makeLlm({
      images: [
        { id: "a", sg: "g1" },
        { id: "b", sg: "g1" },
        { id: "c", sg: "g1" },
        { id: "d", kc: "cull" },
      ],
      subgroups: [{ id: "g1", imageIds: ["a", "b", "c"], keepCount: 2 }],
    });
    expect(countAtLevel(llm, 0)).toEqual({ kept: 2, culled: 2 });
    expect(countAtLevel(llm, -1)).toEqual({ kept: 1, culled: 3 });
  });
});

describe("findNextEffectiveLevel", () => {
  it("finds next level down that changes counts", () => {
    const llm = makeLlm({
      images: [
        { id: "a", sg: "g1" },
        { id: "b", sg: "g1" },
        { id: "c", sg: "g1" },
      ],
      subgroups: [{ id: "g1", imageIds: ["a", "b", "c"], keepCount: 2 }],
    });
    expect(findNextEffectiveLevel(llm, 0, -1)).toBe(-1);
  });

  it("returns null when already at floor", () => {
    const llm = makeLlm({
      images: [
        { id: "a", sg: "g1" },
        { id: "b", sg: "g1" },
      ],
      subgroups: [{ id: "g1", imageIds: ["a", "b"], keepCount: 1 }],
    });
    // At level 0, keeps 1. At level -1, still keeps 1 (min 1). No change possible.
    expect(findNextEffectiveLevel(llm, 0, -1)).toBeNull();
  });

  it("returns null when already at ceiling", () => {
    const llm = makeLlm({
      images: [
        { id: "a", sg: "g1" },
        { id: "b", sg: "g1" },
      ],
      subgroups: [{ id: "g1", imageIds: ["a", "b"], keepCount: 2 }],
    });
    // At level 0, keeps 2 (all). Can't keep more.
    expect(findNextEffectiveLevel(llm, 0, 1)).toBeNull();
  });
});

describe("computeEffectiveStars", () => {
  it("gives max stars to primary keeper, 0 to others in subgroup", () => {
    const llm = makeLlm({
      images: [
        { id: "a", sg: "g1", stars: 3 },
        { id: "b", sg: "g1", stars: 2 },
        { id: "c", sg: "g1", stars: 3 },
      ],
      subgroups: [{ id: "g1", imageIds: ["a", "b", "c"], keepCount: 1 }],
    });
    const effective = { a: "keep" as const, b: "cull" as const, c: "cull" as const };
    const stars = computeEffectiveStars(llm, effective, llmMapFrom(llm));
    expect(stars).toEqual({ a: 3, b: 0, c: 0 });
  });

  it("transfers stars when different photo is kept", () => {
    const llm = makeLlm({
      images: [
        { id: "a", sg: "g1", stars: 3 },
        { id: "b", sg: "g1", stars: 2 },
      ],
      subgroups: [{ id: "g1", imageIds: ["a", "b"], keepCount: 1 }],
    });
    // User overrode: keep b instead of a
    const effective = { a: "cull" as const, b: "keep" as const };
    const stars = computeEffectiveStars(llm, effective, llmMapFrom(llm));
    expect(stars.a).toBe(0);
    expect(stars.b).toBe(3); // gets the subgroup max (3), not its own rating (2)
  });

  it("singletons keep their own rating", () => {
    const llm = makeLlm({
      images: [{ id: "a", stars: 2, kc: "keep" }],
    });
    const stars = computeEffectiveStars(llm, { a: "keep" }, llmMapFrom(llm));
    expect(stars.a).toBe(2);
  });
});

describe("computeSgStats", () => {
  it("detects aggressive level", () => {
    const llm = makeLlm({
      images: [
        { id: "a", sg: "g1" },
        { id: "b", sg: "g1" },
        { id: "c", sg: "g1" },
        { id: "s1", stars: 0 },
      ],
      subgroups: [{ id: "g1", imageIds: ["a", "b", "c"], keepCount: 2 }],
    });
    expect(computeSgStats(llm, 0).isAggressive).toBe(false);
    expect(computeSgStats(llm, -2).isAggressive).toBe(true);
  });
});
