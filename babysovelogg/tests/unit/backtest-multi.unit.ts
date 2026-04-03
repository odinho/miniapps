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
import baby3Data from "../fixtures/baby_3-sleep.json";
import baby5Data from "../fixtures/baby_5-sleep.json";

// =============================================================================
// Multi-baby backtest: validates algorithm generalizes beyond Halldis
//
// Data sources:
//   halldis — parent-logged via Napper + babysovelogg, Europe/Oslo
//   baby_1..5 — Kaggle "Tracking Babies Daily", assumed US Eastern
// =============================================================================

interface BabyFixture {
  name: string;
  birthdate: string;
  tz: string;
  days: DayRecord[];
}

function loadKaggle(name: string, data: { birthdate: string; days: DayRecord[] }): BabyFixture {
  return { name, birthdate: data.birthdate, tz: "America/New_York", days: data.days };
}

// baby_4 dropped — only 1 night entry total, no complete days after filtering
const babies: BabyFixture[] = [
  { name: "halldis", birthdate: "2025-06-12", tz: "Europe/Oslo", days: halldisData as DayRecord[] },
  loadKaggle("baby_1", baby1Data as { birthdate: string; days: DayRecord[] }),
  loadKaggle("baby_2", baby2Data as { birthdate: string; days: DayRecord[] }),
  loadKaggle("baby_3", baby3Data as { birthdate: string; days: DayRecord[] }),
  loadKaggle("baby_5", baby5Data as { birthdate: string; days: DayRecord[] }),
];

