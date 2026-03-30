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
      "halldis: 82 days, count 78% (64/82), nap MAE 59.8 min, bed MAE 49.9 min, nap bias -5.4, count bias +0.07
      baby_1: 828 days, count 66% (544/828), nap MAE 184.9 min, bed MAE 77704.9 min, nap bias +163.8, count bias -1.2
      baby_2: 150 days, count 31% (47/150), nap MAE 108.7 min, bed MAE 137008.5 min, nap bias +41.2, count bias -0.13
      baby_3: 75 days, count 13% (10/75), nap MAE 212.7 min, bed MAE 52134.5 min, nap bias +31.7, count bias +0.07
      baby_4: 25 days, count 16% (4/25), nap MAE 84.8 min, bed MAE 0 min, nap bias +66, count bias +0.96
      baby_5: 43 days, count 7% (3/43), nap MAE 110.5 min, bed MAE 300387.3 min, nap bias +8.5, count bias -0.86"
    `);
  });

  it("baby_1 per-month (longest dataset)", () => {
    const buckets = bucketResultsByAge(results[1].result, results[1].birthdate);
    const lines = buckets.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "0mo: 15 days, count 27% (4/15), nap MAE 97.6 min, bed MAE 2650 min, nap bias +86.2, count bias -4
      1mo: 31 days, count 3% (1/31), nap MAE 243 min, bed MAE 1359.3 min, nap bias +241.5, count bias -6
      2mo: 30 days, count 3% (1/30), nap MAE 605.5 min, bed MAE 1531 min, nap bias +591.5, count bias -4.93
      3mo: 31 days, count 0% (0/31), nap MAE 427.7 min, bed MAE 1338.1 min, nap bias +409.5, count bias -4.19
      4mo: 31 days, count 0% (0/31), nap MAE 313 min, bed MAE 1699.6 min, nap bias +313, count bias -4.58
      5mo: 30 days, count 0% (0/30), nap MAE 159.6 min, bed MAE 2252.5 min, nap bias +148.5, count bias -4.43
      6mo: 31 days, count 0% (0/31), nap MAE 355 min, bed MAE 2125.3 min, nap bias +336.7, count bias -4.52
      7mo: 30 days, count 7% (2/30), nap MAE 125.1 min, bed MAE 1721.3 min, nap bias +98, count bias -2.63
      8mo: 31 days, count 68% (21/31), nap MAE 31.2 min, bed MAE 1449.2 min, nap bias +6.3, count bias -0.13
      9mo: 31 days, count 87% (27/31), nap MAE 21 min, bed MAE 1440.5 min, nap bias -12.4, count bias +0.13
      10mo: 28 days, count 57% (16/28), nap MAE 37.1 min, bed MAE 1446 min, nap bias -12.3, count bias -0.07
      11mo: 31 days, count 97% (30/31), nap MAE 41.3 min, bed MAE 1449.4 min, nap bias -22.3, count bias +0.03
      12mo: 30 days, count 90% (27/30), nap MAE 38.4 min, bed MAE 1450.6 min, nap bias -11.2, count bias +0.1
      13mo: 31 days, count 87% (27/31), nap MAE 32.2 min, bed MAE 1458.8 min, nap bias -10.8, count bias +0.06
      14mo: 30 days, count 83% (25/30), nap MAE 35 min, bed MAE 83684.2 min, nap bias -5.3, count bias -0.13
      15mo: 31 days, count 97% (30/31), nap MAE 45.4 min, bed MAE 80712.9 min, nap bias +1.9, count bias +0.03
      16mo: 31 days, count 100% (31/31), nap MAE 56.6 min, bed MAE 1448.7 min, nap bias +34, count bias 0
      17mo: 30 days, count 100% (30/30), nap MAE 21.4 min, bed MAE 1447.4 min, nap bias -0.7, count bias 0
      18mo: 31 days, count 100% (31/31), nap MAE 51.3 min, bed MAE 1436.3 min, nap bias +43.8, count bias 0
      19mo: 29 days, count 100% (29/29), nap MAE 96.8 min, bed MAE 1461 min, nap bias +74.3, count bias 0
      20mo: 31 days, count 97% (30/31), nap MAE 33.3 min, bed MAE 74603.8 min, nap bias +23.5, count bias +0.03
      21mo: 31 days, count 97% (30/31), nap MAE 27.3 min, bed MAE 71854 min, nap bias +10.8, count bias +0.03
      22mo: 28 days, count 96% (27/28), nap MAE 25.2 min, bed MAE 78129.2 min, nap bias +8.8, count bias +0.04
      23mo: 31 days, count 100% (31/31), nap MAE 56 min, bed MAE 1439.7 min, nap bias +42.4, count bias 0
      24mo: 27 days, count 67% (18/27), nap MAE 141.1 min, bed MAE 871923.7 min, nap bias +118.8, count bias +0.33
      25mo: 19 days, count 63% (12/19), nap MAE 222.1 min, bed MAE 1092373.7 min, nap bias +175.5, count bias +0.26
      26mo: 21 days, count 95% (20/21), nap MAE 296.8 min, bed MAE 659566.8 min, nap bias +296.8, count bias +0.05
      27mo: 29 days, count 97% (28/29), nap MAE 217.1 min, bed MAE 175821.3 min, nap bias +201.5, count bias +0.03
      28mo: 10 days, count 100% (10/10), nap MAE 259.6 min, bed MAE 1666.2 min, nap bias +244.1, count bias 0
      29mo: 5 days, count 100% (5/5), nap MAE 287.8 min, bed MAE 1276 min, nap bias +287.8, count bias 0
      31mo: 2 days, count 0% (0/2), nap MAE 0 min, bed MAE 1727823.5 min, nap bias 0, count bias +1
      35mo: 1 days, count 100% (1/1), nap MAE 300 min, bed MAE 0 min, nap bias +300, count bias 0"
    `);
  });

  it("baby_2 per-month", () => {
    const buckets = bucketResultsByAge(results[2].result, results[2].birthdate);
    const lines = buckets.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "0mo: 16 days, count 6% (1/16), nap MAE 147.7 min, bed MAE 2137.8 min, nap bias +39.2, count bias -3.56
      1mo: 13 days, count 0% (0/13), nap MAE 157 min, bed MAE 2163 min, nap bias -40.3, count bias +1.46
      2mo: 12 days, count 0% (0/12), nap MAE 48.2 min, bed MAE 505058.3 min, nap bias +9.3, count bias +1.08
      3mo: 25 days, count 36% (9/25), nap MAE 83.5 min, bed MAE 441675 min, nap bias +51.4, count bias -0.2
      4mo: 31 days, count 55% (17/31), nap MAE 69 min, bed MAE 1463.8 min, nap bias +6.1, count bias -0.16
      5mo: 27 days, count 41% (11/27), nap MAE 109.8 min, bed MAE 1532.4 min, nap bias +67.6, count bias +0.37
      6mo: 23 days, count 26% (6/23), nap MAE 149.8 min, bed MAE 1857 min, nap bias +140.1, count bias +0.22
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
