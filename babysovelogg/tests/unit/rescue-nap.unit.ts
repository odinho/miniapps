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
  // Default cap for a 10-month-old: learned cycle ~55 min
  const rescueCap = 55;

  it("returns null for a normal nap within expected count", () => {
    const completedNaps = [
      nap("2026-04-12T08:00:00Z", "2026-04-12T09:30:00Z"),
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

  it("detects extra nap beyond expected count", () => {
    const completedNaps = [
      nap("2026-04-12T08:00:00Z", "2026-04-12T10:00:00Z"),
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
    expect(result!.reason).toBe("extra_nap");
  });

  it("detects rescue after short prior nap (relative to baby)", () => {
    const completedNaps = [
      nap("2026-04-12T08:12:00Z", "2026-04-12T08:50:00Z"),
    ];
    const result = detectRescueNap(
      "2026-04-12T12:12:00Z",
      completedNaps,
      2,
      bedtime,
      shortThresh,
      rescueCap,
    );
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("short_prior_nap");
  });

  it("does NOT trigger for 40-min nap when baby's threshold allows it", () => {
    const completedNaps = [
      nap("2026-04-12T08:00:00Z", "2026-04-12T08:40:00Z"),
    ];
    const result = detectRescueNap(
      "2026-04-12T12:00:00Z",
      completedNaps,
      2,
      bedtime,
      24, // low threshold — single-cycle napper
      rescueCap,
    );
    expect(result).toBeNull();
  });

  it("detects 'both' when extra and short prior", () => {
    const completedNaps = [
      nap("2026-04-12T08:12:00Z", "2026-04-12T08:50:00Z"),
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

  it("caps recommended wake at nap start + learned cycle", () => {
    const completedNaps = [
      nap("2026-04-12T08:00:00Z", "2026-04-12T10:00:00Z"),
    ];
    const napStart = "2026-04-12T12:00:00.000Z";
    const result = detectRescueNap(napStart, completedNaps, 1, bedtime, shortThresh, rescueCap);
    const napStartMs = new Date(napStart).getTime();
    const wakeMs = new Date(result!.recommendedWakeTime).getTime();
    expect(wakeMs - napStartMs).toBe(rescueCap * 60_000);
  });

  it("uses shorter cap for short-cycle babies", () => {
    const completedNaps = [
      nap("2026-04-12T08:00:00Z", "2026-04-12T10:00:00Z"),
    ];
    const napStart = "2026-04-12T12:00:00.000Z";
    const shortCycleCap = 30; // baby's cycle is 30 min
    const result = detectRescueNap(napStart, completedNaps, 1, bedtime, shortThresh, shortCycleCap);
    const napStartMs = new Date(napStart).getTime();
    const wakeMs = new Date(result!.recommendedWakeTime).getTime();
    expect(wakeMs - napStartMs).toBe(shortCycleCap * 60_000);
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

  it("not triggered when prior nap exceeds threshold", () => {
    const completedNaps = [
      nap("2026-04-12T08:00:00Z", "2026-04-12T09:20:00Z"),
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
});

describe("computeRescueNapCap", () => {
  it("uses the learned cycle as the cap", () => {
    expect(computeRescueNapCap(55)).toBe(55);
    expect(computeRescueNapCap(40)).toBe(40);
    expect(computeRescueNapCap(30)).toBe(30);
  });

  it("enforces floor for very low cycles (bad data)", () => {
    expect(computeRescueNapCap(10)).toBe(RESCUE_NAP.CAP_FLOOR_MIN);
    expect(computeRescueNapCap(5)).toBe(RESCUE_NAP.CAP_FLOOR_MIN);
  });

  it("enforces ceiling so rescue naps don't become full naps", () => {
    expect(computeRescueNapCap(75)).toBe(RESCUE_NAP.CAP_CEILING_MIN);
    expect(computeRescueNapCap(90)).toBe(RESCUE_NAP.CAP_CEILING_MIN);
  });
});
