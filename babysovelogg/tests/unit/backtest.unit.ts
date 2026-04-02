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
      "6mo: 5 days, count 60% (3/5), nap MAE 49.1, dur MAE 21.3, bed MAE 61.5, wake MAE 13.6, nap bias +32.1, count bias -0.4
      7mo: 31 days, count 74% (23/31), nap MAE 51, dur MAE 27.4, bed MAE 43.8, wake MAE 31.6, nap bias -6.6, count bias +0.13
      8mo: 28 days, count 89% (25/28), nap MAE 34.1, dur MAE 17.7, bed MAE 26.5, wake MAE 27.1, nap bias +11.4, count bias +0.11
      9mo: 18 days, count 83% (15/18), nap MAE 148.7, dur MAE 29.2, bed MAE 44.3, wake MAE 112.1, nap bias +38.1, count bias +0.06"
    `);
  });

  it("per-month with manual nap count", () => {
    const lines = buckets.map((b) => {
      const n = mostCommonNapCount(b.result);
      const manual = backtest(days, BIRTHDATE, { customNapCount: n, tz: TZ });
      const manualBucket = bucketResultsByAge(manual, BIRTHDATE).find(
        (mb) => mb.label === b.label,
      )!;
      return renderSummary(manualBucket.result, `${b.label} manual=${n}`);
    });
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "6mo manual=3: 5 days, count 80% (4/5), nap MAE 55.4, dur MAE 23.4, bed MAE 68.1, wake MAE 20.6, nap bias +39.5, count bias +0.2
      7mo manual=2: 31 days, count 84% (26/31), nap MAE 51.1, dur MAE 27.8, bed MAE 41.9, wake MAE 31.6, nap bias -8.4, count bias +0.1
      8mo manual=2: 28 days, count 89% (25/28), nap MAE 34.1, dur MAE 17.7, bed MAE 26.5, wake MAE 27.1, nap bias +11.4, count bias +0.11
      9mo manual=1: 18 days, count 89% (16/18), nap MAE 160, dur MAE 29.3, bed MAE 41.4, wake MAE 112.1, nap bias +38.4, count bias -0.11"
    `);
  });

  it("combined summary", () => {
    expect(renderSummary(auto, "all")).toMatchInlineSnapshot(`"all: 82 days, count 80% (66/82), nap MAE 58.5, dur MAE 23.5, bed MAE 39.3, wake MAE 46.5, nap bias +9.5, count bias +0.07"`);
  });

  it("warm-up curve", () => {
    const warmup = bucketByWarmup(auto);
    const lines = warmup.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "day 1-3: 3 days, count 33% (1/3), nap MAE 66.6, dur MAE 25.3, bed MAE 54.9, wake MAE 17.4, nap bias +40.2, count bias -0.67
      day 4-7: 4 days, count 50% (2/4), nap MAE 37.2, dur MAE 28.3, bed MAE 80.3, wake MAE 33, nap bias +11.1, count bias +0.5
      day 8-14: 7 days, count 86% (6/7), nap MAE 69.9, dur MAE 24.3, bed MAE 43, wake MAE 28.7, nap bias -49.8, count bias +0.14
      day 15+: 68 days, count 84% (57/68), nap MAE 58.7, dur MAE 22.8, bed MAE 35.6, wake MAE 50.6, nap bias +14.1, count bias +0.07"
    `);
  });

  // ── Regression guards ──
  it("nap start MAE ≤ 60 min", () => expect(auto.napStartMAE).toBeLessThan(60));
  it("nap duration MAE ≤ 30 min", () => expect(auto.napDurationMAE).toBeLessThan(30));
  it("bedtime MAE ≤ 50 min", () => expect(auto.bedtimeMAE).toBeLessThan(50));
  it("wake time MAE ≤ 55 min", () => expect(auto.wakeTimeMAE).toBeLessThan(55));
  it("nap count accuracy ≥ 78%", () => expect(auto.napCountAccuracy).toBeGreaterThan(0.78));
});
