import { describe, expect, it } from "bun:test";
import { detectRescueNap, RESCUE_NAP } from "$lib/engine/schedule.js";

function nap(startIso: string, endIso: string) {
  return { start_time: startIso, end_time: endIso };
}

describe("detectRescueNap", () => {
  const bedtime = "2026-04-12T16:00:00.000Z"; // 18:00 Oslo

  it("returns null for a normal nap within expected count", () => {
    const completedNaps = [
      nap("2026-04-12T08:00:00Z", "2026-04-12T09:30:00Z"), // 90 min nap
    ];
    const result = detectRescueNap(
      "2026-04-12T12:00:00Z", // active nap start
      completedNaps,
      2, // expected 2, completed 1 — not extra
      bedtime,
    );
    expect(result).toBeNull();
  });

  it("detects extra nap beyond expected count", () => {
    const completedNaps = [
      nap("2026-04-12T08:00:00Z", "2026-04-12T10:00:00Z"), // 120 min — normal
    ];
    const result = detectRescueNap(
      "2026-04-12T12:12:00Z", // 2nd nap start, but expected 1
      completedNaps,
      1, // expected 1, completed 1 — extra!
      bedtime,
    );
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("extra_nap");
  });

  it("detects rescue after short prior nap", () => {
    const completedNaps = [
      nap("2026-04-12T08:12:00Z", "2026-04-12T08:50:00Z"), // 38 min — short!
    ];
    const result = detectRescueNap(
      "2026-04-12T12:12:00Z",
      completedNaps,
      2, // expected 2, completed 1 — not extra, but short prior
      bedtime,
    );
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("short_prior_nap");
  });

  it("detects 'both' when extra and short prior", () => {
    const completedNaps = [
      nap("2026-04-12T08:12:00Z", "2026-04-12T08:50:00Z"), // 38 min — short
    ];
    const result = detectRescueNap(
      "2026-04-12T12:12:00Z",
      completedNaps,
      1, // expected 1, completed 1 — extra + short
      bedtime,
    );
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("both");
  });

  it("caps recommended wake at nap start + 45 min", () => {
    const completedNaps = [
      nap("2026-04-12T08:00:00Z", "2026-04-12T10:00:00Z"),
    ];
    const napStart = "2026-04-12T12:00:00.000Z";
    const result = detectRescueNap(napStart, completedNaps, 1, bedtime);
    const napStartMs = new Date(napStart).getTime();
    const wakeMs = new Date(result!.recommendedWakeTime).getTime();
    expect(wakeMs - napStartMs).toBe(RESCUE_NAP.CAP_MINUTES * 60_000);
  });

  it("caps recommended wake to respect bedtime - 90 min", () => {
    const completedNaps = [
      nap("2026-04-12T08:00:00Z", "2026-04-12T10:00:00Z"),
    ];
    // Late nap: 45 min cap (14:45) would violate bedtime - 90 min (14:10)
    const earlyBedtime = "2026-04-12T15:40:00.000Z";
    const napStart = "2026-04-12T14:00:00.000Z";
    const result = detectRescueNap(napStart, completedNaps, 1, earlyBedtime);

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
      null, // no bedtime
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
    // Nap starts so late that bedtime - 90 min is before nap start
    const veryLateBedtime = "2026-04-12T14:30:00.000Z";
    const napStart = "2026-04-12T14:00:00.000Z";
    const result = detectRescueNap(napStart, completedNaps, 1, veryLateBedtime);

    const startMs = new Date(napStart).getTime();
    const wakeMs = new Date(result!.recommendedWakeTime).getTime();
    expect(wakeMs - startMs).toBe(20 * 60_000); // 20 min minimum
  });

  it("not triggered when prior nap is normal length", () => {
    const completedNaps = [
      nap("2026-04-12T08:00:00Z", "2026-04-12T09:20:00Z"), // 80 min — normal
    ];
    const result = detectRescueNap(
      "2026-04-12T12:00:00Z",
      completedNaps,
      2, // expected 2, completed 1
      bedtime,
    );
    expect(result).toBeNull();
  });
});
