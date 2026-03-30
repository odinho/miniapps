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
const days = halldisData as DayRecord[];

// =============================================================================
// Mechanics
// =============================================================================

describe("backtest", () => {
  it("skips first day and handles empty-nap days", () => {
    const result = backtest(days, BIRTHDATE);

    expect(result.totalDays).toBeGreaterThan(0);
    expect(result.days[0].date).not.toBe(days[0].date);
  });

  it("accepts a custom predictor", () => {
    const result = backtest(days, BIRTHDATE, { predict: () => [] });

    expect(result.napCountAccuracy).toBe(0);
    expect(result.napStartMAE).toBe(0);
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
  const auto = backtest(days, BIRTHDATE);
  const buckets = bucketResultsByAge(auto, BIRTHDATE);

  it("per-month breakdown", () => {
    const lines = buckets.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "6mo: 5 days, count 20% (1/5), nap MAE 48 min, bed MAE 63.7 min, nap bias +24.2, count bias -0.8
      7mo: 31 days, count 81% (25/31), nap MAE 49.4 min, bed MAE 50.8 min, nap bias -15.3, count bias +0.13
      8mo: 28 days, count 89% (25/28), nap MAE 32.7 min, bed MAE 43.8 min, nap bias +8.7, count bias +0.11
      9mo: 18 days, count 72% (13/18), nap MAE 173.4 min, bed MAE 53.7 min, nap bias -29.7, count bias +0.17"
    `);
  });

  it("per-month with manual nap count", () => {
    const lines = buckets.map((b) => {
      const n = mostCommonNapCount(b.result);
      const manual = backtest(days, BIRTHDATE, { customNapCount: n });
      const manualBucket = bucketResultsByAge(manual, BIRTHDATE).find(
        (mb) => mb.label === b.label,
      )!;
      return renderSummary(manualBucket.result, `${b.label} manual=${n}`);
    });
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "6mo manual=3: 5 days, count 80% (4/5), nap MAE 55.1 min, bed MAE 63.7 min, nap bias +38.1, count bias +0.2
      7mo manual=2: 31 days, count 84% (26/31), nap MAE 49.4 min, bed MAE 50.8 min, nap bias -15.3, count bias +0.1
      8mo manual=2: 28 days, count 89% (25/28), nap MAE 32.7 min, bed MAE 43.8 min, nap bias +8.7, count bias +0.11
      9mo manual=1: 18 days, count 89% (16/18), nap MAE 182.5 min, bed MAE 55.7 min, nap bias -31.9, count bias -0.11"
    `);
  });

  it("combined summary", () => {
    expect(renderSummary(auto, "all")).toMatchInlineSnapshot(`"all: 82 days, count 78% (64/82), nap MAE 59.8 min, bed MAE 49.9 min, nap bias -5.4, count bias +0.07"`);
  });

  it("warm-up curve", () => {
    const warmup = bucketByWarmup(auto);
    const lines = warmup.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "day 1-3: 3 days, count 33% (1/3), nap MAE 68.8 min, bed MAE 58.7 min, nap bias +33.6, count bias -0.67
      day 4-7: 4 days, count 25% (1/4), nap MAE 30 min, bed MAE 41.4 min, nap bias -9.2, count bias -0.25
      day 8-14: 7 days, count 86% (6/7), nap MAE 70.7 min, bed MAE 52.9 min, nap bias -58.3, count bias +0.14
      day 15+: 68 days, count 82% (56/68), nap MAE 60.2 min, bed MAE 49.7 min, nap bias -1.1, count bias +0.12"
    `);
  });

  // ── Regression guards ──
  it("nap start MAE ≤ 60 min", () => expect(auto.napStartMAE).toBeLessThan(60));
  it("bedtime MAE ≤ 50 min", () => expect(auto.bedtimeMAE).toBeLessThan(50));
  it("nap count accuracy ≥ 75%", () => expect(auto.napCountAccuracy).toBeGreaterThan(0.75));
});
