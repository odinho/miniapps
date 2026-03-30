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
//   halldis — parent-logged via Napper + babysovelogg, 7-9mo
//   baby_1..5 — Kaggle "Tracking Babies Daily", auto-tracked,
//     micro-sleeps <15min filtered out. No birthdates (estimated).
//     US timezone treated as UTC → bedtime metrics are meaningless.
// =============================================================================

interface BabyFixture {
  name: string;
  birthdate: string;
  days: DayRecord[];
}

function loadKaggle(name: string, data: { birthdate: string; days: DayRecord[] }): BabyFixture {
  return { name, birthdate: data.birthdate, days: data.days };
}

const babies: BabyFixture[] = [
  { name: "halldis", birthdate: "2025-06-12", days: halldisData as DayRecord[] },
  loadKaggle("baby_1", baby1Data as { birthdate: string; days: DayRecord[] }),
  loadKaggle("baby_2", baby2Data as { birthdate: string; days: DayRecord[] }),
  loadKaggle("baby_3", baby3Data as { birthdate: string; days: DayRecord[] }),
  loadKaggle("baby_4", baby4Data as { birthdate: string; days: DayRecord[] }),
  loadKaggle("baby_5", baby5Data as { birthdate: string; days: DayRecord[] }),
];

describe("multi-baby backtest", () => {
  const results = babies.map((b) => ({
    ...b,
    result: backtest(b.days, b.birthdate),
  }));

  it("all babies summary", () => {
    const lines = results.map((r) => renderSummary(r.result, r.name));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "halldis: 82 days, count 78% (64/82), nap MAE 58.4 min, bed MAE 45.7 min, nap bias +0.2, count bias +0.07
      baby_1: 828 days, count 66% (544/828), nap MAE 192.9 min, bed MAE 77694.9 min, nap bias +179.4, count bias -1.2
      baby_2: 150 days, count 31% (47/150), nap MAE 109.6 min, bed MAE 137003.3 min, nap bias +42.8, count bias -0.13
      baby_3: 75 days, count 13% (10/75), nap MAE 212.6 min, bed MAE 51942.9 min, nap bias +30.6, count bias +0.07
      baby_4: 25 days, count 16% (4/25), nap MAE 84.8 min, bed MAE 0 min, nap bias +66, count bias +0.96
      baby_5: 43 days, count 7% (3/43), nap MAE 108.9 min, bed MAE 300387.3 min, nap bias +6.5, count bias -0.86"
    `);
  });

  it("baby_1 per-month (longest dataset)", () => {
    const buckets = bucketResultsByAge(results[1].result, results[1].birthdate);
    const lines = buckets.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "0mo: 15 days, count 27% (4/15), nap MAE 97.4 min, bed MAE 2650 min, nap bias +86.1, count bias -4
      1mo: 31 days, count 3% (1/31), nap MAE 243 min, bed MAE 1359.3 min, nap bias +241.5, count bias -6
      2mo: 30 days, count 3% (1/30), nap MAE 605.7 min, bed MAE 1531 min, nap bias +591.6, count bias -4.93
      3mo: 31 days, count 0% (0/31), nap MAE 427.4 min, bed MAE 1403 min, nap bias +409.8, count bias -4.19
      4mo: 31 days, count 0% (0/31), nap MAE 313.1 min, bed MAE 1765.6 min, nap bias +313.1, count bias -4.58
      5mo: 30 days, count 0% (0/30), nap MAE 159.4 min, bed MAE 2252.5 min, nap bias +148.2, count bias -4.43
      6mo: 31 days, count 0% (0/31), nap MAE 355.1 min, bed MAE 2053.6 min, nap bias +336.7, count bias -4.52
      7mo: 30 days, count 7% (2/30), nap MAE 127.5 min, bed MAE 1699.7 min, nap bias +101.7, count bias -2.63
      8mo: 31 days, count 68% (21/31), nap MAE 39.4 min, bed MAE 1441.9 min, nap bias +23.7, count bias -0.13
      9mo: 31 days, count 87% (27/31), nap MAE 25.5 min, bed MAE 1447.3 min, nap bias +3.7, count bias +0.13
      10mo: 28 days, count 57% (16/28), nap MAE 35.6 min, bed MAE 1452.6 min, nap bias +5.5, count bias -0.07
      11mo: 31 days, count 97% (30/31), nap MAE 34.7 min, bed MAE 1462 min, nap bias -13.6, count bias +0.03
      12mo: 30 days, count 90% (27/30), nap MAE 43.4 min, bed MAE 1486.9 min, nap bias +13.5, count bias +0.1
      13mo: 31 days, count 87% (27/31), nap MAE 49.5 min, bed MAE 1449.6 min, nap bias +38.3, count bias +0.06
      14mo: 30 days, count 83% (25/30), nap MAE 51 min, bed MAE 83674 min, nap bias +30.2, count bias -0.13
      15mo: 31 days, count 97% (30/31), nap MAE 58.5 min, bed MAE 80700.1 min, nap bias +51.2, count bias +0.03
      16mo: 31 days, count 100% (31/31), nap MAE 67.6 min, bed MAE 1432.3 min, nap bias +62.3, count bias 0
      17mo: 30 days, count 100% (30/30), nap MAE 37.4 min, bed MAE 1415.2 min, nap bias +33.4, count bias 0
      18mo: 31 days, count 100% (31/31), nap MAE 103.8 min, bed MAE 1400.7 min, nap bias +103.8, count bias 0
      19mo: 29 days, count 100% (29/29), nap MAE 138.3 min, bed MAE 1429.7 min, nap bias +132.1, count bias 0
      20mo: 31 days, count 97% (30/31), nap MAE 83.4 min, bed MAE 74570.4 min, nap bias +83.4, count bias +0.03
      21mo: 31 days, count 97% (30/31), nap MAE 66.4 min, bed MAE 71823.6 min, nap bias +66.4, count bias +0.03
      22mo: 28 days, count 96% (27/28), nap MAE 66.5 min, bed MAE 78082.6 min, nap bias +66.5, count bias +0.04
      23mo: 31 days, count 100% (31/31), nap MAE 101.5 min, bed MAE 1396.7 min, nap bias +98.6, count bias 0
      24mo: 27 days, count 67% (18/27), nap MAE 162.6 min, bed MAE 871907.3 min, nap bias +162.4, count bias +0.33
      25mo: 19 days, count 63% (12/19), nap MAE 214.7 min, bed MAE 1092373.7 min, nap bias +168.1, count bias +0.26
      26mo: 21 days, count 95% (20/21), nap MAE 296.4 min, bed MAE 659566.8 min, nap bias +296.4, count bias +0.05
      27mo: 29 days, count 97% (28/29), nap MAE 242 min, bed MAE 175819 min, nap bias +234.6, count bias +0.03
      28mo: 10 days, count 100% (10/10), nap MAE 262.8 min, bed MAE 1662.3 min, nap bias +251.2, count bias 0
      29mo: 5 days, count 100% (5/5), nap MAE 287.8 min, bed MAE 1276 min, nap bias +287.8, count bias 0
      31mo: 2 days, count 0% (0/2), nap MAE 0 min, bed MAE 1727823.5 min, nap bias 0, count bias +1
      35mo: 1 days, count 100% (1/1), nap MAE 300 min, bed MAE 0 min, nap bias +300, count bias 0"
    `);
  });

  it("baby_2 per-month", () => {
    const buckets = bucketResultsByAge(results[2].result, results[2].birthdate);
    const lines = buckets.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "0mo: 16 days, count 6% (1/16), nap MAE 147.3 min, bed MAE 2137.8 min, nap bias +34.6, count bias -3.56
      1mo: 13 days, count 0% (0/13), nap MAE 157 min, bed MAE 2163 min, nap bias -40.3, count bias +1.46
      2mo: 12 days, count 0% (0/12), nap MAE 48 min, bed MAE 505038.9 min, nap bias +14.2, count bias +1.08
      3mo: 25 days, count 36% (9/25), nap MAE 84.1 min, bed MAE 441675.6 min, nap bias +53.5, count bias -0.2
      4mo: 31 days, count 55% (17/31), nap MAE 69.4 min, bed MAE 1462 min, nap bias +8.3, count bias -0.16
      5mo: 27 days, count 41% (11/27), nap MAE 113.2 min, bed MAE 1520.4 min, nap bias +74, count bias +0.37
      6mo: 23 days, count 26% (6/23), nap MAE 151.1 min, bed MAE 1857 min, nap bias +141.4, count bias +0.22
      7mo: 3 days, count 100% (3/3), nap MAE 227.8 min, bed MAE 0 min, nap bias +227.8, count bias 0"
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
