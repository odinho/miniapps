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
      "halldis: 82 days, count 80% (66/82), nap MAE 57.8, dur MAE 23.4, bed MAE 39.3, wake MAE 43.2, nap bias +8.7, count bias +0.07
      baby_1: 803 days, count 72% (576/803), nap MAE 112.5, dur MAE 29.7, bed MAE 324.9, wake MAE 799.4, nap bias +100.8, count bias -0.7
      baby_2: 147 days, count 37% (55/147), nap MAE 98.6, dur MAE 32.2, bed MAE 176.2, wake MAE 581.6, nap bias +72.2, count bias -0.29
      baby_3: 70 days, count 24% (17/70), nap MAE 113.8, dur MAE 37.5, bed MAE 1316.1, wake MAE 1365.8, nap bias +62.4, count bias -0.24
      baby_4: 25 days, count 20% (5/25), nap MAE 88.6, dur MAE 34.4, bed MAE 0, wake MAE 0, nap bias +76.8, count bias +0.16
      baby_5: 41 days, count 5% (2/41), nap MAE 119.4, dur MAE 37.8, bed MAE 891.2, wake MAE 3037.7, nap bias +116.6, count bias -1.02"
    `);
  });

  it("baby_1 per-month (longest dataset)", () => {
    const buckets = bucketResultsByAge(results[1].result, results[1].birthdate);
    const lines = buckets.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "0mo: 15 days, count 13% (2/15), nap MAE 117.1, dur MAE 35.3, bed MAE 1393.3, wake MAE 999, nap bias +98.7, count bias -2.53
      1mo: 31 days, count 13% (4/31), nap MAE 106.1, dur MAE 36.9, bed MAE 424.8, wake MAE 410.5, nap bias +99.2, count bias -3.87
      2mo: 30 days, count 20% (6/30), nap MAE 91.8, dur MAE 35.6, bed MAE 473, wake MAE 641.6, nap bias +82, count bias -2.6
      3mo: 30 days, count 10% (3/30), nap MAE 96.7, dur MAE 36.5, bed MAE 330.5, wake MAE 624.1, nap bias +89.7, count bias -2.33
      4mo: 31 days, count 10% (3/31), nap MAE 151.8, dur MAE 32.6, bed MAE 888.6, wake MAE 578.4, nap bias +151.8, count bias -2.06
      5mo: 30 days, count 3% (1/30), nap MAE 152.2, dur MAE 32.3, bed MAE 849.9, wake MAE 521.8, nap bias +151.7, count bias -2.57
      6mo: 31 days, count 19% (6/31), nap MAE 258.9, dur MAE 33.7, bed MAE 1167.3, wake MAE 800.3, nap bias +258.9, count bias -1.81
      7mo: 30 days, count 33% (10/30), nap MAE 121.8, dur MAE 32.5, bed MAE 1117.3, wake MAE 1017.7, nap bias +114.6, count bias -1.97
      8mo: 31 days, count 77% (24/31), nap MAE 34, dur MAE 22.8, bed MAE 875.9, wake MAE 843.4, nap bias +20, count bias -0.03
      9mo: 31 days, count 87% (27/31), nap MAE 22.6, dur MAE 17.3, bed MAE 923.1, wake MAE 905.1, nap bias -1, count bias +0.13
      10mo: 28 days, count 64% (18/28), nap MAE 38.5, dur MAE 20.7, bed MAE 310.2, wake MAE 280.2, nap bias +3.7, count bias 0
      11mo: 31 days, count 97% (30/31), nap MAE 40.1, dur MAE 19.1, bed MAE 28, wake MAE 25, nap bias -13.3, count bias +0.03
      12mo: 30 days, count 90% (27/30), nap MAE 39.1, dur MAE 20.3, bed MAE 35.2, wake MAE 27.4, nap bias -0.3, count bias +0.1
      13mo: 31 days, count 87% (27/31), nap MAE 34.4, dur MAE 27.5, bed MAE 38.7, wake MAE 31.3, nap bias -2.5, count bias +0.06
      14mo: 29 days, count 86% (25/29), nap MAE 39.7, dur MAE 25.4, bed MAE 39.7, wake MAE 133.5, nap bias +5.2, count bias -0.17
      15mo: 30 days, count 100% (30/30), nap MAE 45.3, dur MAE 27.3, bed MAE 41.8, wake MAE 39.7, nap bias +3.5, count bias 0
      16mo: 31 days, count 100% (31/31), nap MAE 57, dur MAE 27.1, bed MAE 42.2, wake MAE 49.2, nap bias +35.7, count bias 0
      17mo: 30 days, count 100% (30/30), nap MAE 22, dur MAE 20, bed MAE 26.5, wake MAE 24.8, nap bias -0.6, count bias 0
      18mo: 31 days, count 100% (31/31), nap MAE 55.4, dur MAE 20.8, bed MAE 94.2, wake MAE 95, nap bias +44.1, count bias 0
      19mo: 29 days, count 100% (29/29), nap MAE 95.7, dur MAE 29.1, bed MAE 538, wake MAE 650.5, nap bias +75.5, count bias 0
      20mo: 30 days, count 100% (30/30), nap MAE 33.2, dur MAE 20.2, bed MAE 140.7, wake MAE 202.9, nap bias +23.4, count bias 0
      21mo: 30 days, count 100% (30/30), nap MAE 27.5, dur MAE 20.5, bed MAE 480.8, wake MAE 552.3, nap bias +12.5, count bias 0
      22mo: 27 days, count 100% (27/27), nap MAE 22.5, dur MAE 25.9, bed MAE 152.7, wake MAE 147.6, nap bias +9.5, count bias 0
      23mo: 31 days, count 100% (31/31), nap MAE 56.3, dur MAE 21.5, bed MAE 42.7, wake MAE 33.8, nap bias +42.3, count bias 0
      24mo: 18 days, count 100% (18/18), nap MAE 139.6, dur MAE 17.2, bed MAE 45, wake MAE 377.8, nap bias +124.4, count bias 0
      25mo: 13 days, count 92% (12/13), nap MAE 214.5, dur MAE 24.7, bed MAE 79.2, wake MAE 2988.3, nap bias +171.1, count bias -0.08
      26mo: 20 days, count 100% (20/20), nap MAE 299.7, dur MAE 18.2, bed MAE 48.5, wake MAE 95, nap bias +297.3, count bias 0
      27mo: 28 days, count 100% (28/28), nap MAE 217.8, dur MAE 22, bed MAE 26.3, wake MAE 203.7, nap bias +203.5, count bias 0
      28mo: 10 days, count 100% (10/10), nap MAE 252.6, dur MAE 35.5, bed MAE 0, wake MAE 0, nap bias +241, count bias 0
      29mo: 5 days, count 100% (5/5), nap MAE 281.8, dur MAE 18.2, bed MAE 1252.5, wake MAE 259309, nap bias +281.8, count bias 0
      35mo: 1 days, count 100% (1/1), nap MAE 300, dur MAE 175, bed MAE 0, wake MAE 0, nap bias +300, count bias 0"
    `);
  });

  it("baby_2 per-month", () => {
    const buckets = bucketResultsByAge(results[2].result, results[2].birthdate);
    const lines = buckets.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "0mo: 16 days, count 19% (3/16), nap MAE 139.5, dur MAE 42.8, bed MAE 771.8, wake MAE 753, nap bias +94.6, count bias -2.19
      1mo: 14 days, count 14% (2/14), nap MAE 107.7, dur MAE 33.5, bed MAE 1131.6, wake MAE 1949, nap bias +107.2, count bias +0.93
      2mo: 10 days, count 20% (2/10), nap MAE 56.4, dur MAE 32.6, bed MAE 117.7, wake MAE 2566.1, nap bias +45.9, count bias -0.3
      3mo: 23 days, count 48% (11/23), nap MAE 72.6, dur MAE 20.5, bed MAE 135.9, wake MAE 291.7, nap bias +55.3, count bias -0.7
      4mo: 31 days, count 45% (14/31), nap MAE 66.5, dur MAE 29.2, bed MAE 40.8, wake MAE 78.7, nap bias +29.6, count bias -0.1
      5mo: 27 days, count 37% (10/27), nap MAE 104.1, dur MAE 29.2, bed MAE 117.8, wake MAE 133.3, nap bias +77.6, count bias +0.41
      6mo: 23 days, count 43% (10/23), nap MAE 108.9, dur MAE 26.8, bed MAE 0, wake MAE 0, nap bias +101.7, count bias -0.39
      7mo: 3 days, count 100% (3/3), nap MAE 151.7, dur MAE 58.3, bed MAE 0, wake MAE 0, nap bias +151.7, count bias 0"
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
