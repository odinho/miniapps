import { describe, expect, it } from "vitest";
import { applyFaceCoveragePostCheck } from "../face-coverage.js";
import type { ImageAssessment } from "../types.js";

function mkImg(id: string, keep: boolean): ImageAssessment {
  return {
    imageId: id,
    suggestedStars: 1,
    categories: ["portrait"],
    briefNote: "note",
    similaritySubgroupId: null,
    llmKeepCull: keep ? "keep" : "cull",
  };
}

describe("applyFaceCoveragePostCheck", () => {
  it("returns unchanged when no faces are present", () => {
    const images = [mkImg("a", true), mkImg("b", false)];
    const r = applyFaceCoveragePostCheck(images, new Map());
    expect(r.promoted).toEqual([]);
    expect(r.missingBefore).toEqual([]);
    expect(r.images).toBe(images);
  });

  it("returns unchanged when every named person is already covered", () => {
    const images = [mkImg("a", true), mkImg("b", false)];
    const people = new Map<string, string[]>([
      ["a", ["name:Alice", "name:Bob"]],
      ["b", ["name:Alice"]],
    ]);
    const r = applyFaceCoveragePostCheck(images, people);
    expect(r.promoted).toEqual([]);
    expect(r.missingBefore).toEqual([]);
  });

  it("promotes the single candidate needed to cover a missing person", () => {
    const images = [mkImg("a", true), mkImg("b", false), mkImg("c", false)];
    const people = new Map<string, string[]>([
      ["a", ["name:Alice"]],
      ["b", ["name:Thomas"]],
      ["c", []],
    ]);
    const r = applyFaceCoveragePostCheck(images, people);
    expect(r.missingBefore).toEqual(["name:Thomas"]);
    expect(r.promoted).toEqual(["b"]);
    expect(r.missingAfter).toEqual([]);
    expect(r.images.find((i) => i.imageId === "b")?.llmKeepCull).toBe("keep");
    expect(r.images.find((i) => i.imageId === "b")?.briefNote).toContain("face-cover");
    // Non-promoted images are untouched
    expect(r.images.find((i) => i.imageId === "c")?.llmKeepCull).toBe("cull");
  });

  it("prefers a group shot over a solo shot when both cover the missing person", () => {
    const images = [mkImg("a", true), mkImg("solo", false), mkImg("group", false)];
    const people = new Map<string, string[]>([
      ["a", ["name:Alice"]],
      ["solo", ["name:Thomas"]],
      ["group", ["name:Thomas", "name:Emma", "name:Oskar"]],
    ]);
    const r = applyFaceCoveragePostCheck(images, people);
    // Both cover Thomas (only missing). Group shot has more total faces — prefer.
    expect(r.promoted).toEqual(["group"]);
  });

  it("greedy set-cover picks one photo that covers two missing people", () => {
    const images = [
      mkImg("a", true),
      mkImg("both", false),
      mkImg("single1", false),
      mkImg("single2", false),
    ];
    const people = new Map<string, string[]>([
      ["a", ["name:Alice"]],
      ["both", ["name:Thomas", "name:Emma"]],
      ["single1", ["name:Thomas"]],
      ["single2", ["name:Emma"]],
    ]);
    const r = applyFaceCoveragePostCheck(images, people);
    // Should pick 'both' once, not promote both singletons
    expect(r.promoted).toEqual(["both"]);
    expect(r.missingAfter).toEqual([]);
  });

  it("does not promote keepers", () => {
    const images = [mkImg("a", true), mkImg("b", true), mkImg("c", false)];
    const people = new Map<string, string[]>([
      ["a", ["name:Alice"]],
      ["b", ["name:Thomas"]],
      ["c", ["name:Emma"]],
    ]);
    const r = applyFaceCoveragePostCheck(images, people);
    // Alice + Thomas already covered by a, b. Only Emma missing; c gets promoted.
    expect(r.promoted).toEqual(["c"]);
  });

  it("leaves people uncoverable when they only appear in existing keepers", () => {
    // If a person only appears in photos already marked keep, they're covered;
    // we're testing the opposite: a person only appears in photos with null state.
    const images: ImageAssessment[] = [
      { ...mkImg("a", true), llmKeepCull: "keep" },
      { ...mkImg("b", false), llmKeepCull: null as any },
    ];
    const people = new Map<string, string[]>([
      ["a", ["name:Alice"]],
      ["b", ["name:Thomas"]],
    ]);
    const r = applyFaceCoveragePostCheck(images, people);
    // b has llmKeepCull=null, so not a valid cull candidate for promotion
    expect(r.promoted).toEqual([]);
    expect(r.missingBefore).toEqual(["name:Thomas"]);
    expect(r.missingAfter).toEqual(["name:Thomas"]);
  });
});
