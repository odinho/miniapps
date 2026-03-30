import { describe, expect, it } from "bun:test";
import { backtest, bucketResultsByAge, renderSummary } from "$lib/engine/backtest.js";
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
//
// Two modes per bucket:
//   auto — algorithm picks nap count from age tables
//   manual=N — user overrides to correct nap count
//
// Bucketing happens on RESULTS so each day keeps its full 7-day lookback.
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
  const autoBuckets = bucketResultsByAge(auto, BIRTHDATE);

  it("all data, auto nap count", () => {
    expect(renderSummary(auto, "all-auto")).toMatchSnapshot();
  });

  for (const bucket of autoBuckets) {
    const napCount = mostCommonNapCount(bucket.result);
    const manualFull = backtest(days, BIRTHDATE, { customNapCount: napCount });
    const manualBuckets = bucketResultsByAge(manualFull, BIRTHDATE);
    const manualBucket = manualBuckets.find((b) => b.label === bucket.label)!;

    describe(bucket.label, () => {
      it("auto vs manual", () => {
        expect([
          renderSummary(bucket.result, "auto"),
          renderSummary(manualBucket.result, `manual=${napCount}`),
        ].join("\n")).toMatchSnapshot();
      });

      it("manual override does not worsen nap count accuracy", () => {
        expect(manualBucket.result.napCountAccuracy)
          .toBeGreaterThanOrEqual(bucket.result.napCountAccuracy);
      });
    });
  }

  // ── Regression guards (baseline 2026-03-30, 83 days) ──

  it("nap start MAE ≤ 65 min", () => {
    expect(auto.napStartMAE).toBeLessThan(65);
  });

  it("bedtime MAE ≤ 50 min", () => {
    expect(auto.bedtimeMAE).toBeLessThan(50);
  });

  it("nap count accuracy ≥ 60%", () => {
    expect(auto.napCountAccuracy).toBeGreaterThan(0.6);
  });
});
