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
      baby_1: 804 days, count 75% (599/804), nap MAE 237.7, dur MAE 29.8, bed MAE 181.6, wake MAE 146.9, nap bias +227.3, count bias -0.46
      baby_2: 146 days, count 40% (58/146), nap MAE 104.7, dur MAE 34.5, bed MAE 121.8, wake MAE 474.2, nap bias +59.8, count bias -0.24
      baby_3: 70 days, count 19% (13/70), nap MAE 244.2, dur MAE 34.9, bed MAE 547, wake MAE 471.1, nap bias +185.4, count bias -0.34
      baby_4: 25 days, count 20% (5/25), nap MAE 85.6, dur MAE 35, bed MAE 0, wake MAE 0, nap bias +73, count bias +0.16
      baby_5: 42 days, count 17% (7/42), nap MAE 97.5, dur MAE 32.8, bed MAE 1392.3, wake MAE 2810, nap bias +41.4, count bias -0.24"
    `);
  });

  it("baby_1 per-month (longest dataset)", () => {
    const buckets = bucketResultsByAge(results[1].result, results[1].birthdate);
    const lines = buckets.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "0mo: 15 days, count 47% (7/15), nap MAE 96.3, dur MAE 36.2, bed MAE 29.3, wake MAE 175, nap bias +88, count bias -1.6
      1mo: 31 days, count 16% (5/31), nap MAE 209.5, dur MAE 36.1, bed MAE 623.6, wake MAE 297.8, nap bias +206.5, count bias -2.97
      2mo: 30 days, count 37% (11/30), nap MAE 571.1, dur MAE 33.8, bed MAE 876.9, wake MAE 695.8, nap bias +558.9, count bias -0.63
      3mo: 31 days, count 13% (4/31), nap MAE 453.9, dur MAE 33.5, bed MAE 620.2, wake MAE 655.8, nap bias +449.2, count bias -1.94
      4mo: 31 days, count 29% (9/31), nap MAE 315.3, dur MAE 31.9, bed MAE 527.3, wake MAE 346.8, nap bias +315.2, count bias -1.58
      5mo: 30 days, count 7% (2/30), nap MAE 233.9, dur MAE 35.2, bed MAE 1171, wake MAE 434.2, nap bias +231.8, count bias -1.93
      6mo: 31 days, count 32% (10/31), nap MAE 355.9, dur MAE 34.2, bed MAE 1101.9, wake MAE 370.9, nap bias +355.8, count bias -0.81
      7mo: 30 days, count 33% (10/30), nap MAE 151.3, dur MAE 28.8, bed MAE 408.1, wake MAE 138.7, nap bias +140.7, count bias -1.43
      8mo: 31 days, count 77% (24/31), nap MAE 30.4, dur MAE 23.2, bed MAE 29.7, wake MAE 20.7, nap bias +10.5, count bias -0.03
      9mo: 31 days, count 87% (27/31), nap MAE 21.4, dur MAE 17.2, bed MAE 19, wake MAE 19.4, nap bias +0.3, count bias +0.13
      10mo: 28 days, count 64% (18/28), nap MAE 36.4, dur MAE 22.8, bed MAE 39.4, wake MAE 22.8, nap bias +9, count bias 0
      11mo: 31 days, count 97% (30/31), nap MAE 36.9, dur MAE 19.1, bed MAE 32.7, wake MAE 24.8, nap bias -12.4, count bias +0.03
      12mo: 30 days, count 90% (27/30), nap MAE 35.4, dur MAE 20.2, bed MAE 27, wake MAE 28.2, nap bias +0.1, count bias +0.1
      13mo: 31 days, count 87% (27/31), nap MAE 28.8, dur MAE 30.7, bed MAE 36.8, wake MAE 31.8, nap bias +2.1, count bias +0.06
      14mo: 29 days, count 86% (25/29), nap MAE 35.2, dur MAE 24.9, bed MAE 36.1, wake MAE 129, nap bias +8.7, count bias -0.17
      15mo: 30 days, count 100% (30/30), nap MAE 35.1, dur MAE 26.5, bed MAE 43.4, wake MAE 42.1, nap bias +7.3, count bias 0
      16mo: 31 days, count 100% (31/31), nap MAE 39.2, dur MAE 27.1, bed MAE 37.6, wake MAE 50.8, nap bias +19.6, count bias 0
      17mo: 30 days, count 100% (30/30), nap MAE 19.3, dur MAE 20, bed MAE 22.2, wake MAE 25.2, nap bias -3.2, count bias 0
      18mo: 31 days, count 100% (31/31), nap MAE 30.7, dur MAE 20.8, bed MAE 44.9, wake MAE 32.7, nap bias +17.8, count bias 0
      19mo: 29 days, count 100% (29/29), nap MAE 79.4, dur MAE 29.1, bed MAE 50.7, wake MAE 52, nap bias +53, count bias 0
      20mo: 30 days, count 100% (30/30), nap MAE 31.7, dur MAE 20.2, bed MAE 24.4, wake MAE 79.1, nap bias +21.8, count bias 0
      21mo: 30 days, count 100% (30/30), nap MAE 22.1, dur MAE 20.5, bed MAE 41.5, wake MAE 123.1, nap bias +4.1, count bias 0
      22mo: 27 days, count 100% (27/27), nap MAE 14.6, dur MAE 25.9, bed MAE 41, wake MAE 30.7, nap bias +3, count bias 0
      23mo: 31 days, count 100% (31/31), nap MAE 50.3, dur MAE 21.5, bed MAE 21.1, wake MAE 33.3, nap bias +35.1, count bias 0
      24mo: 18 days, count 100% (18/18), nap MAE 108.3, dur MAE 17.2, bed MAE 43.8, wake MAE 379, nap bias +90.6, count bias 0
      25mo: 13 days, count 92% (12/13), nap MAE 214.5, dur MAE 25.3, bed MAE 79.2, wake MAE 2985.7, nap bias +171.1, count bias -0.08
      26mo: 20 days, count 100% (20/20), nap MAE 286, dur MAE 18.1, bed MAE 48.5, wake MAE 83, nap bias +283.6, count bias 0
      27mo: 28 days, count 100% (28/28), nap MAE 185.4, dur MAE 22, bed MAE 20.4, wake MAE 206.8, nap bias +177.1, count bias 0
      28mo: 10 days, count 100% (10/10), nap MAE 257.4, dur MAE 35.5, bed MAE 0, wake MAE 0, nap bias +236.2, count bias 0
      29mo: 5 days, count 100% (5/5), nap MAE 259.5, dur MAE 18.2, bed MAE 0, wake MAE 0, nap bias +259.5, count bias 0
      35mo: 1 days, count 100% (1/1), nap MAE 330, dur MAE 175, bed MAE 0, wake MAE 0, nap bias +330, count bias 0"
    `);
  });

  it("baby_2 per-month", () => {
    const buckets = bucketResultsByAge(results[2].result, results[2].birthdate);
    const lines = buckets.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "0mo: 16 days, count 19% (3/16), nap MAE 145.2, dur MAE 42.9, bed MAE 89.5, wake MAE 116.3, nap bias +84.8, count bias -1.81
      1mo: 13 days, count 38% (5/13), nap MAE 135.9, dur MAE 36.8, bed MAE 2344, wake MAE 538, nap bias -18.6, count bias +1.08
      2mo: 10 days, count 20% (2/10), nap MAE 57.7, dur MAE 34.8, bed MAE 110.3, wake MAE 2552.4, nap bias +48.3, count bias -0.3
      3mo: 23 days, count 48% (11/23), nap MAE 73.2, dur MAE 23.6, bed MAE 129.5, wake MAE 289.2, nap bias +54.2, count bias -0.7
      4mo: 31 days, count 45% (14/31), nap MAE 74.4, dur MAE 33, bed MAE 37.2, wake MAE 76.1, nap bias +34.5, count bias -0.1
      5mo: 27 days, count 37% (10/27), nap MAE 104.4, dur MAE 31.9, bed MAE 102.9, wake MAE 137, nap bias +81.4, count bias +0.41
      6mo: 23 days, count 43% (10/23), nap MAE 112.6, dur MAE 26.5, bed MAE 0, wake MAE 0, nap bias +105.3, count bias -0.39
      7mo: 3 days, count 100% (3/3), nap MAE 151.7, dur MAE 61.3, bed MAE 0, wake MAE 0, nap bias +151.7, count bias 0"
    `);
  });

  // ── Cross-baby regression guards ──
  // Ceiling is generous because Kaggle babies include noisy newborn data
  // where our algorithm isn't expected to work (no circadian rhythm yet).
  // baby_1 at 8-17mo: 18-66 min nap MAE — that's the real signal.

  it("nap start MAE ≤ 250 min for all babies", () => {
    for (const r of results) {
      expect(r.result.napStartMAE).toBeLessThan(250);
    }
  });

  it("halldis and baby_1 outperform noisy babies", () => {
    expect(results[0].result.napStartMAE).toBeLessThan(50); // halldis
    expect(results[1].result.napStartMAE).toBeLessThan(240); // baby_1 (dragged by newborn data)
  });
});
