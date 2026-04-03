import { describe, expect, it } from "bun:test";
import {
  backtest,
  bucketResultsByAge,
  bucketByWarmup,
  renderSummary,
} from "$lib/engine/backtest.js";
import type { DayRecord } from "$lib/engine/backtest.js";

import halldisData from "../fixtures/halldis-sleep.json";

const BIRTHDATE = "2025-06-12";
const TZ = "Europe/Oslo";
const days = halldisData as DayRecord[];

// =============================================================================
// Mechanics
// =============================================================================

describe("backtest", () => {
  it("skips first day and handles empty-nap days", () => {
    const result = backtest(days, BIRTHDATE, { tz: TZ });

    expect(result.totalDays).toBeGreaterThan(0);
    expect(result.days[0].date).not.toBe(days[0].date);
  });

  it("accepts a custom predictor", () => {
    const result = backtest(days, BIRTHDATE, { predict: () => [], tz: TZ });

    expect(result.napCountAccuracy).toBe(0);
    // Empty predictor now gets 60 min penalty per unmatched actual nap
    expect(result.napStartMAE).toBe(60);
  });

  it("all fixture times are UTC instants", () => {
    for (const day of days) {
      expect(day.wakeTime).toMatch(/Z$/);
      for (const s of day.sleeps) {
        expect(s.start_time).toMatch(/Z$/);
        expect(s.end_time).toMatch(/Z$/);
      }
    }
  });
});

// =============================================================================
// Baseline: current algorithm on 83 days of Halldis data (Jan 6 - Mar 29)
// =============================================================================

function mostCommonNapCount(result: ReturnType<typeof backtest>): number {
  const counts = new Map<number, number>();
  for (const d of result.days) {
    const n = d.actualNaps.length;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  let best = 0, bestCount = 0;
  for (const [n, c] of counts) {
    if (c > bestCount) { best = n; bestCount = c; }
  }
  return best;
}

describe("baseline", () => {
  const auto = backtest(days, BIRTHDATE, { tz: TZ });
  const buckets = bucketResultsByAge(auto, BIRTHDATE);

  it("per-month breakdown", () => {
    const lines = buckets.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "6mo: 5 days, count 60% (3/5), nap MAE 54.7, dur MAE 23.5, bed MAE 28.7, wake MAE 11.3, nap bias +9.2, count bias -0.4
      7mo: 31 days, count 77% (24/31), nap MAE 48.9, dur MAE 26.8, bed MAE 24.3, wake MAE 29.1, nap bias -8.8, count bias +0.16
      8mo: 28 days, count 89% (25/28), nap MAE 26.9, dur MAE 18.9, bed MAE 18.1, wake MAE 21.8, nap bias +4.1, count bias +0.11
      9mo: 22 days, count 86% (19/22), nap MAE 64.1, dur MAE 23.4, bed MAE 24.1, wake MAE 28.8, nap bias -12.5, count bias +0.05"
    `);
  });

  // Pre-compute: one backtest per unique nap count (avoids running 4 separate backtests)
  const manualCountsByLabel = Object.fromEntries(
    buckets.map((b) => [b.label, mostCommonNapCount(b.result)]),
  );
  const uniqueCounts = [...new Set(Object.values(manualCountsByLabel))];
  const manualResults = Object.fromEntries(
    uniqueCounts.map((n) => [n, backtest(days, BIRTHDATE, { customNapCount: n, tz: TZ })]),
  );

  it("per-month with manual nap count", () => {
    const lines = buckets.map((b) => {
      const n = manualCountsByLabel[b.label];
      const manualBucket = bucketResultsByAge(manualResults[n], BIRTHDATE).find(
        (mb) => mb.label === b.label,
      )!;
      return renderSummary(manualBucket.result, `${b.label} manual=${n}`);
    });
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "6mo manual=3: 5 days, count 80% (4/5), nap MAE 60.2, dur MAE 26.1, bed MAE 35.3, wake MAE 20.4, nap bias +12.8, count bias +0.2
      7mo manual=2: 31 days, count 84% (26/31), nap MAE 47.9, dur MAE 27.3, bed MAE 22, wake MAE 29, nap bias -6.7, count bias +0.1
      8mo manual=2: 28 days, count 89% (25/28), nap MAE 26.9, dur MAE 18.9, bed MAE 18.1, wake MAE 21.8, nap bias +4.1, count bias +0.11
      9mo manual=1: 22 days, count 91% (20/22), nap MAE 63.8, dur MAE 23.4, bed MAE 20, wake MAE 28.5, nap bias -13, count bias -0.09"
    `);
  });

  it("combined summary", () => {
    expect(renderSummary(auto, "all")).toMatchInlineSnapshot(`"all: 86 days, count 83% (71/86), nap MAE 44.2, dur MAE 23.1, bed MAE 22.6, wake MAE 25.6, nap bias -3.3, count bias +0.08"`);
  });

  it("warm-up curve", () => {
    const warmup = bucketByWarmup(auto);
    const lines = warmup.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "day 1-3: 3 days, count 33% (1/3), nap MAE 67.6, dur MAE 20.1, bed MAE 36.3, wake MAE 3.5, nap bias +44.2, count bias -0.67
      day 4-7: 4 days, count 50% (2/4), nap MAE 51.5, dur MAE 36.6, bed MAE 39.2, wake MAE 35.8, nap bias -30.9, count bias +0.5
      day 8-14: 7 days, count 86% (6/7), nap MAE 64.8, dur MAE 20.8, bed MAE 13.5, wake MAE 23.7, nap bias -31.6, count bias +0.14
      day 15+: 72 days, count 86% (62/72), nap MAE 39.8, dur MAE 22.4, bed MAE 21.9, wake MAE 26.2, nap bias -0.6, count bias +0.08"
    `);
  });

  // ── Regression guards ──
  it("nap start MAE ≤ 50 min", () => expect(auto.napStartMAE).toBeLessThan(50));
  it("nap duration MAE ≤ 30 min", () => expect(auto.napDurationMAE).toBeLessThan(30));
  it("bedtime MAE ≤ 30 min", () => expect(auto.bedtimeMAE).toBeLessThan(30));
  it("wake time MAE ≤ 30 min", () => expect(auto.wakeTimeMAE).toBeLessThan(30));
  it("nap count accuracy ≥ 78%", () => expect(auto.napCountAccuracy).toBeGreaterThan(0.78));
});
