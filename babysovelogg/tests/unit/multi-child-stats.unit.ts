import { describe, it, expect } from "bun:test";
import { statsMode, computeChildrenStats, type ChildRawData } from "$lib/stats/multi-child-stats.js";
import type { SleepEntry } from "$lib/types.js";

describe("statsMode", () => {
  it("single for 0 or 1 child regardless of twin flag", () => {
    expect(statsMode(0, false)).toBe("single");
    expect(statsMode(1, true)).toBe("single");
  });
  it("twinOverlay for 2+ children in twin mode, siblingTwoUp otherwise", () => {
    expect(statsMode(2, true)).toBe("twinOverlay");
    expect(statsMode(2, false)).toBe("siblingTwoUp");
    expect(statsMode(3, true)).toBe("twinOverlay");
  });
});

const NOW = new Date("2026-03-26T12:00:00.000Z").getTime();
const at = (d: number, h: number) =>
  `2026-03-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00.000Z`;

const nights = (count: number): SleepEntry[] =>
  Array.from({ length: count }, (_, k) => ({
    start_time: at(20 + k, 19),
    end_time: at(21 + k, 7),
    type: "night" as const,
  }));

describe("computeChildrenStats", () => {
  it("computes one independent ComputedStats per child, keyed by baby", () => {
    const inputs: ChildRawData[] = [
      { baby: { id: 1, name: "Ada", timezone: "UTC", birthdate: "2025-09-26" }, sleeps: nights(3), diapers: [] },
      { baby: { id: 2, name: "Bo", timezone: "UTC", birthdate: "2025-09-26" }, sleeps: nights(1), diapers: [] },
    ];
    const out = computeChildrenStats(inputs, NOW);

    expect(out.map((c) => [c.babyId, c.name])).toEqual([
      [1, "Ada"],
      [2, "Bo"],
    ]);
    // Independent computation: Ada has more nights than Bo, so her night-stretch
    // series has more points — proving the children aren't sharing state.
    expect(out[0].stats.nightStretches.length).toBeGreaterThan(out[1].stats.nightStretches.length);
  });

  it("a single child matches the direct computeAllStats path (N=1 unchanged)", async () => {
    const { computeAllStats } = await import("$lib/stats-view-utils.js");
    const sleeps = nights(3);
    const direct = computeAllStats(sleeps, [], "UTC", "2025-09-26", NOW);
    const viaChildren = computeChildrenStats(
      [{ baby: { id: 1, name: "Ada", timezone: "UTC", birthdate: "2025-09-26" }, sleeps, diapers: [] }],
      NOW,
    );
    expect(viaChildren[0].stats).toEqual(direct);
  });
});
