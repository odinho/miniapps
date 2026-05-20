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
      "6mo: 5 days, count 60% (3/5), nap MAE 56.5, dur MAE 27.7, bed MAE 28.7, wake MAE 19.9, nap bias +12.9, count bias -0.4
      7mo: 31 days, count 77% (24/31), nap MAE 50.4, dur MAE 26.8, bed MAE 22.3, wake MAE 29.1, nap bias -12.7, count bias +0.16
      8mo: 28 days, count 89% (25/28), nap MAE 27, dur MAE 18.9, bed MAE 15.8, wake MAE 21.8, nap bias -4.8, count bias +0.11
      9mo: 31 days, count 87% (27/31), nap MAE 47.1, dur MAE 26.2, bed MAE 25.2, wake MAE 26.3, nap bias +3.3, count bias 0
      10mo: 17 days, count 94% (16/17), nap MAE 29.3, dur MAE 26.8, bed MAE 19.4, wake MAE 23, nap bias +4.7, count bias -0.06"
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
      "6mo manual=3: 5 days, count 80% (4/5), nap MAE 59.7, dur MAE 26.2, bed MAE 35.3, wake MAE 21.2, nap bias +13.9, count bias +0.2
      7mo manual=2: 31 days, count 84% (26/31), nap MAE 48.2, dur MAE 27.3, bed MAE 20, wake MAE 29, nap bias -12.2, count bias +0.1
      8mo manual=2: 28 days, count 89% (25/28), nap MAE 27, dur MAE 18.9, bed MAE 15.8, wake MAE 21.8, nap bias -4.8, count bias +0.11
      9mo manual=1: 31 days, count 90% (28/31), nap MAE 46.8, dur MAE 26.3, bed MAE 23.1, wake MAE 26, nap bias +3.1, count bias -0.1
      10mo manual=1: 17 days, count 94% (16/17), nap MAE 29.3, dur MAE 26.8, bed MAE 19.4, wake MAE 23, nap bias +4.7, count bias -0.06"
    `);
  });

  it("combined summary", () => {
    expect(renderSummary(auto, "all")).toMatchInlineSnapshot(`"all: 112 days, count 85% (95/112), nap MAE 41.3, dur MAE 24.3, bed MAE 21.4, wake MAE 25.2, nap bias -3.8, count bias +0.04"`);
  });

  it("warm-up curve", () => {
    const warmup = bucketByWarmup(auto);
    const lines = warmup.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "day 1-3: 3 days, count 33% (1/3), nap MAE 71.3, dur MAE 28.4, bed MAE 36.3, wake MAE 17.9, nap bias +46.8, count bias -0.67
      day 4-7: 4 days, count 50% (2/4), nap MAE 54.7, dur MAE 36.6, bed MAE 39.2, wake MAE 35.8, nap bias -26.4, count bias +0.5
      day 8-14: 7 days, count 86% (6/7), nap MAE 66.5, dur MAE 20.8, bed MAE 13.5, wake MAE 23.7, nap bias -40.4, count bias +0.14
      day 15+: 98 days, count 88% (86/98), nap MAE 36.4, dur MAE 23.6, bed MAE 20.8, wake MAE 25.1, nap bias -1.3, count bias +0.04"
    `);
  });

  // ── Regression guards ──
  it("nap start MAE ≤ 50 min", () => expect(auto.napStartMAE).toBeLessThan(50));
  it("nap duration MAE ≤ 30 min", () => expect(auto.napDurationMAE).toBeLessThan(30));
  it("bedtime MAE ≤ 30 min", () => expect(auto.bedtimeMAE).toBeLessThan(30));
  it("wake time MAE ≤ 30 min", () => expect(auto.wakeTimeMAE).toBeLessThan(30));
  it("nap count accuracy ≥ 78%", () => expect(auto.napCountAccuracy).toBeGreaterThan(0.78));
});
