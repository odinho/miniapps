import { describe, expect, it } from "bun:test";
import {
  detectRescueNap,
  computeShortNapThreshold,
  RESCUE_NAP,
} from "$lib/engine/schedule.js";

function nap(startIso: string, endIso: string) {
  return { start_time: startIso, end_time: endIso };
}

describe("computeShortNapThreshold", () => {
  it("scales with learned nap duration (60%)", () => {
    expect(computeShortNapThreshold(90)).toBe(54);
    expect(computeShortNapThreshold(120)).toBe(72);
    expect(computeShortNapThreshold(60)).toBe(36);
  });

  it("respects absolute floor for low learned durations", () => {
    expect(computeShortNapThreshold(20)).toBe(RESCUE_NAP.SHORT_NAP_FLOOR_MIN);
    expect(computeShortNapThreshold(10)).toBe(RESCUE_NAP.SHORT_NAP_FLOOR_MIN);
  });

  it("a 40-min nap is NOT short for a single-cycle-napper baby", () => {
    // Baby typically sleeps 40 min per nap
    const threshold = computeShortNapThreshold(40);
    expect(threshold).toBe(24);
    // A 35-min nap for this baby is NOT considered short
    expect(35).toBeGreaterThan(threshold);
  });

  it("a 40-min nap IS short for a multi-cycle-napper baby", () => {
    // Baby typically sleeps 120 min
    const threshold = computeShortNapThreshold(120);
    expect(threshold).toBe(72);
    // A 40-min nap for this baby IS considered short
    expect(40).toBeLessThan(threshold);
  });
});

describe("detectRescueNap", () => {
  const bedtime = "2026-04-12T16:00:00.000Z"; // 18:00 Oslo
  // Halldis-like baby: typical nap ~90 min, short threshold = 54 min
  const shortThresh = 54;

  it("returns null for a normal nap within expected count", () => {
    const completedNaps = [
      nap("2026-04-12T08:00:00Z", "2026-04-12T09:30:00Z"), // 90 min — normal
    ];
    const result = detectRescueNap(
      "2026-04-12T12:00:00Z",
      completedNaps,
      2,
      bedtime,
      shortThresh,
    );
    expect(result).toBeNull();
  });

  it("detects extra nap beyond expected count", () => {
    const completedNaps = [
      nap("2026-04-12T08:00:00Z", "2026-04-12T10:00:00Z"),
    ];
    const result = detectRescueNap(
      "2026-04-12T12:12:00Z",
      completedNaps,
      1, // expected 1, completed 1 → extra!
      bedtime,
      shortThresh,
    );
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("extra_nap");
  });

  it("detects rescue after short prior nap (relative to baby)", () => {
    const completedNaps = [
      nap("2026-04-12T08:12:00Z", "2026-04-12T08:50:00Z"), // 38 min < 54 threshold
    ];
    const result = detectRescueNap(
      "2026-04-12T12:12:00Z",
      completedNaps,
      2,
      bedtime,
      shortThresh,
    );
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("short_prior_nap");
  });

  it("does NOT trigger for 40-min nap when baby's threshold allows it", () => {
    // Single-cycle-napper baby: threshold = 24 min
    const completedNaps = [
      nap("2026-04-12T08:00:00Z", "2026-04-12T08:40:00Z"), // 40 min
    ];
    const result = detectRescueNap(
      "2026-04-12T12:00:00Z",
      completedNaps,
      2,
      bedtime,
      24, // low threshold for this baby
    );
    expect(result).toBeNull();
  });

  it("detects 'both' when extra and short prior", () => {
    const completedNaps = [
      nap("2026-04-12T08:12:00Z", "2026-04-12T08:50:00Z"), // 38 min short
    ];
    const result = detectRescueNap(
      "2026-04-12T12:12:00Z",
      completedNaps,
      1,
      bedtime,
      shortThresh,
    );
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("both");
  });

  it("caps recommended wake at nap start + 45 min", () => {
    const completedNaps = [
      nap("2026-04-12T08:00:00Z", "2026-04-12T10:00:00Z"),
    ];
    const napStart = "2026-04-12T12:00:00.000Z";
    const result = detectRescueNap(napStart, completedNaps, 1, bedtime, shortThresh);
    const napStartMs = new Date(napStart).getTime();
    const wakeMs = new Date(result!.recommendedWakeTime).getTime();
    expect(wakeMs - napStartMs).toBe(RESCUE_NAP.CAP_MINUTES * 60_000);
  });

  it("caps recommended wake to respect bedtime - 90 min", () => {
    const completedNaps = [
      nap("2026-04-12T08:00:00Z", "2026-04-12T10:00:00Z"),
    ];
    const earlyBedtime = "2026-04-12T15:40:00.000Z";
    const napStart = "2026-04-12T14:00:00.000Z";
    const result = detectRescueNap(napStart, completedNaps, 1, earlyBedtime, shortThresh);

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
    );
    expect(result).not.toBeNull();
    const wakeMs = new Date(result!.recommendedWakeTime).getTime();
    const startMs = new Date("2026-04-12T14:00:00Z").getTime();
    expect(wakeMs - startMs).toBe(RESCUE_NAP.CAP_MINUTES * 60_000);
  });

  it("ensures minimum 20 min when cap is very tight", () => {
    const completedNaps = [
      nap("2026-04-12T08:00:00Z", "2026-04-12T10:00:00Z"),
    ];
    const veryLateBedtime = "2026-04-12T14:30:00.000Z";
    const napStart = "2026-04-12T14:00:00.000Z";
    const result = detectRescueNap(napStart, completedNaps, 1, veryLateBedtime, shortThresh);

    const startMs = new Date(napStart).getTime();
    const wakeMs = new Date(result!.recommendedWakeTime).getTime();
    expect(wakeMs - startMs).toBe(20 * 60_000);
  });

  it("not triggered when prior nap exceeds threshold", () => {
    const completedNaps = [
      nap("2026-04-12T08:00:00Z", "2026-04-12T09:20:00Z"), // 80 min > 54 threshold
    ];
    const result = detectRescueNap(
      "2026-04-12T12:00:00Z",
      completedNaps,
      2,
      bedtime,
      shortThresh,
    );
    expect(result).toBeNull();
  });
});
