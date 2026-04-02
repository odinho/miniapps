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
import baby4Data from "../fixtures/baby_4-sleep.json";
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

const babies: BabyFixture[] = [
  { name: "halldis", birthdate: "2025-06-12", tz: "Europe/Oslo", days: halldisData as DayRecord[] },
  loadKaggle("baby_1", baby1Data as { birthdate: string; days: DayRecord[] }),
  loadKaggle("baby_2", baby2Data as { birthdate: string; days: DayRecord[] }),
  loadKaggle("baby_3", baby3Data as { birthdate: string; days: DayRecord[] }),
  loadKaggle("baby_4", baby4Data as { birthdate: string; days: DayRecord[] }),
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
      "halldis: 82 days, count 80% (66/82), nap MAE 58.6, dur MAE 23.8, bed MAE 39.3, wake MAE 43.6, nap bias +9, count bias +0.07
      baby_1: 803 days, count 72% (576/803), nap MAE 103.7, dur MAE 32, bed MAE 324.9, wake MAE 800.9, nap bias +87.5, count bias -0.7
      baby_2: 147 days, count 37% (55/147), nap MAE 92.2, dur MAE 35.7, bed MAE 176.2, wake MAE 576.6, nap bias +56.4, count bias -0.29
      baby_3: 70 days, count 24% (17/70), nap MAE 108.2, dur MAE 38.9, bed MAE 1316.1, wake MAE 1397.5, nap bias +51.6, count bias -0.24
      baby_4: 25 days, count 20% (5/25), nap MAE 83.7, dur MAE 32.1, bed MAE 0, wake MAE 0, nap bias +72.9, count bias +0.16
      baby_5: 41 days, count 5% (2/41), nap MAE 110.4, dur MAE 36.1, bed MAE 891.2, wake MAE 3060.4, nap bias +106.6, count bias -1.02"
    `);
  });

  it("baby_1 per-month (longest dataset)", () => {
    const buckets = bucketResultsByAge(results[1].result, results[1].birthdate);
    const lines = buckets.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "0mo: 15 days, count 13% (2/15), nap MAE 102.4, dur MAE 33.6, bed MAE 1393.3, wake MAE 974, nap bias +83.1, count bias -2.53
      1mo: 31 days, count 13% (4/31), nap MAE 105.8, dur MAE 37, bed MAE 424.8, wake MAE 408, nap bias +91, count bias -3.87
      2mo: 30 days, count 20% (6/30), nap MAE 79.9, dur MAE 38.3, bed MAE 473, wake MAE 628.9, nap bias +64.4, count bias -2.6
      3mo: 30 days, count 10% (3/30), nap MAE 76.7, dur MAE 41.3, bed MAE 330.5, wake MAE 624.9, nap bias +56.6, count bias -2.33
      4mo: 31 days, count 10% (3/31), nap MAE 124.2, dur MAE 37, bed MAE 888.6, wake MAE 580.5, nap bias +124.1, count bias -2.06
      5mo: 30 days, count 3% (1/30), nap MAE 143, dur MAE 33.6, bed MAE 849.9, wake MAE 509.6, nap bias +141.8, count bias -2.57
      6mo: 31 days, count 19% (6/31), nap MAE 240.8, dur MAE 37.8, bed MAE 1167.3, wake MAE 801.7, nap bias +240.8, count bias -1.81
      7mo: 30 days, count 33% (10/30), nap MAE 117.4, dur MAE 30.7, bed MAE 1117.3, wake MAE 1021.5, nap bias +109.2, count bias -1.97
      8mo: 31 days, count 77% (24/31), nap MAE 33.5, dur MAE 24.5, bed MAE 875.9, wake MAE 851.7, nap bias +7.2, count bias -0.03
      9mo: 31 days, count 87% (27/31), nap MAE 24, dur MAE 20.7, bed MAE 923.1, wake MAE 910.1, nap bias -11.2, count bias +0.13
      10mo: 28 days, count 64% (18/28), nap MAE 41.6, dur MAE 24.1, bed MAE 310.2, wake MAE 287.5, nap bias -2.5, count bias 0
      11mo: 31 days, count 97% (30/31), nap MAE 43.3, dur MAE 24.1, bed MAE 28, wake MAE 24.5, nap bias -22.9, count bias +0.03
      12mo: 30 days, count 90% (27/30), nap MAE 39.9, dur MAE 26.7, bed MAE 35.2, wake MAE 34, nap bias -8.3, count bias +0.1
      13mo: 31 days, count 87% (27/31), nap MAE 33.8, dur MAE 28, bed MAE 38.7, wake MAE 35.2, nap bias -3.1, count bias +0.06
      14mo: 29 days, count 86% (25/29), nap MAE 39.7, dur MAE 27.7, bed MAE 39.7, wake MAE 130.3, nap bias +5.2, count bias -0.17
      15mo: 30 days, count 100% (30/30), nap MAE 45.3, dur MAE 29, bed MAE 41.8, wake MAE 39.6, nap bias +3.5, count bias 0
      16mo: 31 days, count 100% (31/31), nap MAE 57, dur MAE 27.5, bed MAE 42.2, wake MAE 52, nap bias +35.7, count bias 0
      17mo: 30 days, count 100% (30/30), nap MAE 22, dur MAE 22.6, bed MAE 26.5, wake MAE 23.3, nap bias -0.6, count bias 0
      18mo: 31 days, count 100% (31/31), nap MAE 55.4, dur MAE 22.8, bed MAE 94.2, wake MAE 93.5, nap bias +44.1, count bias 0
      19mo: 29 days, count 100% (29/29), nap MAE 95.7, dur MAE 30, bed MAE 538, wake MAE 658, nap bias +75.5, count bias 0
      20mo: 30 days, count 100% (30/30), nap MAE 33.2, dur MAE 24, bed MAE 140.7, wake MAE 204.8, nap bias +23.4, count bias 0
      21mo: 30 days, count 100% (30/30), nap MAE 27.5, dur MAE 24.7, bed MAE 480.8, wake MAE 563.6, nap bias +12.5, count bias 0
      22mo: 27 days, count 100% (27/27), nap MAE 22.5, dur MAE 25.4, bed MAE 152.7, wake MAE 149.1, nap bias +9.5, count bias 0
      23mo: 31 days, count 100% (31/31), nap MAE 56.3, dur MAE 20, bed MAE 42.7, wake MAE 31.7, nap bias +42.3, count bias 0
      24mo: 18 days, count 100% (18/18), nap MAE 139.6, dur MAE 18.8, bed MAE 45, wake MAE 373.8, nap bias +124.4, count bias 0
      25mo: 13 days, count 92% (12/13), nap MAE 214.5, dur MAE 25.1, bed MAE 79.2, wake MAE 2998.3, nap bias +171.1, count bias -0.08
      26mo: 20 days, count 100% (20/20), nap MAE 299.7, dur MAE 22.2, bed MAE 48.5, wake MAE 83.5, nap bias +297.3, count bias 0
      27mo: 28 days, count 100% (28/28), nap MAE 217.8, dur MAE 23.8, bed MAE 26.3, wake MAE 207.3, nap bias +203.5, count bias 0
      28mo: 10 days, count 100% (10/10), nap MAE 252.6, dur MAE 33, bed MAE 0, wake MAE 0, nap bias +241, count bias 0
      29mo: 5 days, count 100% (5/5), nap MAE 281.8, dur MAE 22.4, bed MAE 1252.5, wake MAE 259321, nap bias +281.8, count bias 0
      35mo: 1 days, count 100% (1/1), nap MAE 300, dur MAE 188, bed MAE 0, wake MAE 0, nap bias +300, count bias 0"
    `);
  });

  it("baby_2 per-month", () => {
    const buckets = bucketResultsByAge(results[2].result, results[2].birthdate);
    const lines = buckets.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "0mo: 16 days, count 19% (3/16), nap MAE 118.6, dur MAE 43.3, bed MAE 771.8, wake MAE 750.8, nap bias +65.1, count bias -2.19
      1mo: 14 days, count 14% (2/14), nap MAE 102.2, dur MAE 37.9, bed MAE 1131.6, wake MAE 1937.5, nap bias +102.2, count bias +0.93
      2mo: 10 days, count 20% (2/10), nap MAE 56, dur MAE 27.2, bed MAE 117.7, wake MAE 2575.6, nap bias +45.5, count bias -0.3
      3mo: 23 days, count 48% (11/23), nap MAE 73.2, dur MAE 22.8, bed MAE 135.9, wake MAE 282.8, nap bias +50.6, count bias -0.7
      4mo: 31 days, count 45% (14/31), nap MAE 69.8, dur MAE 39.4, bed MAE 40.8, wake MAE 73, nap bias +6.7, count bias -0.1
      5mo: 27 days, count 37% (10/27), nap MAE 94.6, dur MAE 32, bed MAE 117.8, wake MAE 121.4, nap bias +60.6, count bias +0.41
      6mo: 23 days, count 43% (10/23), nap MAE 108.9, dur MAE 24.4, bed MAE 0, wake MAE 0, nap bias +101.7, count bias -0.39
      7mo: 3 days, count 100% (3/3), nap MAE 151.7, dur MAE 54, bed MAE 0, wake MAE 0, nap bias +151.7, count bias 0"
    `);
  });

  // ── Cross-baby regression guards (nap timing only — bedtime timezone-broken) ──
  // Ceiling is generous because Kaggle babies include noisy newborn data
  // where our algorithm isn't expected to work (no circadian rhythm yet).
  // baby_1 at 8-17mo: 25-68 min MAE — that's the real signal.

  it("nap start MAE ≤ 220 min for all babies", () => {
    for (const r of results) {
      expect(r.result.napStartMAE).toBeLessThan(220);
    }
  });

  it("halldis and baby_1 outperform noisy babies", () => {
    expect(results[0].result.napStartMAE).toBeLessThan(65); // halldis
    expect(results[1].result.napStartMAE).toBeLessThan(200); // baby_1 (dragged by newborn data)
  });
});
