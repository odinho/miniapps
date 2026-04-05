import { describe, expect, it } from "bun:test";
import { scorePlan, selectBestPlan } from "$lib/engine/schedule.js";
import type { BabyContext, SleepEntry } from "$lib/types.js";
import type { PlanCandidate } from "$lib/engine/schedule.js";

function ctx(overrides: Partial<BabyContext> = {}): BabyContext {
  return {
    birthdate: "2025-06-12",
    ageMonths: 9,
    tz: "UTC",
    customNapCount: null,
    recentSleeps: [],
    ...overrides,
  };
}

function plan(napTimes: [string, string][], bedtime: string): PlanCandidate {
  return {
    naps: napTimes.map(([s, e]) => ({ startTime: `2026-03-28T${s}:00Z`, endTime: `2026-03-28T${e}:00Z` })),
    bedtime: `2026-03-28T${bedtime}:00Z`,
  };
}

const WAKE = new Date("2026-03-28T07:00:00Z").getTime();
const NOW = new Date("2026-03-28T08:00:00Z").getTime(); // used by selectBestPlan

describe("scorePlan", () => {
  it("feasible plan with reasonable wake windows", () => {
    // 9mo: WW range [150, 210] → [150, 273] for final (1.3x)
    // Wake 07:00, nap1 09:30-11:00 (WW=150), nap2 14:00-15:30 (WW=180), bed 19:30 (finalWW=240)
    const result = scorePlan(
      plan([["09:30", "11:00"], ["14:00", "15:30"]], "19:30"),
      ctx(), WAKE,
    );

    expect(result.feasible).toBe(true);
    expect(result.cost).toBeFinite();
  });

  it("wake window below minimum → infeasible", () => {
    // Nap1 at 08:00 = only 60 min WW, way below 150 min minimum
    const result = scorePlan(
      plan([["08:00", "09:00"], ["12:00", "13:00"]], "18:00"),
      ctx(), WAKE,
    );

    expect(result.feasible).toBe(false);
    expect(result.hardViolations.length).toBeGreaterThan(0);
  });

  it("nap within 60 min of bedtime → infeasible (B8)", () => {
    // Nap2 starts at 18:30, bedtime at 19:00 → within 60 min
    const result = scorePlan(
      plan([["09:30", "11:00"], ["18:30", "19:00"]], "19:15"),
      ctx(), WAKE,
    );

    expect(result.feasible).toBe(false);
    expect(result.hardViolations.some(v => v.includes("60min of bedtime"))).toBe(true);
  });

  it("closer to target → lower cost", () => {
    const targetMs = new Date("2026-03-28T18:30:00Z").getTime();

    const closer = scorePlan(
      plan([["09:30", "11:00"], ["14:00", "15:30"]], "19:00"),
      ctx(), WAKE, NOW, targetMs,
    );
    const farther = scorePlan(
      plan([["09:30", "11:00"], ["14:00", "15:30"]], "20:00"),
      ctx(), WAKE, NOW, targetMs,
    );

    expect(closer.feasible).toBe(true);
    expect(farther.feasible).toBe(true);
    expect(closer.cost).toBeLessThan(farther.cost);
  });
});

describe("selectBestPlan", () => {
  const sparse = buildSparseRecentSleeps();

  it("no target → returns natural plan", () => {
    const result = selectBestPlan(
      "2026-03-28T07:00:00Z", [], undefined,
      ctx({ recentSleeps: sparse }), NOW,
    );

    expect(result.source).toBe("natural");
  });

  it("target shifts bedtime by at most 15 min from natural", () => {
    const natural = selectBestPlan(
      "2026-03-28T07:00:00Z", [], undefined,
      ctx({ recentSleeps: sparse }), NOW,
    );
    const withTarget = selectBestPlan(
      "2026-03-28T07:00:00Z", [], undefined,
      ctx({ recentSleeps: sparse, targetBedtime: "16:00" }), NOW,
    );

    const naturalMs = new Date(natural.bedtime).getTime();
    const targetMs = new Date(withTarget.bedtime).getTime();
    expect(Math.abs(naturalMs - targetMs)).toBeLessThanOrEqual(15 * 60_000);
  });

  it("feasible target-guided plan wins over natural when closer to target", () => {
    const result = selectBestPlan(
      "2026-03-28T07:00:00Z", [], undefined,
      ctx({ recentSleeps: sparse, targetBedtime: "19:45" }), NOW,
    );

    // Target very close to natural → target-guided should be selected
    expect(result.source).toBe("target-guided");
  });
});

/** Sparse recent sleeps: naps consistent, only 2 nights (no habitual bedtime weight). */
function buildSparseRecentSleeps(): SleepEntry[] {
  const sleeps: SleepEntry[] = [];
  for (let d = 11; d <= 25; d++) {
    const ds = `2026-03-${String(d).padStart(2, "0")}`;
    sleeps.push(
      { start_time: `${ds}T09:30:00Z`, end_time: `${ds}T11:00:00Z`, type: "nap" },
      { start_time: `${ds}T14:00:00Z`, end_time: `${ds}T15:30:00Z`, type: "nap" },
    );
  }
  sleeps.push(
    { start_time: "2026-03-24T19:30:00Z", end_time: "2026-03-24T23:59:00Z", type: "night" },
    { start_time: "2026-03-25T19:30:00Z", end_time: "2026-03-25T23:59:00Z", type: "night" },
  );
  return sleeps;
}
