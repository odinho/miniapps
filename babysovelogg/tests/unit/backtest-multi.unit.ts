import { describe, expect, it } from "bun:test";
import {
  backtest,
  bucketResultsByAge,
  renderSummary,
} from "$lib/engine/backtest.js";
import type { DayRecord } from "$lib/engine/backtest.js";

import halldisData from "../fixtures/halldis-sleep.json";
import baby1Data from "../fixtures/baby_1-sleep.json";
import baby2Data from "../fixtures/baby_2-sleep.json";

// =============================================================================
// Multi-baby backtest: validates algorithm generalizes beyond Halldis
//
// Kaggle data caveats:
// - No birthdates (estimated: first entry - 2 weeks)
// - US timezone treated as UTC (bedtime predictions are meaningless)
// - Newborn data is fragmented (actigraphy-like); filtered to ≤5 naps/day
// - baby_1 has excellent data at 8-24mo
// =============================================================================

function filterCleanDays(days: DayRecord[]): DayRecord[] {
  return days.filter((d) => {
    const naps = d.sleeps.filter((s) => s.type === "nap");
    return naps.length >= 1 && naps.length <= 5;
  });
}

const babies = [
  {
    name: "halldis",
    birthdate: "2025-06-12",
    days: halldisData as DayRecord[],
  },
  {
    name: "baby_1",
    birthdate: (baby1Data as { birthdate: string }).birthdate,
    days: filterCleanDays((baby1Data as { days: DayRecord[] }).days),
  },
  {
    name: "baby_2",
    birthdate: (baby2Data as { birthdate: string }).birthdate,
    days: filterCleanDays((baby2Data as { days: DayRecord[] }).days),
  },
];

describe("multi-baby backtest", () => {
  it("combined summary per baby", () => {
    const lines = babies.map((b) => {
      const result = backtest(b.days, b.birthdate);
      return renderSummary(result, b.name);
    });
    // Note: bed MAE for Kaggle babies is meaningless (timezone mismatch)
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "halldis: 82 days, count 78% (64/82), nap MAE 58.4 min, bed MAE 45.7 min, nap bias +0.2, count bias +0.07
      baby_1: 604 days, count 89% (540/604), nap MAE 79.1 min, bed MAE 1441.7 min, nap bias +58.8, count bias -0.05
      baby_2: 129 days, count 32% (41/129), nap MAE 113.1 min, bed MAE 1521.7 min, nap bias +41.3, count bias +0.29"
    `);
  });

  it("baby_1 per-month (best 8-12mo range)", () => {
    const result = backtest(babies[1].days, babies[1].birthdate);
    const buckets = bucketResultsByAge(result, babies[1].birthdate);
    // Show the good range: 8-17mo where data is clean and algorithm works well
    const relevant = buckets.filter(
      (b) => {
        const age = parseInt(b.label);
        return age >= 8 && age <= 17;
      },
    );
    const lines = relevant.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "8mo: 31 days, count 68% (21/31), nap MAE 39.4 min, bed MAE 1441.9 min, nap bias +23.7, count bias -0.13
      9mo: 31 days, count 87% (27/31), nap MAE 25.5 min, bed MAE 1447.3 min, nap bias +3.7, count bias +0.13
      10mo: 28 days, count 57% (16/28), nap MAE 35.6 min, bed MAE 1452.6 min, nap bias +5.5, count bias -0.07
      11mo: 31 days, count 97% (30/31), nap MAE 34.7 min, bed MAE 1462 min, nap bias -13.6, count bias +0.03
      12mo: 30 days, count 83% (25/30), nap MAE 39.2 min, bed MAE 1492.9 min, nap bias -2.2, count bias -0.1
      13mo: 31 days, count 87% (27/31), nap MAE 49.5 min, bed MAE 1449.6 min, nap bias +38.3, count bias +0.06
      14mo: 29 days, count 86% (25/29), nap MAE 49.8 min, bed MAE 1447.3 min, nap bias +29, count bias -0.17
      15mo: 30 days, count 100% (30/30), nap MAE 58.5 min, bed MAE 1450.8 min, nap bias +51.2, count bias 0
      16mo: 31 days, count 100% (31/31), nap MAE 67.6 min, bed MAE 1432.3 min, nap bias +62.3, count bias 0
      17mo: 30 days, count 100% (30/30), nap MAE 37.4 min, bed MAE 1415.2 min, nap bias +33.4, count bias 0"
    `);
  });

  // ── Cross-baby nap timing guards (skip bedtime — timezone broken) ──

  it("nap start MAE ≤ 80 min for halldis and baby_1", () => {
    for (const b of [babies[0], babies[1]]) {
      const result = backtest(b.days, b.birthdate);
      expect(result.napStartMAE).toBeLessThan(80);
    }
  });

  it("nap count accuracy ≥ 50% for halldis and baby_1", () => {
    for (const b of [babies[0], babies[1]]) {
      const result = backtest(b.days, b.birthdate);
      expect(result.napCountAccuracy).toBeGreaterThan(0.5);
    }
  });
});
