import { describe, it, expect } from "bun:test";
import { buildComparisonRows } from "$lib/stats/child-comparison.js";
import { formatDuration } from "$lib/utils.js";
import type { ChildStats } from "$lib/stats/multi-child-stats.js";

const d = (min: number) => formatDuration(min * 60_000);

const child = (
  babyId: number,
  name: string,
  o: { nap: number; night: number; naps: number; stretches: number[] },
): ChildStats =>
  ({
    babyId,
    name,
    stats: {
      allStats: { avgNapMinutesPerDay: o.nap, avgNightMinutesPerDay: o.night, avgNapsPerDay: o.naps, days: [] },
      nightStretches: o.stretches.map((minutes, i) => ({ date: `d${i}`, minutes })),
    },
  }) as unknown as ChildStats;

describe("buildComparisonRows", () => {
  it("returns nothing for fewer than two children", () => {
    expect(buildComparisonRows([])).toEqual([]);
    expect(buildComparisonRows([child(1, "Ada", { nap: 120, night: 600, naps: 2, stretches: [300] })])).toEqual([]);
  });

  it("lays out each metric per child with the absolute divergence", () => {
    const ada = child(1, "Ada", { nap: 120, night: 600, naps: 2, stretches: [300, 360] });
    const bo = child(2, "Bo", { nap: 90, night: 540, naps: 3, stretches: [300] });

    expect(buildComparisonRows([ada, bo])).toEqual([
      { label: "Total søvn/dag", values: [d(720), d(630)], divergence: d(90) },
      { label: "Nattesøvn/dag", values: [d(600), d(540)], divergence: d(60) },
      { label: "Lurar/dag", values: ["2", "3"], divergence: "1" },
      { label: "Lengste nattestrekk", values: [d(360), d(300)], divergence: d(60) },
    ]);
  });
});
