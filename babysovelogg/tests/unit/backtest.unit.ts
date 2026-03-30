import { describe, expect, it } from "bun:test";
import { backtest, bucketByAge, formatReport } from "$lib/engine/backtest.js";
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
// All times are UTC instants — DST does not affect predictions.
//
// Add more data here as it becomes available (e.g. re-export from Napper with
// full history). The bucketByAge helper will automatically segment by period.
// =============================================================================

const HALLDIS_BIRTHDATE = "2025-06-12";

const HALLDIS_DAYS: DayRecord[] = [
  // ── Napper export (January 2026, ~7 months, 2-nap pattern) ──
  // Only 2 days available — re-export from Napper for full history!
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
    sleeps: [], // Only wake-up recorded, no further data for this day
  },

  // ── db.sqlite (March 22-29, 2026, ~9 months, 1-nap pattern) ──
  // Note: she's an early nap dropper — mostly 1 nap at 9mo where default is 2
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
    wakeTime: "2026-03-23T04:45:00.000Z",
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

// Extract just the March days (9mo period, enough for meaningful backtest)
const MARCH_DAYS = HALLDIS_DAYS.filter((d) => d.date.startsWith("2026-03"));

// =============================================================================
// TESTS
// =============================================================================

describe("backtest mechanics", () => {
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
    expect(result.days[0].date).not.toBe("2026-01-06");
  });

  it("handles days with no naps gracefully", () => {
    const result = backtest(HALLDIS_DAYS, HALLDIS_BIRTHDATE);
    const jan7 = result.days.find((d) => d.date === "2026-01-07");
    if (jan7) {
      expect(jan7.actualNaps).toHaveLength(0);
      expect(jan7.napStartErrors).toHaveLength(0);
    }
  });

  it("accepts custom predictor function", () => {
    const result = backtest(HALLDIS_DAYS, HALLDIS_BIRTHDATE, { predict: () => [] });
    for (const day of result.days) {
      expect(day.predictedNaps).toHaveLength(0);
    }
  });

  it("all times in golden dataset are UTC instants", () => {
    for (const day of HALLDIS_DAYS) {
      expect(day.wakeTime).toMatch(/Z$/);
      for (const s of day.sleeps) {
        expect(s.start_time).toMatch(/Z$/);
        if (s.end_time) expect(s.end_time).toMatch(/Z$/);
      }
    }
  });
});

describe("bucketByAge", () => {
  it("groups Halldis data into age periods", () => {
    const buckets = bucketByAge(HALLDIS_DAYS, HALLDIS_BIRTHDATE);
    expect(buckets.length).toBeGreaterThanOrEqual(1);

    // January data (~7 months) should be in 6-9mo bucket
    const bucket7 = buckets.find((b) => b.label === "6-9mo");
    expect(bucket7).toBeDefined();
    expect(bucket7!.days.some((d) => d.date === "2026-01-06")).toBe(true);

    // March data (~9 months) should be in 9-12mo bucket
    const bucket9 = buckets.find((b) => b.label === "9-12mo");
    expect(bucket9).toBeDefined();
    expect(bucket9!.days.length).toBe(8);
  });
});

// =============================================================================
// BASELINE: Full dataset (all ages combined)
// =============================================================================

describe("baseline: all data, auto nap count", () => {
  const result = backtest(HALLDIS_DAYS, HALLDIS_BIRTHDATE);

  it("prints report", () => {
    console.log("\n" + formatReport(result, "ALL DATA — auto nap count") + "\n");
  });

  // Regression guards (baseline 2026-03-30)
  //   Nap count accuracy: 11% — predicts 2, she does 1
  //   Nap start MAE: 90 min
  //   Bedtime MAE: 60.3 min
  it("nap start MAE ≤ 95 min", () => expect(result.napStartMAE).toBeLessThan(95));
  it("bedtime MAE ≤ 65 min", () => expect(result.bedtimeMAE).toBeLessThan(65));
  it("nap count accuracy ≥ 10%", () => expect(result.napCountAccuracy).toBeGreaterThanOrEqual(0.1));
});

// =============================================================================
// BASELINE: 9-month period (March), auto vs manual nap count
//
// This is the core comparison: how much does just knowing the correct nap count
// improve predictions? The gap between these two is the "nap count penalty".
// =============================================================================

describe("baseline: 9mo period, auto nap count", () => {
  const result = backtest(MARCH_DAYS, HALLDIS_BIRTHDATE);

  it("prints report", () => {
    console.log("\n" + formatReport(result, "9 MONTHS — auto nap count (predicts 2)") + "\n");
  });

  // At 9mo the algorithm predicts 2 naps, but Halldis mostly does 1.
  // This is the "worst case" — the nap count is wrong.
  it("nap start MAE ≤ 85 min", () => expect(result.napStartMAE).toBeLessThan(85));
  it("bedtime MAE ≤ 70 min", () => expect(result.bedtimeMAE).toBeLessThan(70));
});

describe("baseline: 9mo period, manual nap count = 1", () => {
  const result = backtest(MARCH_DAYS, HALLDIS_BIRTHDATE, { customNapCount: 1 });

  it("prints report", () => {
    console.log(
      "\n" + formatReport(result, "9 MONTHS — manual nap count = 1 (user override)") + "\n",
    );
  });

  // With correct nap count, nap count accuracy jumps from 14% to 86%.
  // Mar 27 was an unusual 2-nap day, so not 100%.
  it("nap count accuracy ≥ 80%", () => {
    expect(result.napCountAccuracy).toBeGreaterThanOrEqual(0.8);
  });

  // KEY INSIGHT: nap start MAE barely changes (81.4 → 81.2) because the
  // wake window constants are calibrated for 2-nap babies. A 1-nap baby
  // needs ~6h wake window but the 9-12mo range caps at 210 min (3.5h).
  // Early days have huge errors (-165 min) because no prior data to learn from.
  // Later days (Mar 26-29) learn from data and get much closer (-1 to -29 min).
  // → Next improvement: wake windows must adapt to actual nap count.
  it("nap start MAE ≤ 85 min", () => {
    expect(result.napStartMAE).toBeLessThan(85);
  });

  it("bedtime MAE ≤ 70 min", () => expect(result.bedtimeMAE).toBeLessThan(70));
});

// =============================================================================
// BASELINE: 7-month period (January) — needs more data
// Only 2 days from napper export. Will become useful after re-export.
// =============================================================================

describe("baseline: 7mo period (needs more napper data)", () => {
  const janDays = HALLDIS_DAYS.filter((d) => d.date.startsWith("2026-01"));

  it("has too few days for meaningful backtest", () => {
    const result = backtest(janDays, HALLDIS_BIRTHDATE);
    // Only 1 testable day (Jan 7, which has no naps) — not meaningful yet
    expect(result.totalDays).toBeLessThanOrEqual(1);
    console.log(
      `\n7 MONTHS — only ${janDays.length} days available, need more napper data\n`,
    );
  });
});
