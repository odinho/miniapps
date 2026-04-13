import { describe, expect, it } from "bun:test";
import {
  detectRescueNap,
  computeShortNapThreshold,
  computeRescueNapCap,
  RESCUE_NAP,
} from "$lib/engine/schedule.js";

function nap(startIso: string, endIso: string) {
  return { start_time: startIso, end_time: endIso };
}

describe("computeShortNapThreshold (cycle-aware)", () => {
  const cycle = 55; // typical 10-month-old cycle

  it("flags missing a cycle for a 2-cycle napper", () => {
    // Halldis-like: typical 110 min, cycle 55 → threshold 82.5 (round → 83)
    const t = computeShortNapThreshold(110, cycle);
    expect(t).toBe(83);
    // 1-cycle nap (55 min) is short — she normally does 2
    expect(55).toBeLessThan(t);
    // Near-full 2-cycle nap (90 min) is NOT short
    expect(90).toBeGreaterThan(t);
  });

  it("allows a 36+ min nap for a 1-cycle napper", () => {
    // Single-cycler: typical 55 min, cycle 55 → threshold 27.5 → 28
    const t = computeShortNapThreshold(55, cycle);
    expect(t).toBe(28);
    // 36 min is within one cycle → NOT short
    expect(36).toBeGreaterThan(t);
    // 20 min is clearly incomplete → short
    expect(20).toBeLessThan(t);
  });

  it("flags missing one cycle for a 3-cycle napper", () => {
    // 3-cycle baby: 165 min typical → threshold 137.5 → 138
    const t = computeShortNapThreshold(165, cycle);
    expect(t).toBe(138);
    // 2-cycle nap (110 min) is still short for them
    expect(110).toBeLessThan(t);
    // Full 3 cycles (165 min) is fine
    expect(165).toBeGreaterThan(t);
  });

  it("respects floor for sub-cycle nappers", () => {
    // Very short napper: 25 min typical — threshold would go negative
    const t = computeShortNapThreshold(25, cycle);
    expect(t).toBe(RESCUE_NAP.SHORT_NAP_FLOOR_MIN);
  });
});

describe("computeRescueNapCap (light-phase targeting)", () => {
  it("targets mid-light-phase just before the cycle boundary", () => {
    // 55-min cycle with 8-min light window → cap at 55 - 4 = 51
    expect(computeRescueNapCap(55)).toBe(55 - RESCUE_NAP.LIGHT_WINDOW_MIN / 2);
  });

  it("adapts to shorter cycles", () => {
    // 40-min cycle → 40 - 4 = 36
    expect(computeRescueNapCap(40)).toBe(36);
  });

  it("enforces floor for very low cycles (bad data)", () => {
    expect(computeRescueNapCap(10)).toBe(RESCUE_NAP.CAP_FLOOR_MIN);
  });

  it("enforces ceiling so rescue naps don't become full naps", () => {
    expect(computeRescueNapCap(90)).toBe(RESCUE_NAP.CAP_CEILING_MIN);
  });
});

