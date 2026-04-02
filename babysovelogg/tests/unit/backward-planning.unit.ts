import { describe, expect, it } from "bun:test";
import { planBackwardFromBedtime, predictDayNaps } from "$lib/engine/schedule.js";
import type { BabyContext, SleepEntry } from "$lib/types.js";

const WAKE = "2026-03-30T06:00:00Z";
const BEDTIME = "2026-03-30T18:30:00Z";

function renderNaps(naps: { startTime: string; endTime: string }[]): string {
  return naps.map((n) => `${n.startTime.slice(11, 16)}–${n.endTime.slice(11, 16)}`).join(", ");
}

function ctx(overrides: Partial<BabyContext> = {}): BabyContext {
  return {
    birthdate: "2025-06-12",
    ageMonths: 8,
    tz: "UTC",
    customNapCount: null,
    recentSleeps: [],
    ...overrides,
  };
}

describe("planBackwardFromBedtime", () => {
  it("2-nap day backward from 18:30", () => {
    const naps = planBackwardFromBedtime(WAKE, BEDTIME, ctx());

    expect(naps.length).toBe(2);
    const lastEnd = new Date(naps[naps.length - 1].endTime).getTime();
    expect(lastEnd).toBeLessThan(new Date(BEDTIME).getTime());
    expect(new Date(naps[0].startTime).getTime()).toBeGreaterThan(new Date(WAKE).getTime());
  });

  it("1-nap day backward from 19:00", () => {
    const naps = planBackwardFromBedtime(WAKE, "2026-03-30T19:00:00Z", ctx({ ageMonths: 14, customNapCount: 1 }));

    expect(naps.length).toBe(1);
    expect(renderNaps(naps)).toMatchInlineSnapshot(`"13:36–14:06"`);
  });

  it("backward plan differs from forward plan", () => {
    const c = ctx();
    const forward = predictDayNaps(WAKE, c);
    const backward = planBackwardFromBedtime(WAKE, BEDTIME, c);

    expect(forward.length).toBe(2);
    expect(backward.length).toBe(2);
    expect(renderNaps(forward)).not.toBe(renderNaps(backward));
  });

  it("with recent sleep data, uses learned wake windows", () => {
    const recentSleeps: SleepEntry[] = [
      { start_time: "2026-03-29T05:30:00Z", end_time: "2026-03-29T06:00:00Z", type: "night" },
      { start_time: "2026-03-29T08:30:00Z", end_time: "2026-03-29T09:30:00Z", type: "nap" },
      { start_time: "2026-03-29T12:30:00Z", end_time: "2026-03-29T13:30:00Z", type: "nap" },
      { start_time: "2026-03-29T17:00:00Z", end_time: "2026-03-30T05:30:00Z", type: "night" },
      { start_time: "2026-03-28T05:30:00Z", end_time: "2026-03-28T06:00:00Z", type: "night" },
      { start_time: "2026-03-28T08:30:00Z", end_time: "2026-03-28T09:30:00Z", type: "nap" },
      { start_time: "2026-03-28T12:30:00Z", end_time: "2026-03-28T13:30:00Z", type: "nap" },
      { start_time: "2026-03-28T17:00:00Z", end_time: "2026-03-29T05:30:00Z", type: "night" },
    ];

    const naps = planBackwardFromBedtime(WAKE, BEDTIME, ctx({ recentSleeps }));

    expect(naps.length).toBe(2);
    expect(renderNaps(naps)).toMatchInlineSnapshot(`"10:20–11:10, 14:10–15:00"`);
  });

  it("0 naps returns empty", () => {
    expect(planBackwardFromBedtime(WAKE, BEDTIME, ctx({ ageMonths: 18, customNapCount: 0 }))).toEqual([]);
  });

  it("early bedtime with many naps truncates gracefully", () => {
    const naps = planBackwardFromBedtime(WAKE, "2026-03-30T15:00:00Z", ctx({ ageMonths: 6, customNapCount: 3 }));

    for (const nap of naps) {
      expect(new Date(nap.startTime).getTime()).toBeGreaterThanOrEqual(new Date(WAKE).getTime());
    }
  });
});