describe("multi-baby backtest", () => {
  const results = babies.map((b) => ({
    ...b,
    result: backtest(b.days, b.birthdate, { tz: b.tz }),
  }));

  it("all babies summary", () => {
    const lines = results.map((r) => renderSummary(r.result, r.name));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "halldis: 86 days, count 83% (71/86), nap MAE 44.2, dur MAE 23.1, bed MAE 22.6, wake MAE 25.6, nap bias -3.3, count bias +0.08
      baby_1: 619 days, count 82% (505/619), nap MAE 341.6, dur MAE 27.1, bed MAE 176.4, wake MAE 89.3, nap bias +325.6, count bias -0.1
      baby_2: 54 days, count 35% (19/54), nap MAE 86.7, dur MAE 31.1, bed MAE 131.2, wake MAE 77.9, nap bias +4.6, count bias -0.3
      baby_3: 50 days, count 20% (10/50), nap MAE 343.7, dur MAE 36, bed MAE 502.3, wake MAE 309, nap bias +268.9, count bias +0.28
      baby_5: 8 days, count 0% (0/8), nap MAE 177.2, dur MAE 30.6, bed MAE 1798.7, wake MAE 722, nap bias +2.8, count bias +0.75"
    `);
  });

  it("baby_1 per-month (longest dataset)", () => {
    const buckets = bucketResultsByAge(results[1].result, results[1].birthdate);
    const lines = buckets.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "1mo: 7 days, count 0% (0/7), nap MAE 520, dur MAE 41.8, bed MAE 937.3, wake MAE 0, nap bias +482.8, count bias -3.43
      2mo: 20 days, count 55% (11/20), nap MAE 1113.7, dur MAE 32.2, bed MAE 974.6, wake MAE 724.1, nap bias +1107.4, count bias +0.55
      3mo: 23 days, count 17% (4/23), nap MAE 580.6, dur MAE 31.7, bed MAE 576.7, wake MAE 738.3, nap bias +580.1, count bias -0.26
      4mo: 19 days, count 21% (4/19), nap MAE 468.8, dur MAE 30.6, bed MAE 938.1, wake MAE 478.5, nap bias +466.4, count bias -1.16
      5mo: 13 days, count 15% (2/13), nap MAE 753.4, dur MAE 32.3, bed MAE 1437.3, wake MAE 1047.7, nap bias +752.2, count bias -1.08
      6mo: 17 days, count 29% (5/17), nap MAE 343.5, dur MAE 35.1, bed MAE 1443.8, wake MAE 424, nap bias +342.5, count bias -0.53
      7mo: 28 days, count 68% (19/28), nap MAE 102.5, dur MAE 25, bed MAE 116.9, wake MAE 56.3, nap bias +71.9, count bias 0
      8mo: 31 days, count 77% (24/31), nap MAE 27, dur MAE 20.1, bed MAE 25.2, wake MAE 22.2, nap bias +13, count bias -0.03
      9mo: 28 days, count 75% (21/28), nap MAE 29.4, dur MAE 20.4, bed MAE 29.4, wake MAE 22.2, nap bias +4.2, count bias +0.11
      10mo: 31 days, count 77% (24/31), nap MAE 28.3, dur MAE 20.5, bed MAE 33.8, wake MAE 21.9, nap bias +1.9, count bias +0.03
      11mo: 30 days, count 97% (29/30), nap MAE 39.2, dur MAE 19.8, bed MAE 33, wake MAE 25.7, nap bias -5.3, count bias +0.03
      12mo: 31 days, count 81% (25/31), nap MAE 40.2, dur MAE 26.2, bed MAE 37.4, wake MAE 29.7, nap bias -0.5, count bias +0.13
      13mo: 30 days, count 100% (30/30), nap MAE 15, dur MAE 21.1, bed MAE 23.7, wake MAE 29.2, nap bias -6, count bias 0
      14mo: 29 days, count 86% (25/29), nap MAE 40, dur MAE 26.9, bed MAE 41.4, wake MAE 40.1, nap bias +2.1, count bias -0.17
      15mo: 31 days, count 100% (31/31), nap MAE 45.4, dur MAE 26.6, bed MAE 40.6, wake MAE 49.6, nap bias +27.1, count bias 0
      16mo: 29 days, count 100% (29/29), nap MAE 19.9, dur MAE 24.4, bed MAE 34.2, wake MAE 35.3, nap bias +6.6, count bias 0
      17mo: 31 days, count 100% (31/31), nap MAE 22.2, dur MAE 20.3, bed MAE 34.5, wake MAE 29.4, nap bias -6.2, count bias 0
      18mo: 27 days, count 100% (27/27), nap MAE 33.5, dur MAE 25.8, bed MAE 44.4, wake MAE 27.5, nap bias +10.9, count bias 0
      19mo: 27 days, count 100% (27/27), nap MAE 47.8, dur MAE 24.6, bed MAE 35.5, wake MAE 51.2, nap bias +30.5, count bias 0
      20mo: 29 days, count 100% (29/29), nap MAE 25.1, dur MAE 22.1, bed MAE 30.3, wake MAE 30.6, nap bias +9.7, count bias 0
      21mo: 27 days, count 100% (27/27), nap MAE 19.2, dur MAE 16.1, bed MAE 42.3, wake MAE 30.7, nap bias +4.8, count bias 0
      22mo: 31 days, count 100% (31/31), nap MAE 19.7, dur MAE 28.7, bed MAE 33.2, wake MAE 31.2, nap bias +1.9, count bias 0
      23mo: 26 days, count 100% (26/26), nap MAE 22.6, dur MAE 20.9, bed MAE 23.3, wake MAE 38.5, nap bias +5.7, count bias 0
      24mo: 4 days, count 100% (4/4), nap MAE 118.9, dur MAE 13.5, bed MAE 54.9, wake MAE 0, nap bias +97.5, count bias 0
      25mo: 5 days, count 100% (5/5), nap MAE 52.8, dur MAE 33.8, bed MAE 82.1, wake MAE 0, nap bias -23.6, count bias 0
      26mo: 7 days, count 100% (7/7), nap MAE 30.7, dur MAE 11.1, bed MAE 35.2, wake MAE 45.3, nap bias -2.7, count bias 0
      27mo: 7 days, count 100% (7/7), nap MAE 46.4, dur MAE 23.7, bed MAE 16.4, wake MAE 29.1, nap bias -11.2, count bias 0
      29mo: 1 days, count 100% (1/1), nap MAE 110.5, dur MAE 35, bed MAE 0, wake MAE 0, nap bias +110.5, count bias 0"
    `);
  });

  it("baby_2 per-month", () => {
    const buckets = bucketResultsByAge(results[2].result, results[2].birthdate);
    const lines = buckets.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "0mo: 4 days, count 25% (1/4), nap MAE 157.7, dur MAE 44.3, bed MAE 0, wake MAE 0, nap bias -11.3, count bias -3.25
      1mo: 3 days, count 0% (0/3), nap MAE 213.5, dur MAE 31.1, bed MAE 2344, wake MAE 0, nap bias -111.8, count bias +0.67
      2mo: 6 days, count 33% (2/6), nap MAE 59.9, dur MAE 29, bed MAE 101.1, wake MAE 71.6, nap bias +19.7, count bias +0.5
      3mo: 8 days, count 25% (2/8), nap MAE 51.5, dur MAE 30.3, bed MAE 102.9, wake MAE 102.6, nap bias +21.4, count bias -0.87
      4mo: 23 days, count 48% (11/23), nap MAE 66.1, dur MAE 27, bed MAE 31.5, wake MAE 80.4, nap bias +22.4, count bias -0.22
      5mo: 9 days, count 33% (3/9), nap MAE 60.7, dur MAE 36.6, bed MAE 113.4, wake MAE 54.6, nap bias +4.5, count bias +0.33
      6mo: 1 days, count 0% (0/1), nap MAE 120, dur MAE 23, bed MAE 0, wake MAE 0, nap bias -60, count bias +1"
    `);
  });

  // ── Cross-baby regression guards ──
  // baby_1 overall MAE is dragged by newborn months (0-6mo) where no algorithm
  // works. The signal window (8-17mo) is the real benchmark: 15-45 min nap MAE.
  // After dropping fabricated-wake days, baby_1 has fewer days and the
  // newborn proportion is higher, pushing overall MAE up.

  it("halldis nap MAE < 50 min", () => {
    expect(results[0].result.napStartMAE).toBeLessThan(50);
  });

  it("baby_1 wake MAE < 100 min (adjacent-day scoring)", () => {
    expect(results[1].result.wakeTimeMAE).toBeLessThan(100);
  });
});