describe("detectRescueNap", () => {
  const bedtime = "2026-04-12T16:00:00.000Z"; // 18:00 Oslo
  // Halldis-like baby: learned 110, cycle 55 → short threshold 83, cap 51
  const shortThresh = 83;
  const rescueCap = 51;

  it("returns null for a normal 2-cycle nap", () => {
    const completedNaps = [
      nap("2026-04-12T08:00:00Z", "2026-04-12T09:30:00Z"), // 90 min — above threshold
    ];
    const result = detectRescueNap(
      "2026-04-12T12:00:00Z",
      completedNaps,
      2,
      bedtime,
      shortThresh,
      rescueCap,
    );
    expect(result).toBeNull();
  });

  it("flags a 1-cycle nap as short for a 2-cycle napper", () => {
    const completedNaps = [
      nap("2026-04-12T08:00:00Z", "2026-04-12T09:00:00Z"), // 60 min — 1 cycle
    ];
    const result = detectRescueNap(
      "2026-04-12T12:00:00Z",
      completedNaps,
      2,
      bedtime,
      shortThresh,
      rescueCap,
    );
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("short_prior_nap");
  });

  it("detects extra nap beyond expected count", () => {
    const completedNaps = [
      nap("2026-04-12T08:00:00Z", "2026-04-12T10:00:00Z"),
    ];
    const result = detectRescueNap(
      "2026-04-12T12:12:00Z",
      completedNaps,
      1, // expected 1, completed 1 → extra
      bedtime,
      shortThresh,
      rescueCap,
    );
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("extra_nap");
  });

  it("caps recommended wake at light phase before cycle boundary", () => {
    const completedNaps = [
      nap("2026-04-12T08:00:00Z", "2026-04-12T10:00:00Z"),
    ];
    const napStart = "2026-04-12T12:00:00.000Z";
    const result = detectRescueNap(napStart, completedNaps, 1, bedtime, shortThresh, rescueCap);
    const napStartMs = new Date(napStart).getTime();
    const wakeMs = new Date(result!.recommendedWakeTime).getTime();
    expect(wakeMs - napStartMs).toBe(rescueCap * 60_000);
  });

  it("caps recommended wake to respect bedtime - 90 min", () => {
    const completedNaps = [
      nap("2026-04-12T08:00:00Z", "2026-04-12T10:00:00Z"),
    ];
    const earlyBedtime = "2026-04-12T15:40:00.000Z";
    const napStart = "2026-04-12T14:00:00.000Z";
    const result = detectRescueNap(napStart, completedNaps, 1, earlyBedtime, shortThresh, rescueCap);

    const bedtimeMs = new Date(earlyBedtime).getTime();
    const wakeMs = new Date(result!.recommendedWakeTime).getTime();
    expect(bedtimeMs - wakeMs).toBe(RESCUE_NAP.MIN_PRE_BEDTIME_WAKE * 60_000);
  });

  it("handles no bedtime gracefully", () => {
    const completedNaps = [
      nap("2026-04-12T08:00:00Z", "2026-04-12T10:00:00Z"),
    ];
    const result = detectRescueNap(
      "2026-04-12T14:00:00Z",
      completedNaps,
      1,
      null,
      shortThresh,
      rescueCap,
    );
    expect(result).not.toBeNull();
    const wakeMs = new Date(result!.recommendedWakeTime).getTime();
    const startMs = new Date("2026-04-12T14:00:00Z").getTime();
    expect(wakeMs - startMs).toBe(rescueCap * 60_000);
  });

  it("ensures minimum 20 min when cap is very tight", () => {
    const completedNaps = [
      nap("2026-04-12T08:00:00Z", "2026-04-12T10:00:00Z"),
    ];
    const veryLateBedtime = "2026-04-12T14:30:00.000Z";
    const napStart = "2026-04-12T14:00:00.000Z";
    const result = detectRescueNap(napStart, completedNaps, 1, veryLateBedtime, shortThresh, rescueCap);

    const startMs = new Date(napStart).getTime();
    const wakeMs = new Date(result!.recommendedWakeTime).getTime();
    expect(wakeMs - startMs).toBe(20 * 60_000);
  });

  it("1-cycle-napper: 36-min nap is not flagged as short", () => {
    // Single-cycler: cycle 55, learned 55, short threshold = 28
    const completedNaps = [
      nap("2026-04-12T08:00:00Z", "2026-04-12T08:36:00Z"), // 36 min
    ];
    const result = detectRescueNap(
      "2026-04-12T12:00:00Z",
      completedNaps,
      2,
      bedtime,
      28, // single-cycler's threshold
      rescueCap,
    );
    expect(result).toBeNull();
  });

  it("detects 'both' when extra and short prior", () => {
    const completedNaps = [
      nap("2026-04-12T08:00:00Z", "2026-04-12T09:00:00Z"), // 60 min (1 cycle)
    ];
    const result = detectRescueNap(
      "2026-04-12T12:12:00Z",
      completedNaps,
      1,
      bedtime,
      shortThresh,
      rescueCap,
    );
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("both");
  });
});
