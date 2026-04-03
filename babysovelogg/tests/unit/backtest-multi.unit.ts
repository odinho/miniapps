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
      "halldis: 86 days, count 81% (70/86), nap MAE 44.5, dur MAE 23.1, bed MAE 22.6, wake MAE 25.6, nap bias -3, count bias +0.07
      baby_1: 803 days, count 72% (576/803), nap MAE 111.4, dur MAE 30.4, bed MAE 316.9, wake MAE 799.7, nap bias +99.8, count bias -0.7
      baby_2: 147 days, count 37% (55/147), nap MAE 100.9, dur MAE 34.4, bed MAE 170.4, wake MAE 572.9, nap bias +73.9, count bias -0.29
      baby_3: 70 days, count 24% (17/70), nap MAE 111.8, dur MAE 38.7, bed MAE 1320.5, wake MAE 1350.5, nap bias +60.6, count bias -0.24
      baby_4: 25 days, count 20% (5/25), nap MAE 85.6, dur MAE 35, bed MAE 0, wake MAE 0, nap bias +73, count bias +0.16
      baby_5: 41 days, count 5% (2/41), nap MAE 120.3, dur MAE 39.6, bed MAE 891.2, wake MAE 3006.6, nap bias +117.8, count bias -1.02"
    `);
  });

  it("baby_1 per-month (longest dataset)", () => {
    const buckets = bucketResultsByAge(results[1].result, results[1].birthdate);
    const lines = buckets.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "0mo: 15 days, count 13% (2/15), nap MAE 117.2, dur MAE 37, bed MAE 1393.3, wake MAE 999, nap bias +98.1, count bias -2.53
      1mo: 31 days, count 13% (4/31), nap MAE 108.8, dur MAE 37, bed MAE 424.8, wake MAE 431.9, nap bias +101.8, count bias -3.87
      2mo: 30 days, count 20% (6/30), nap MAE 93.1, dur MAE 35.3, bed MAE 477.6, wake MAE 637.2, nap bias +81.3, count bias -2.6
      3mo: 30 days, count 10% (3/30), nap MAE 93.1, dur MAE 38.2, bed MAE 328.6, wake MAE 626.7, nap bias +85.1, count bias -2.33
      4mo: 31 days, count 10% (3/31), nap MAE 155.3, dur MAE 33.3, bed MAE 887, wake MAE 577.2, nap bias +155.3, count bias -2.06
      5mo: 30 days, count 3% (1/30), nap MAE 154.5, dur MAE 32.8, bed MAE 830.5, wake MAE 518.1, nap bias +154, count bias -2.57
      6mo: 31 days, count 19% (6/31), nap MAE 260.6, dur MAE 35.6, bed MAE 1157.4, wake MAE 799.2, nap bias +260.6, count bias -1.81
      7mo: 30 days, count 33% (10/30), nap MAE 126.7, dur MAE 35.2, bed MAE 1112.8, wake MAE 1011.4, nap bias +118.9, count bias -1.97
      8mo: 31 days, count 77% (24/31), nap MAE 29.9, dur MAE 23.5, bed MAE 848.9, wake MAE 844.3, nap bias +10.2, count bias -0.03
      9mo: 31 days, count 87% (27/31), nap MAE 21.4, dur MAE 17.2, bed MAE 906.9, wake MAE 906.9, nap bias 0, count bias +0.13
      10mo: 28 days, count 64% (18/28), nap MAE 36.4, dur MAE 22.8, bed MAE 293.5, wake MAE 280.8, nap bias +8.6, count bias 0
      11mo: 31 days, count 97% (30/31), nap MAE 36.9, dur MAE 19.1, bed MAE 31.7, wake MAE 24.9, nap bias -13, count bias +0.03
      12mo: 30 days, count 90% (27/30), nap MAE 35.6, dur MAE 20.2, bed MAE 25.9, wake MAE 28.4, nap bias +0.4, count bias +0.1
      13mo: 31 days, count 87% (27/31), nap MAE 28.8, dur MAE 30.7, bed MAE 36.8, wake MAE 31.8, nap bias +2.1, count bias +0.06
      14mo: 29 days, count 86% (25/29), nap MAE 35.2, dur MAE 24.9, bed MAE 32.4, wake MAE 134, nap bias +8.6, count bias -0.17
      15mo: 30 days, count 100% (30/30), nap MAE 35, dur MAE 26.5, bed MAE 33.2, wake MAE 42.3, nap bias +7.7, count bias 0
      16mo: 31 days, count 100% (31/31), nap MAE 39.3, dur MAE 27.1, bed MAE 34.8, wake MAE 50.2, nap bias +20.1, count bias 0
      17mo: 30 days, count 100% (30/30), nap MAE 19.3, dur MAE 20, bed MAE 22.2, wake MAE 25.2, nap bias -3.2, count bias 0
      18mo: 31 days, count 100% (31/31), nap MAE 30.7, dur MAE 20.8, bed MAE 88.1, wake MAE 95.5, nap bias +17.8, count bias 0
      19mo: 29 days, count 100% (29/29), nap MAE 77.5, dur MAE 29.1, bed MAE 530.8, wake MAE 653.8, nap bias +53.5, count bias 0
      20mo: 30 days, count 100% (30/30), nap MAE 32, dur MAE 20.2, bed MAE 135.8, wake MAE 201.6, nap bias +22.2, count bias 0
      21mo: 30 days, count 100% (30/30), nap MAE 22, dur MAE 20.5, bed MAE 473.6, wake MAE 550.5, nap bias +4.6, count bias 0
      22mo: 27 days, count 100% (27/27), nap MAE 14.5, dur MAE 25.9, bed MAE 142.4, wake MAE 147.8, nap bias +3.1, count bias 0
      23mo: 31 days, count 100% (31/31), nap MAE 50.3, dur MAE 21.5, bed MAE 20.2, wake MAE 34.1, nap bias +34.9, count bias 0
      24mo: 18 days, count 100% (18/18), nap MAE 108.3, dur MAE 17.2, bed MAE 43.8, wake MAE 379, nap bias +90.6, count bias 0
      25mo: 13 days, count 92% (12/13), nap MAE 214.5, dur MAE 25.3, bed MAE 79.2, wake MAE 2985.7, nap bias +171.1, count bias -0.08
      26mo: 20 days, count 100% (20/20), nap MAE 286, dur MAE 18.1, bed MAE 48.5, wake MAE 83, nap bias +283.6, count bias 0
      27mo: 28 days, count 100% (28/28), nap MAE 185.4, dur MAE 22, bed MAE 20.4, wake MAE 206.8, nap bias +177.1, count bias 0
      28mo: 10 days, count 100% (10/10), nap MAE 257.4, dur MAE 35.5, bed MAE 0, wake MAE 0, nap bias +236.2, count bias 0
      29mo: 5 days, count 100% (5/5), nap MAE 259.5, dur MAE 18.2, bed MAE 1252.5, wake MAE 259328, nap bias +259.5, count bias 0
      35mo: 1 days, count 100% (1/1), nap MAE 300, dur MAE 175, bed MAE 0, wake MAE 0, nap bias +300, count bias 0"
    `);
  });

  it("baby_2 per-month", () => {
    const buckets = bucketResultsByAge(results[2].result, results[2].birthdate);
    const lines = buckets.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "0mo: 16 days, count 19% (3/16), nap MAE 139.2, dur MAE 43, bed MAE 771.8, wake MAE 672.5, nap bias +93.3, count bias -2.19
      1mo: 14 days, count 14% (2/14), nap MAE 109.4, dur MAE 36, bed MAE 1131.6, wake MAE 1957.8, nap bias +108.1, count bias +0.93
      2mo: 10 days, count 20% (2/10), nap MAE 57.7, dur MAE 34.6, bed MAE 110.3, wake MAE 2553.3, nap bias +48.3, count bias -0.3
      3mo: 23 days, count 48% (11/23), nap MAE 73.2, dur MAE 23.6, bed MAE 129.5, wake MAE 289.2, nap bias +54.2, count bias -0.7
      4mo: 31 days, count 45% (14/31), nap MAE 74.4, dur MAE 33, bed MAE 37.2, wake MAE 76.1, nap bias +34.5, count bias -0.1
      5mo: 27 days, count 37% (10/27), nap MAE 104.4, dur MAE 31.9, bed MAE 102.9, wake MAE 137, nap bias +81.4, count bias +0.41
      6mo: 23 days, count 43% (10/23), nap MAE 112.6, dur MAE 26.5, bed MAE 0, wake MAE 0, nap bias +105.3, count bias -0.39
      7mo: 3 days, count 100% (3/3), nap MAE 151.7, dur MAE 61.3, bed MAE 0, wake MAE 0, nap bias +151.7, count bias 0"
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
    expect(results[0].result.napStartMAE).toBeLessThan(50); // halldis
    expect(results[1].result.napStartMAE).toBeLessThan(200); // baby_1 (dragged by newborn data)
  });
});
