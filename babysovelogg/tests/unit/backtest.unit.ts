import { describe, expect, it } from "bun:test";
import { backtest, formatReport } from "$lib/engine/backtest.js";
import type { DayRecord } from "$lib/engine/backtest.js";
import type { SleepEntry } from "$lib/types.js";

// --- helpers ---

function sleep(start: string, end: string, type: "nap" | "night" = "nap"): SleepEntry {
  return { start_time: start, end_time: end, type };
}

// =============================================================================
// GOLDEN DATASET: Halldis (born 2025-06-12)
//
// Real sleep data from db.sqlite (March 22-29, 2026) + napper export (Jan 6-7).
// All times are UTC. Halldis is ~9 months during the March period.
// Pattern: mostly 1 nap/day (early nap dropper), bedtime ~16:50-17:40 UTC.
// =============================================================================

const HALLDIS_BIRTHDATE = "2025-06-12";

const HALLDIS_DAYS: DayRecord[] = [
  // --- From napper export (January, ~7 months) ---
  {
    date: "2026-01-06",
    wakeTime: "2026-01-06T05:00:00.000Z", // 06:00 CET
    sleeps: [
      sleep("2026-01-06T08:00:00.000Z", "2026-01-06T08:45:00.000Z", "nap"), // 45 min
      sleep("2026-01-06T12:15:00.000Z", "2026-01-06T13:35:00.000Z", "nap"), // 80 min
      sleep("2026-01-06T17:26:00.000Z", "2026-01-07T04:46:00.000Z", "night"),
    ],
  },
  {
    date: "2026-01-07",
    wakeTime: "2026-01-07T04:46:00.000Z", // 05:46 CET
    sleeps: [
      // Only wake-up recorded, no nap data for this day
    ],
  },

  // --- From db.sqlite (March 22-29, ~9 months) ---
  {
    date: "2026-03-22",
    wakeTime: "2026-03-22T04:45:00.000Z",
    sleeps: [
      sleep("2026-03-22T11:03:45.794Z", "2026-03-22T12:29:57.881Z", "nap"), // 86 min
      sleep("2026-03-22T17:38:00.000Z", "2026-03-23T04:45:00.000Z", "night"),
    ],
  },
  {
    date: "2026-03-23",
    wakeTime: "2026-03-23T04:45:00.000Z", // night ended at 04:45
    sleeps: [
      sleep("2026-03-23T11:00:00.000Z", "2026-03-23T12:50:00.000Z", "nap"), // 110 min
      sleep("2026-03-23T16:55:00.000Z", "2026-03-24T04:50:02.021Z", "night"),
    ],
  },
  {
    date: "2026-03-24",
    wakeTime: "2026-03-24T05:00:00.000Z",
    sleeps: [
      sleep("2026-03-24T11:00:00.000Z", "2026-03-24T12:38:09.515Z", "nap"), // 98 min
      sleep("2026-03-24T17:01:55.009Z", "2026-03-25T04:45:35.348Z", "night"),
    ],
  },
  {
    date: "2026-03-25",
    wakeTime: "2026-03-25T05:00:00.000Z",
    sleeps: [
      sleep("2026-03-25T11:28:24.921Z", "2026-03-25T12:55:13.094Z", "nap"), // 87 min
      sleep("2026-03-25T17:10:00.000Z", "2026-03-26T05:10:00.000Z", "night"),
    ],
  },
  {
    date: "2026-03-26",
    wakeTime: "2026-03-26T05:10:00.000Z",
    sleeps: [
      sleep("2026-03-26T08:57:00.000Z", "2026-03-26T10:48:00.000Z", "nap"), // 111 min
      sleep("2026-03-26T16:50:54.249Z", "2026-03-27T04:50:11.977Z", "night"),
    ],
  },
  {
    date: "2026-03-27",
    wakeTime: "2026-03-27T05:00:00.000Z",
    sleeps: [
      sleep("2026-03-27T08:58:00.000Z", "2026-03-27T09:28:00.000Z", "nap"), // 30 min
      sleep("2026-03-27T12:15:00.000Z", "2026-03-27T12:51:36.553Z", "nap"), // 37 min
      sleep("2026-03-27T16:48:00.000Z", "2026-03-28T05:00:00.000Z", "night"),
    ],
  },
  {
    date: "2026-03-28",
    wakeTime: "2026-03-28T05:15:34.544Z",
    sleeps: [
      sleep("2026-03-28T08:46:35.637Z", "2026-03-28T11:22:56.944Z", "nap"), // 156 min
      sleep("2026-03-28T17:13:54.298Z", "2026-03-29T04:20:00.000Z", "night"),
    ],
  },
  {
    date: "2026-03-29",
    wakeTime: "2026-03-29T04:45:19.724Z",
    sleeps: [
      sleep("2026-03-29T08:44:13.800Z", "2026-03-29T11:00:00.000Z", "nap"), // 136 min
      sleep("2026-03-29T16:20:00.000Z", "2026-03-30T04:30:00.000Z", "night"),
    ],
  },
];

