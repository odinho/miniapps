import { describe, expect, it } from "bun:test";
import { adjustWakeWindowForNapQuality, predictNextNap } from "$lib/engine/schedule.js";
import type { BabyContext } from "$lib/types.js";

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

describe("adjustWakeWindowForNapQuality", () => {
  const baseWW = 150; // 2.5h

  it("short nap (≤30 min) → 15% shorter WW", () => {
    expect(adjustWakeWindowForNapQuality(baseWW, 25)).toBe(128); // 150 * 0.85
    expect(adjustWakeWindowForNapQuality(baseWW, 30)).toBe(128); // boundary
  });

  it("long nap (≥90 min) → 10% longer WW", () => {
    expect(adjustWakeWindowForNapQuality(baseWW, 90)).toBe(165); // 150 * 1.10
    expect(adjustWakeWindowForNapQuality(baseWW, 120)).toBe(165);
  });

  it("normal nap (31-89 min) → no adjustment", () => {
    expect(adjustWakeWindowForNapQuality(baseWW, 45)).toBe(150);
    expect(adjustWakeWindowForNapQuality(baseWW, 60)).toBe(150);
    expect(adjustWakeWindowForNapQuality(baseWW, 89)).toBe(150);
  });
});

describe("predictNextNap with nap quality", () => {
  const wake = "2026-03-30T10:00:00Z";

  it("short nap predicts earlier next nap", () => {
    const c = ctx();
    const normal = predictNextNap(wake, c);
    const afterShort = predictNextNap(wake, c, 25);

    expect(new Date(afterShort).getTime()).toBeLessThan(new Date(normal).getTime());
  });

  it("long nap predicts later next nap", () => {
    const c = ctx();
    const normal = predictNextNap(wake, c);
    const afterLong = predictNextNap(wake, c, 100);

    expect(new Date(afterLong).getTime()).toBeGreaterThan(new Date(normal).getTime());
  });
});
