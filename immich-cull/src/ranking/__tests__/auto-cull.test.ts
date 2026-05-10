import { describe, it, expect } from "vitest";
import { classifyBatchForAutoCull } from "../auto-cull.js";
import type { ImageAssessment, SimilaritySubgroup } from "../types.js";

function makeImage(overrides: Partial<ImageAssessment> & { imageId: string }): ImageAssessment {
  return {
    suggestedStars: 0,
    categories: [],
    briefNote: "",
    llmKeepCull: "cull",
    similaritySubgroupId: null,
    ...overrides,
  };
}

function makeSubgroup(
  overrides: Partial<SimilaritySubgroup> & { subgroupId: string; imageIds: string[] },
): SimilaritySubgroup {
  const keepCount = overrides.recommendedKeepCount ?? 1;
  return {
    subgroupType: "burst",
    recommendedKeepCount: keepCount,
    recommendedKeepIds: overrides.imageIds.slice(0, keepCount),
    cullIds: overrides.imageIds.slice(keepCount),
    rationale: "",
    confidence: 0.8,
    ...overrides,
  };
}

describe("classifyBatchForAutoCull", () => {
  it("auto-culls 0-star cull in subgroup with keeper and size >= 3", () => {
    const images = [
      makeImage({
        imageId: "a",
        suggestedStars: 2,
        llmKeepCull: "keep",
        similaritySubgroupId: "sg1",
      }),
      makeImage({
        imageId: "b",
        suggestedStars: 0,
        llmKeepCull: "cull",
        similaritySubgroupId: "sg1",
      }),
      makeImage({
        imageId: "c",
        suggestedStars: 0,
        llmKeepCull: "cull",
        similaritySubgroupId: "sg1",
      }),
    ];
    const subgroups = [
      makeSubgroup({ subgroupId: "sg1", imageIds: ["a", "b", "c"], recommendedKeepCount: 1 }),
    ];
    const result = classifyBatchForAutoCull(images, subgroups);
    expect(result.autoCullHigh).toBe(2); // keeper has 2 stars → high confidence
    expect(result.review).toBe(1); // the keeper is review (not cull)
    expect(result.classifications.find((c) => c.assetId === "b")?.tier).toBe("auto-cull-high");
    expect(result.classifications.find((c) => c.assetId === "c")?.tier).toBe("auto-cull-high");
  });

  it("sends 1-star cull to review even in subgroup with keeper", () => {
    const images = [
      makeImage({
        imageId: "a",
        suggestedStars: 3,
        llmKeepCull: "keep",
        similaritySubgroupId: "sg1",
      }),
      makeImage({
        imageId: "b",
        suggestedStars: 1,
        llmKeepCull: "cull",
        similaritySubgroupId: "sg1",
      }),
      makeImage({
        imageId: "c",
        suggestedStars: 0,
        llmKeepCull: "cull",
        similaritySubgroupId: "sg1",
      }),
    ];
    const subgroups = [
      makeSubgroup({ subgroupId: "sg1", imageIds: ["a", "b", "c"], recommendedKeepCount: 1 }),
    ];
    const result = classifyBatchForAutoCull(images, subgroups);
    expect(result.classifications.find((c) => c.assetId === "b")?.tier).toBe("review");
    expect(result.classifications.find((c) => c.assetId === "c")?.tier).toBe("auto-cull-high"); // keeper has 3 stars
  });

  it("sends singleton cull to review", () => {
    const images = [
      makeImage({
        imageId: "a",
        suggestedStars: 0,
        llmKeepCull: "cull",
        similaritySubgroupId: null,
      }),
    ];
    const result = classifyBatchForAutoCull(images, []);
    expect(result.autoCull).toBe(0);
    expect(result.review).toBe(1);
    expect(result.classifications[0].reason).toBe("Singleton (no subgroup)");
  });

  it("sends cull to review when subgroup has no keeper", () => {
    const images = [
      makeImage({
        imageId: "a",
        suggestedStars: 0,
        llmKeepCull: "cull",
        similaritySubgroupId: "sg1",
      }),
      makeImage({
        imageId: "b",
        suggestedStars: 0,
        llmKeepCull: "cull",
        similaritySubgroupId: "sg1",
      }),
      makeImage({
        imageId: "c",
        suggestedStars: 0,
        llmKeepCull: "cull",
        similaritySubgroupId: "sg1",
      }),
    ];
    const subgroups = [
      makeSubgroup({
        subgroupId: "sg1",
        imageIds: ["a", "b", "c"],
        recommendedKeepCount: 0,
        recommendedKeepIds: [],
        cullIds: ["a", "b", "c"],
      }),
    ];
    const result = classifyBatchForAutoCull(images, subgroups);
    expect(result.autoCull).toBe(0);
    expect(result.review).toBe(3);
    expect(result.classifications[0].reason).toBe("Subgroup has no keeper");
  });

  it("sends cull to review when subgroup has only 2 photos", () => {
    const images = [
      makeImage({
        imageId: "a",
        suggestedStars: 1,
        llmKeepCull: "keep",
        similaritySubgroupId: "sg1",
      }),
      makeImage({
        imageId: "b",
        suggestedStars: 0,
        llmKeepCull: "cull",
        similaritySubgroupId: "sg1",
      }),
    ];
    const subgroups = [
      makeSubgroup({ subgroupId: "sg1", imageIds: ["a", "b"], recommendedKeepCount: 1 }),
    ];
    const result = classifyBatchForAutoCull(images, subgroups);
    expect(result.autoCull).toBe(0);
    expect(result.review).toBe(2);
    expect(result.classifications.find((c) => c.assetId === "b")?.reason).toContain("too small");
  });

  it("sends LLM keep to review", () => {
    const images = [
      makeImage({
        imageId: "a",
        suggestedStars: 3,
        llmKeepCull: "keep",
        similaritySubgroupId: "sg1",
      }),
      makeImage({
        imageId: "b",
        suggestedStars: 0,
        llmKeepCull: "cull",
        similaritySubgroupId: "sg1",
      }),
      makeImage({
        imageId: "c",
        suggestedStars: 0,
        llmKeepCull: "cull",
        similaritySubgroupId: "sg1",
      }),
    ];
    const subgroups = [
      makeSubgroup({ subgroupId: "sg1", imageIds: ["a", "b", "c"], recommendedKeepCount: 1 }),
    ];
    const result = classifyBatchForAutoCull(images, subgroups);
    expect(result.classifications.find((c) => c.assetId === "a")?.tier).toBe("review");
    expect(result.classifications.find((c) => c.assetId === "a")?.reason).toBe("LLM says keep");
  });

  it("handles mixed subgroups and singletons", () => {
    const images = [
      // Subgroup of 4: 1 keeper, 3 culls
      makeImage({
        imageId: "a",
        suggestedStars: 2,
        llmKeepCull: "keep",
        similaritySubgroupId: "sg1",
      }),
      makeImage({
        imageId: "b",
        suggestedStars: 0,
        llmKeepCull: "cull",
        similaritySubgroupId: "sg1",
      }),
      makeImage({
        imageId: "c",
        suggestedStars: 0,
        llmKeepCull: "cull",
        similaritySubgroupId: "sg1",
      }),
      makeImage({
        imageId: "d",
        suggestedStars: 0,
        llmKeepCull: "cull",
        similaritySubgroupId: "sg1",
      }),
      // Singleton cull
      makeImage({
        imageId: "e",
        suggestedStars: 0,
        llmKeepCull: "cull",
        similaritySubgroupId: null,
      }),
      // Singleton keep
      makeImage({
        imageId: "f",
        suggestedStars: 1,
        llmKeepCull: "keep",
        similaritySubgroupId: null,
      }),
    ];
    const subgroups = [
      makeSubgroup({ subgroupId: "sg1", imageIds: ["a", "b", "c", "d"], recommendedKeepCount: 1 }),
    ];
    const result = classifyBatchForAutoCull(images, subgroups);
    // b is rank 1/3 = 0.33 (top half → standard), c is 2/3 = 0.67 and d is 3/3 = 1.0 (bottom half → high)
    expect(result.autoCullHigh).toBe(2); // c, d — keeper 2★ + bottom half
    expect(result.autoCull).toBe(1); // b — keeper 2★ but top half
    expect(result.review).toBe(3); // a (keep), e (singleton), f (keep)
    expect(result.total).toBe(6);
  });

  it("uses standard tier when keeper has < 2 stars", () => {
    const images = [
      makeImage({
        imageId: "a",
        suggestedStars: 1,
        llmKeepCull: "keep",
        similaritySubgroupId: "sg1",
      }),
      makeImage({
        imageId: "b",
        suggestedStars: 0,
        llmKeepCull: "cull",
        similaritySubgroupId: "sg1",
      }),
      makeImage({
        imageId: "c",
        suggestedStars: 0,
        llmKeepCull: "cull",
        similaritySubgroupId: "sg1",
      }),
    ];
    const subgroups = [
      makeSubgroup({ subgroupId: "sg1", imageIds: ["a", "b", "c"], recommendedKeepCount: 1 }),
    ];
    const result = classifyBatchForAutoCull(images, subgroups);
    expect(result.autoCullHigh).toBe(0);
    expect(result.autoCull).toBe(2); // standard tier: keeper only has 1 star
    expect(result.classifications.find((c) => c.assetId === "b")?.tier).toBe("auto-cull");
  });

  it("handles empty inputs", () => {
    const result = classifyBatchForAutoCull([], []);
    expect(result.autoCull).toBe(0);
    expect(result.review).toBe(0);
    expect(result.total).toBe(0);
  });

  it("handles subgroup not found in map", () => {
    const images = [
      makeImage({
        imageId: "a",
        suggestedStars: 0,
        llmKeepCull: "cull",
        similaritySubgroupId: "missing",
      }),
    ];
    const result = classifyBatchForAutoCull(images, []);
    expect(result.review).toBe(1);
    expect(result.classifications[0].reason).toBe("Subgroup not found");
  });

  it("handles undecided llmKeepCull", () => {
    const images = [
      makeImage({
        imageId: "a",
        suggestedStars: 0,
        llmKeepCull: null,
        similaritySubgroupId: "sg1",
      }),
      makeImage({
        imageId: "b",
        suggestedStars: 0,
        llmKeepCull: "keep",
        similaritySubgroupId: "sg1",
      }),
      makeImage({
        imageId: "c",
        suggestedStars: 0,
        llmKeepCull: "cull",
        similaritySubgroupId: "sg1",
      }),
    ];
    const subgroups = [
      makeSubgroup({ subgroupId: "sg1", imageIds: ["a", "b", "c"], recommendedKeepCount: 1 }),
    ];
    const result = classifyBatchForAutoCull(images, subgroups);
    expect(result.classifications.find((c) => c.assetId === "a")?.tier).toBe("review");
    expect(result.classifications.find((c) => c.assetId === "a")?.reason).toBe(
      "LLM says undecided",
    );
  });

  it("reason includes subgroup type and size", () => {
    const images = [
      makeImage({
        imageId: "a",
        suggestedStars: 1,
        llmKeepCull: "keep",
        similaritySubgroupId: "sg1",
      }),
      makeImage({
        imageId: "b",
        suggestedStars: 0,
        llmKeepCull: "cull",
        similaritySubgroupId: "sg1",
      }),
      makeImage({
        imageId: "c",
        suggestedStars: 0,
        llmKeepCull: "cull",
        similaritySubgroupId: "sg1",
      }),
      makeImage({
        imageId: "d",
        suggestedStars: 0,
        llmKeepCull: "cull",
        similaritySubgroupId: "sg1",
      }),
    ];
    const subgroups = [
      makeSubgroup({
        subgroupId: "sg1",
        imageIds: ["a", "b", "c", "d"],
        subgroupType: "near_duplicate",
        recommendedKeepCount: 1,
      }),
    ];
    const result = classifyBatchForAutoCull(images, subgroups);
    const bc = result.classifications.find((c) => c.assetId === "b")!;
    expect(bc.reason).toContain("near_duplicate");
    expect(bc.reason).toContain("4 photos");
  });
});