// =============================================================================
// TESTS
// =============================================================================

describe("backtest", () => {
  it("runs on golden dataset and produces metrics", () => {
    const result = backtest(HALLDIS_DAYS, HALLDIS_BIRTHDATE);

    expect(result.totalDays).toBeGreaterThan(0);
    expect(result.napCountAccuracy).toBeGreaterThanOrEqual(0);
    expect(result.napCountAccuracy).toBeLessThanOrEqual(1);
    expect(result.napStartMAE).toBeGreaterThanOrEqual(0);
    expect(result.bedtimeMAE).toBeGreaterThanOrEqual(0);
  });

  it("skips first day (no prior data)", () => {
    const result = backtest(HALLDIS_DAYS, HALLDIS_BIRTHDATE);
    // First day (Jan 6) should be skipped — no prior data to learn from
    expect(result.days[0].date).not.toBe("2026-01-06");
  });

  it("handles days with no naps gracefully", () => {
    // Jan 7 has no naps recorded — should still produce a result
    const result = backtest(HALLDIS_DAYS, HALLDIS_BIRTHDATE);
    const jan7 = result.days.find((d) => d.date === "2026-01-07");
    if (jan7) {
      expect(jan7.actualNaps).toHaveLength(0);
      expect(jan7.napStartErrors).toHaveLength(0);
    }
  });

  it("accepts custom predictor function", () => {
    // A dummy predictor that always returns 0 naps
    const noNaps = () => [];
    const result = backtest(HALLDIS_DAYS, HALLDIS_BIRTHDATE, { predict: noNaps });
    // Should have 0 predicted naps for all days
    for (const day of result.days) {
      expect(day.predictedNaps).toHaveLength(0);
    }
  });
});

describe("baseline: current algorithm on Halldis data", () => {
  const result = backtest(HALLDIS_DAYS, HALLDIS_BIRTHDATE);

  it("prints report", () => {
    const report = formatReport(result, "Halldis baseline (current algorithm)");
    console.log("\n" + report + "\n");
  });

  // ── Regression guards ──
  // Baseline established 2026-03-30 with current algorithm on Halldis data.
  // As we improve the algorithm, tighten these numbers.
  // If a change makes things WORSE, these tests will catch it.
  //
  // Current baseline:
  //   Nap count accuracy: 11% (1/9) — predicts 2 naps, she mostly does 1
  //   Nap start MAE: 90 min
  //   Nap start bias: -73.8 min (predicting too early)
  //   Bedtime MAE: 60.3 min
  //   Nap count bias: +1 (over-predicting nap count)

  it("nap start MAE stays below 95 min", () => {
    expect(result.napStartMAE).toBeLessThan(95);
  });

  it("bedtime MAE stays below 65 min", () => {
    expect(result.bedtimeMAE).toBeLessThan(65);
  });

  it("nap count accuracy stays above 10%", () => {
    expect(result.napCountAccuracy).toBeGreaterThanOrEqual(0.1);
  });
});
