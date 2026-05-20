import { describe, expect, it } from "bun:test";
import { classifyTrendDay, computeTrendTargets } from "$lib/engine/trend.js";
import type { SleepEntry, BabyContext } from "$lib/types.js";

// Stage 1 of the trend intervention-target split:
//
// `computeTrendTargets` returns both `observedRecentMin` and
// `interventionTargetMin`. In stage 1 they're equal (the held-baseline drift
// lands later) but the day classification and diagnostics are live, so we
// pin those mechanics here.
//
// Codex design memo: `local/codex-trend-split-design.md`.

const TZ = "UTC";

function sleep(
  start: string,
  end: string | null,
  type: "nap" | "night",
  wokeBy: "self" | "woken" | null = null,
): SleepEntry {
  return { start_time: start, end_time: end, type, woke_by: wokeBy };
}

function day(d: number, h: number, m = 0): string {
  return `2026-04-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
}

describe("classifyTrendDay", () => {
  const ref = 780; // 13h reference (matches Halldis's pre-cap trend roughly)
  const tol = 20;  // NAP_BUDGET.TOLERANCE_MIN

  it("classifies a self-wake last-nap day as 'natural'", () => {
    const sleeps = [
      sleep(day(10, 9, 0), day(10, 11, 0), "nap", "self"),
      sleep(day(10, 19, 0), day(11, 8, 0), "night", "self"),
    ];
    const d = classifyTrendDay("2026-04-10", sleeps, ref, tol, undefined);
    expect(d.kind).toBe("natural");
    expect(d.reason).toBe("last nap self-woke");
    expect(d.totalMin).toBe(120 + 13 * 60);
  });

  it("classifies a parent-woken substantial near-target day as 'policy-affected'", () => {
    // Total ~13h, last nap is parent-woken at substantial 110 min
    const sleeps = [
      sleep(day(11, 9, 0), day(11, 10, 50), "nap", "woken"),
      sleep(day(11, 19, 0), day(12, 8, 0), "night", "self"),
    ];
    const d = classifyTrendDay("2026-04-11", sleeps, ref, tol, undefined);
    expect(d.kind).toBe("policy-affected");
    expect(d.reason).toBe("parent-woken last nap near target");
  });

  it("classifies a parent-woken FAR-below-target day as 'natural' (parent-woken but low total → not policy-affected, the cap math didn't push them down)", () => {
    // Low total — only 8h — so the "near target" gate fails.
    const sleeps = [
      sleep(day(12, 9, 0), day(12, 10, 50), "nap", "woken"),
      sleep(day(12, 22, 0), day(13, 4, 0), "night", "self"),
    ];
    const d = classifyTrendDay("2026-04-12", sleeps, ref, tol, undefined);
    expect(d.kind).toBe("natural");
    expect(d.reason).toBe("untagged complete");
  });

  it("classifies an off-day as 'off-day' regardless of contents", () => {
    const sleeps = [
      sleep(day(13, 9, 0), day(13, 10, 50), "nap", "self"),
      sleep(day(13, 19, 0), day(14, 8, 0), "night", "self"),
    ];
    const d = classifyTrendDay("2026-04-13", sleeps, ref, tol, new Set(["2026-04-13"]));
    expect(d.kind).toBe("off-day");
  });

  it("classifies a day with no night entry as 'incomplete'", () => {
    const sleeps = [sleep(day(14, 9, 0), day(14, 10, 30), "nap", "self")];
    const d = classifyTrendDay("2026-04-14", sleeps, ref, tol, undefined);
    expect(d.kind).toBe("incomplete");
  });

  it("ignores a tiny parent-woken last nap (under 30 min) for policy-affected classification", () => {
    // A 15-min car-seat nap shouldn't drag the day into policy-affected.
    const sleeps = [
      sleep(day(15, 9, 0), day(15, 9, 15), "nap", "woken"),
      sleep(day(15, 19, 0), day(16, 8, 0), "night", "self"),
    ];
    const d = classifyTrendDay("2026-04-15", sleeps, ref, tol, undefined);
    // Last-nap parent-woken but under the 30-min substantial threshold →
    // falls through to "untagged complete" (natural for now, weakly).
    expect(d.kind).toBe("natural");
  });
});

describe("computeTrendTargets (stage 1: API only)", () => {
  function halldisLikeTrend(): SleepEntry[] {
    // 8 days of routine 1-nap. Wake ~05:25, nap ~10:20-12:10, night 18:00+.
    // The first 6 are clean self-wakes; the last 2 are parent-woken near
    // target (the user's "I've been intervening" pattern).
    const out: SleepEntry[] = [];
    for (let d = 1; d <= 6; d++) {
      out.push(sleep(day(d, 10, 20), day(d, 12, 10), "nap", "self"));
      out.push(sleep(day(d, 18, 0), day(d + 1, 5, 25), "night", "self"));
    }
    for (let d = 7; d <= 8; d++) {
      out.push(sleep(day(d, 10, 20), day(d, 12, 5), "nap", "woken"));
      out.push(sleep(day(d, 18, 0), day(d + 1, 5, 25), "night", "self"));
    }
    return out;
  }

  function ctx11(sleeps: SleepEntry[]): BabyContext {
    return {
      birthdate: "2025-06-12",
      ageMonths: 11,
      tz: TZ,
      customNapCount: 1,
      recentSleeps: sleeps,
    };
  }

  it("returns both observed and intervention targets (equal in stage 1)", () => {
    const sleeps = halldisLikeTrend();
    const now = new Date(day(9, 5, 25)).getTime();
    const targets = computeTrendTargets(sleeps, ctx11(sleeps), now);
    expect(targets).not.toBeNull();
    expect(targets!.observedRecentMin).toBeGreaterThan(0);
    expect(targets!.interventionTargetMin).toBe(targets!.observedRecentMin);
    expect(targets!.interventionConfidence).toBe("low"); // no held baseline yet
    expect(targets!.interventionSourceLabel).toBe("observed (stage 1)");
  });

  it("classifies days into natural vs policy-affected in diagnostics", () => {
    const sleeps = halldisLikeTrend();
    const now = new Date(day(9, 5, 25)).getTime();
    const targets = computeTrendTargets(sleeps, ctx11(sleeps), now)!;
    expect(targets.diagnostics.naturalDays30).toBeGreaterThanOrEqual(5);
    expect(targets.diagnostics.policyAffectedDays30).toBeGreaterThanOrEqual(1);
  });

  it("returns null when the underlying data is too sparse (no advice)", () => {
    // Only 2 days — below NAP_BUDGET.MIN_TREND_DAYS.
    const sleeps = [
      sleep(day(1, 10, 20), day(1, 12, 10), "nap", "self"),
      sleep(day(1, 18, 0), day(2, 5, 25), "night", "self"),
    ];
    const now = new Date(day(3, 5, 25)).getTime();
    const targets = computeTrendTargets(sleeps, ctx11(sleeps), now);
    expect(targets).toBeNull();
  });
});
