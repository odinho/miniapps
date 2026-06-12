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
// baby_5 excluded — data quality: only 9 days, night sleeps are truncated (3-4h tails only,
// no full overnight entry), overlapping entries on some days. Bed MAE 1466+ min across all
// timezones confirms the issue is structural, not a timezone offset.

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
];

describe("multi-baby backtest", () => {
  const results = babies.map((b) => ({
    ...b,
    result: backtest(b.days, b.birthdate, { tz: b.tz }),
  }));

  it("all babies summary", () => {
    const lines = results.map((r) => renderSummary(r.result, r.name));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "halldis: 138 days, count 86% (118/138), naps 1.5p/1.5a, nap MAE 39.7, dur MAE 25, bed MAE 22, wake MAE 26.4, nap bias -3.3, count bias +0.03, cycle 138/0/0 (l/m/h), cut-short 8
      baby_1: 619 days, count 80% (498/619), naps 2.2p/2.4a, nap MAE 310.4, dur MAE 27.4, bed MAE 148.9, wake MAE 89.7, nap bias +294.3, count bias -0.21, cycle 619/0/0 (l/m/h), cut-short 0
      baby_2: 54 days, count 40% (19/47), naps 3.1p/3.0a, nap MAE 63.1, dur MAE 25.5, bed MAE 50.3, wake MAE 84.6, nap bias -3.1, count bias +0.13, cycle 47/0/0 (l/m/h), cut-short 0
      baby_3: 50 days, count 11% (3/28), naps 4.0p/3.2a, nap MAE 132.2, dur MAE 35.6, bed MAE 207.5, wake MAE 169.7, nap bias +5.9, count bias +0.79, cycle 28/0/0 (l/m/h), cut-short 0"
    `);
  });

  it("baby_1 per-month (longest dataset)", () => {
    const buckets = bucketResultsByAge(results[1].result, results[1].birthdate);
    const lines = buckets.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "1mo: 7 days, count 0% (0/7), naps 6.0p/9.7a, nap MAE 543.4, dur MAE 39.6, bed MAE 978, wake MAE 0, nap bias +517.4, count bias -3.71, cycle 7/0/0 (l/m/h), cut-short 0
      2mo: 20 days, count 45% (9/20), naps 7.7p/8.0a, nap MAE 1061.6, dur MAE 33.2, bed MAE 1019.5, wake MAE 777.3, nap bias +1059.3, count bias -0.25, cycle 20/0/0 (l/m/h), cut-short 0
      3mo: 23 days, count 17% (4/23), naps 6.2p/7.0a, nap MAE 552, dur MAE 31.6, bed MAE 488.5, wake MAE 728.1, nap bias +552, count bias -0.78, cycle 23/0/0 (l/m/h), cut-short 0
      4mo: 19 days, count 0% (0/19), naps 5.1p/7.2a, nap MAE 365.9, dur MAE 32.1, bed MAE 459.2, wake MAE 457.7, nap bias +361.4, count bias -2.05, cycle 19/0/0 (l/m/h), cut-short 0
      5mo: 13 days, count 8% (1/13), naps 4.4p/6.5a, nap MAE 582.7, dur MAE 31, bed MAE 1312.3, wake MAE 916.7, nap bias +582.2, count bias -2.08, cycle 13/0/0 (l/m/h), cut-short 0
      6mo: 17 days, count 35% (6/17), naps 5.0p/6.4a, nap MAE 316.9, dur MAE 38, bed MAE 999.5, wake MAE 434.1, nap bias +312.1, count bias -1.41, cycle 17/0/0 (l/m/h), cut-short 0
      7mo: 28 days, count 68% (19/28), naps 3.3p/3.1a, nap MAE 107.7, dur MAE 25.2, bed MAE 83.6, wake MAE 59.5, nap bias +63, count bias +0.11, cycle 28/0/0 (l/m/h), cut-short 0
      8mo: 31 days, count 77% (24/31), naps 2.9p/2.9a, nap MAE 27.1, dur MAE 20.1, bed MAE 25.2, wake MAE 23.4, nap bias +11.4, count bias -0.03, cycle 31/0/0 (l/m/h), cut-short 0
      9mo: 28 days, count 75% (21/28), naps 2.8p/2.7a, nap MAE 28, dur MAE 20.4, bed MAE 29.4, wake MAE 22.4, nap bias +3.6, count bias +0.11, cycle 28/0/0 (l/m/h), cut-short 0
      10mo: 31 days, count 77% (24/31), naps 2.3p/2.2a, nap MAE 28.3, dur MAE 20.5, bed MAE 30.3, wake MAE 21.7, nap bias +3.6, count bias +0.03, cycle 31/0/0 (l/m/h), cut-short 0
      11mo: 30 days, count 97% (29/30), naps 2.0p/2.0a, nap MAE 40.7, dur MAE 19.8, bed MAE 31, wake MAE 25.1, nap bias +2.9, count bias +0.03, cycle 30/0/0 (l/m/h), cut-short 0
      12mo: 31 days, count 81% (25/31), naps 1.8p/1.6a, nap MAE 42.4, dur MAE 26.2, bed MAE 28.8, wake MAE 29.2, nap bias +1.1, count bias +0.13, cycle 31/0/0 (l/m/h), cut-short 0
      13mo: 30 days, count 100% (30/30), naps 1.0p/1.0a, nap MAE 14.7, dur MAE 21.1, bed MAE 23.7, wake MAE 29.9, nap bias -5.3, count bias 0, cycle 30/0/0 (l/m/h), cut-short 0
      14mo: 29 days, count 83% (24/29), naps 1.0p/1.2a, nap MAE 43.2, dur MAE 26.6, bed MAE 41.8, wake MAE 41, nap bias +7.2, count bias -0.14, cycle 29/0/0 (l/m/h), cut-short 0
      15mo: 31 days, count 100% (31/31), naps 1.0p/1.0a, nap MAE 45.4, dur MAE 26.6, bed MAE 40.4, wake MAE 48, nap bias +27.1, count bias 0, cycle 31/0/0 (l/m/h), cut-short 0
      16mo: 29 days, count 100% (29/29), naps 1.0p/1.0a, nap MAE 20.8, dur MAE 24.3, bed MAE 33.6, wake MAE 35.1, nap bias +5.7, count bias 0, cycle 29/0/0 (l/m/h), cut-short 0
      17mo: 31 days, count 100% (31/31), naps 1.0p/1.0a, nap MAE 22.1, dur MAE 20.3, bed MAE 34.5, wake MAE 29.6, nap bias -6.1, count bias 0, cycle 31/0/0 (l/m/h), cut-short 0
      18mo: 27 days, count 100% (27/27), naps 1.0p/1.0a, nap MAE 35, dur MAE 27.6, bed MAE 44.3, wake MAE 28, nap bias +12.6, count bias 0, cycle 27/0/0 (l/m/h), cut-short 0
      19mo: 27 days, count 100% (27/27), naps 1.0p/1.0a, nap MAE 50.8, dur MAE 25.8, bed MAE 37.6, wake MAE 50.9, nap bias +36.9, count bias 0, cycle 27/0/0 (l/m/h), cut-short 0
      20mo: 29 days, count 100% (29/29), naps 1.0p/1.0a, nap MAE 25.6, dur MAE 22.8, bed MAE 30.4, wake MAE 30.7, nap bias +10.5, count bias 0, cycle 29/0/0 (l/m/h), cut-short 0
      21mo: 27 days, count 100% (27/27), naps 1.0p/1.0a, nap MAE 19.5, dur MAE 16.1, bed MAE 40.9, wake MAE 31.3, nap bias +5.1, count bias 0, cycle 27/0/0 (l/m/h), cut-short 0
      22mo: 31 days, count 100% (31/31), naps 1.0p/1.0a, nap MAE 19.7, dur MAE 28.7, bed MAE 33.2, wake MAE 32, nap bias +1.9, count bias 0, cycle 31/0/0 (l/m/h), cut-short 0
      23mo: 26 days, count 100% (26/26), naps 1.0p/1.0a, nap MAE 24, dur MAE 22.1, bed MAE 25.5, wake MAE 35.5, nap bias +7.8, count bias 0, cycle 26/0/0 (l/m/h), cut-short 0
      24mo: 4 days, count 100% (4/4), naps 1.0p/1.0a, nap MAE 118.5, dur MAE 34, bed MAE 71, wake MAE 0, nap bias +105, count bias 0, cycle 4/0/0 (l/m/h), cut-short 0
      25mo: 5 days, count 100% (5/5), naps 1.0p/1.0a, nap MAE 52.8, dur MAE 58.6, bed MAE 78.5, wake MAE 0, nap bias -35.6, count bias 0, cycle 5/0/0 (l/m/h), cut-short 0
      26mo: 7 days, count 100% (7/7), naps 1.0p/1.0a, nap MAE 29.7, dur MAE 13.4, bed MAE 44.1, wake MAE 46.5, nap bias +3.5, count bias 0, cycle 7/0/0 (l/m/h), cut-short 0
      27mo: 7 days, count 100% (7/7), naps 1.0p/1.0a, nap MAE 55.5, dur MAE 28, bed MAE 25.5, wake MAE 66, nap bias -7.9, count bias 0, cycle 7/0/0 (l/m/h), cut-short 0
      29mo: 1 days, count 100% (1/1), naps 1.0p/1.0a, nap MAE 89, dur MAE 12, bed MAE 0, wake MAE 0, nap bias +89, count bias 0, cycle 1/0/0 (l/m/h), cut-short 0"
    `);
  });

  it("baby_2 per-month", () => {
    const buckets = bucketResultsByAge(results[2].result, results[2].birthdate);
    const lines = buckets.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "0mo: 4 days, count 0% (0/0), naps 0.0p/0.0a, nap MAE 0, dur MAE 0, bed MAE 0, wake MAE 0, nap bias 0, count bias 0, cycle 0/0/0 (l/m/h), cut-short 0
      1mo: 3 days, count 0% (0/0), naps 0.0p/0.0a, nap MAE 0, dur MAE 0, bed MAE 0, wake MAE 0, nap bias 0, count bias 0, cycle 0/0/0 (l/m/h), cut-short 0
      2mo: 6 days, count 33% (2/6), naps 4.0p/3.7a, nap MAE 54.2, dur MAE 17.1, bed MAE 85.5, wake MAE 56, nap bias -17.2, count bias +0.33, cycle 6/0/0 (l/m/h), cut-short 0
      3mo: 8 days, count 38% (3/8), naps 3.0p/2.6a, nap MAE 55.4, dur MAE 22.8, bed MAE 99.3, wake MAE 132, nap bias -13.9, count bias +0.38, cycle 8/0/0 (l/m/h), cut-short 0
      4mo: 23 days, count 48% (11/23), naps 3.0p/3.2a, nap MAE 62.3, dur MAE 26.7, bed MAE 25.2, wake MAE 72.7, nap bias +20.7, count bias -0.22, cycle 23/0/0 (l/m/h), cut-short 0
      5mo: 9 days, count 33% (3/9), naps 3.0p/2.4a, nap MAE 78.2, dur MAE 32.8, bed MAE 89.5, wake MAE 166.3, nap bias -43, count bias +0.56, cycle 9/0/0 (l/m/h), cut-short 0
      6mo: 1 days, count 0% (0/1), naps 2.0p/1.0a, nap MAE 105, dur MAE 7, bed MAE 0, wake MAE 0, nap bias -45, count bias +1, cycle 1/0/0 (l/m/h), cut-short 0"
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
