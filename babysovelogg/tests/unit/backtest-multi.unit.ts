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
      "halldis: 112 days, count 85% (95/112), nap MAE 41.4, dur MAE 24.3, bed MAE 21.4, wake MAE 25.2, nap bias -1.8, count bias +0.04
      baby_1: 619 days, count 80% (498/619), nap MAE 310.8, dur MAE 27.4, bed MAE 148.9, wake MAE 89.6, nap bias +294.5, count bias -0.21
      baby_2: 54 days, count 40% (19/47), nap MAE 64.1, dur MAE 25.5, bed MAE 50.3, wake MAE 84.4, nap bias -0.6, count bias +0.13
      baby_3: 50 days, count 11% (3/28), nap MAE 131.7, dur MAE 35.6, bed MAE 207.5, wake MAE 169.6, nap bias +5.1, count bias +0.79
      baby_5: 8 days, count 0% (0/4), nap MAE 134.3, dur MAE 55.2, bed MAE 1646.1, wake MAE 975, nap bias -69.4, count bias +2.5"
    `);
  });

  it("baby_1 per-month (longest dataset)", () => {
    const buckets = bucketResultsByAge(results[1].result, results[1].birthdate);
    const lines = buckets.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "1mo: 7 days, count 0% (0/7), nap MAE 543.7, dur MAE 39.5, bed MAE 978, wake MAE 0, nap bias +520.1, count bias -3.71
      2mo: 20 days, count 45% (9/20), nap MAE 1055.8, dur MAE 33, bed MAE 1019.5, wake MAE 773.9, nap bias +1052.7, count bias -0.25
      3mo: 23 days, count 17% (4/23), nap MAE 558, dur MAE 31.6, bed MAE 488.5, wake MAE 731.7, nap bias +557.9, count bias -0.78
      4mo: 19 days, count 0% (0/19), nap MAE 369.4, dur MAE 32.1, bed MAE 459.2, wake MAE 457.2, nap bias +365.8, count bias -2.05
      5mo: 13 days, count 8% (1/13), nap MAE 582, dur MAE 31, bed MAE 1312.3, wake MAE 916.7, nap bias +580.1, count bias -2.08
      6mo: 17 days, count 35% (6/17), nap MAE 322.3, dur MAE 37.8, bed MAE 999.5, wake MAE 434.9, nap bias +313.7, count bias -1.41
      7mo: 28 days, count 68% (19/28), nap MAE 103.2, dur MAE 25.2, bed MAE 83.6, wake MAE 58.8, nap bias +65.1, count bias +0.11
      8mo: 31 days, count 77% (24/31), nap MAE 27, dur MAE 20.1, bed MAE 25.2, wake MAE 22.2, nap bias +13, count bias -0.03
      9mo: 28 days, count 75% (21/28), nap MAE 29.4, dur MAE 20.4, bed MAE 29.4, wake MAE 22.2, nap bias +4.2, count bias +0.11
      10mo: 31 days, count 77% (24/31), nap MAE 28.3, dur MAE 20.5, bed MAE 30.3, wake MAE 21.9, nap bias +1.9, count bias +0.03
      11mo: 30 days, count 97% (29/30), nap MAE 39.2, dur MAE 19.8, bed MAE 31, wake MAE 25.7, nap bias -5.3, count bias +0.03
      12mo: 31 days, count 81% (25/31), nap MAE 40.2, dur MAE 26.2, bed MAE 28.8, wake MAE 29.7, nap bias -0.5, count bias +0.13
      13mo: 30 days, count 100% (30/30), nap MAE 15, dur MAE 21.1, bed MAE 23.7, wake MAE 29.5, nap bias -6, count bias 0
      14mo: 29 days, count 83% (24/29), nap MAE 39.8, dur MAE 26.6, bed MAE 41.8, wake MAE 41.7, nap bias +2.3, count bias -0.14
      15mo: 31 days, count 100% (31/31), nap MAE 45.4, dur MAE 26.6, bed MAE 40.4, wake MAE 48.8, nap bias +27.1, count bias 0
      16mo: 29 days, count 100% (29/29), nap MAE 20.8, dur MAE 24.3, bed MAE 33.6, wake MAE 35.1, nap bias +5.6, count bias 0
      17mo: 31 days, count 100% (31/31), nap MAE 22.2, dur MAE 20.3, bed MAE 34.5, wake MAE 29.4, nap bias -6.2, count bias 0
      18mo: 27 days, count 100% (27/27), nap MAE 35, dur MAE 27.6, bed MAE 44.3, wake MAE 27.6, nap bias +12.6, count bias 0
      19mo: 27 days, count 100% (27/27), nap MAE 50.8, dur MAE 25.8, bed MAE 37.6, wake MAE 51.4, nap bias +36.9, count bias 0
      20mo: 29 days, count 100% (29/29), nap MAE 25.6, dur MAE 22.8, bed MAE 30.4, wake MAE 29.8, nap bias +10.5, count bias 0
      21mo: 27 days, count 100% (27/27), nap MAE 19.5, dur MAE 16.1, bed MAE 40.9, wake MAE 30.7, nap bias +5, count bias 0
      22mo: 31 days, count 100% (31/31), nap MAE 19.7, dur MAE 28.7, bed MAE 33.2, wake MAE 31.2, nap bias +1.9, count bias 0
      23mo: 26 days, count 100% (26/26), nap MAE 24, dur MAE 22.1, bed MAE 25.5, wake MAE 35.3, nap bias +7.8, count bias 0
      24mo: 4 days, count 100% (4/4), nap MAE 118.5, dur MAE 34, bed MAE 71, wake MAE 0, nap bias +105, count bias 0
      25mo: 5 days, count 100% (5/5), nap MAE 52.8, dur MAE 58.6, bed MAE 78.5, wake MAE 0, nap bias -35.6, count bias 0
      26mo: 7 days, count 100% (7/7), nap MAE 29.7, dur MAE 13.4, bed MAE 44.1, wake MAE 46.6, nap bias +3.4, count bias 0
      27mo: 7 days, count 100% (7/7), nap MAE 55.5, dur MAE 28, bed MAE 25.5, wake MAE 65.7, nap bias -8, count bias 0
      29mo: 1 days, count 100% (1/1), nap MAE 89, dur MAE 12, bed MAE 0, wake MAE 0, nap bias +89, count bias 0"
    `);
  });

  it("baby_2 per-month", () => {
    const buckets = bucketResultsByAge(results[2].result, results[2].birthdate);
    const lines = buckets.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "0mo: 4 days, count 0% (0/0), nap MAE 0, dur MAE 0, bed MAE 0, wake MAE 0, nap bias 0, count bias 0
      1mo: 3 days, count 0% (0/0), nap MAE 0, dur MAE 0, bed MAE 0, wake MAE 0, nap bias 0, count bias 0
      2mo: 6 days, count 33% (2/6), nap MAE 55.1, dur MAE 17.3, bed MAE 85.5, wake MAE 56.5, nap bias -18, count bias +0.33
      3mo: 8 days, count 38% (3/8), nap MAE 54.6, dur MAE 22.8, bed MAE 99.3, wake MAE 130.5, nap bias -13.8, count bias +0.38
      4mo: 23 days, count 48% (11/23), nap MAE 64.3, dur MAE 26.7, bed MAE 25.2, wake MAE 72.5, nap bias +26.1, count bias -0.22
      5mo: 9 days, count 33% (3/9), nap MAE 78.4, dur MAE 32.7, bed MAE 89.5, wake MAE 166.3, nap bias -42.7, count bias +0.56
      6mo: 1 days, count 0% (0/1), nap MAE 105, dur MAE 7, bed MAE 0, wake MAE 0, nap bias -45, count bias +1"
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
