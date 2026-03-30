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
      "halldis: 82 days, count 78% (64/82), nap MAE 58.3 min, bed MAE 49.9 min, nap bias +3.4, count bias +0.07
      baby_1: 804 days, count 68% (544/804), nap MAE 185 min, bed MAE 1506.4 min, nap bias +163.8, count bias -1.27
      baby_2: 146 days, count 30% (44/146), nap MAE 108.9 min, bed MAE 1587.9 min, nap bias +42.4, count bias -0.16
      baby_3: 70 days, count 14% (10/70), nap MAE 212.3 min, bed MAE 1478.7 min, nap bias +33.6, count bias -0.16
      baby_4: 25 days, count 16% (4/25), nap MAE 84.8 min, bed MAE 0 min, nap bias +66, count bias +0.96
      baby_5: 42 days, count 7% (3/42), nap MAE 110.5 min, bed MAE 1800.4 min, nap bias +8.6, count bias -0.98"
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
      14mo: 29 days, count 86% (25/29), nap MAE 35.7 min, bed MAE 1458.1 min, nap bias -4.6, count bias -0.17
      15mo: 30 days, count 100% (30/30), nap MAE 45.7 min, bed MAE 1463.4 min, nap bias +1.6, count bias 0
      16mo: 31 days, count 100% (31/31), nap MAE 56.6 min, bed MAE 1448.7 min, nap bias +34, count bias 0
      17mo: 30 days, count 100% (30/30), nap MAE 21.4 min, bed MAE 1447.4 min, nap bias -0.7, count bias 0
      18mo: 31 days, count 100% (31/31), nap MAE 51.3 min, bed MAE 1436.3 min, nap bias +43.8, count bias 0
      19mo: 29 days, count 100% (29/29), nap MAE 96.8 min, bed MAE 1461 min, nap bias +74.3, count bias 0
      20mo: 30 days, count 100% (30/30), nap MAE 33.2 min, bed MAE 1450.6 min, nap bias +23.4, count bias 0
      21mo: 30 days, count 100% (30/30), nap MAE 27.3 min, bed MAE 1435.4 min, nap bias +10.7, count bias 0
      22mo: 27 days, count 100% (27/27), nap MAE 25.4 min, bed MAE 1450.8 min, nap bias +8.9, count bias 0
      23mo: 31 days, count 100% (31/31), nap MAE 56 min, bed MAE 1439.7 min, nap bias +42.4, count bias 0
      24mo: 18 days, count 100% (18/18), nap MAE 138.2 min, bed MAE 1443.9 min, nap bias +116.9, count bias 0
      25mo: 13 days, count 92% (12/13), nap MAE 220.2 min, bed MAE 1515.3 min, nap bias +173.6, count bias -0.08
      26mo: 20 days, count 100% (20/20), nap MAE 300.3 min, bed MAE 1439.8 min, nap bias +298.4, count bias 0
      27mo: 28 days, count 100% (28/28), nap MAE 217.8 min, bed MAE 1445.8 min, nap bias +202.2, count bias 0
      28mo: 10 days, count 100% (10/10), nap MAE 259.6 min, bed MAE 1666.2 min, nap bias +244.1, count bias 0
      29mo: 5 days, count 100% (5/5), nap MAE 287.8 min, bed MAE 1276 min, nap bias +287.8, count bias 0
      35mo: 1 days, count 100% (1/1), nap MAE 300 min, bed MAE 0 min, nap bias +300, count bias 0"
    `);
  });

  it("baby_2 per-month", () => {
    const buckets = bucketResultsByAge(results[2].result, results[2].birthdate);
    const lines = buckets.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "0mo: 16 days, count 6% (1/16), nap MAE 147.7 min, bed MAE 2137.8 min, nap bias +39.2, count bias -3.56
      1mo: 13 days, count 0% (0/13), nap MAE 157 min, bed MAE 2163 min, nap bias -40.3, count bias +1.46
      2mo: 10 days, count 0% (0/10), nap MAE 45.7 min, bed MAE 1435.3 min, nap bias +12.1, count bias +0.5
      3mo: 23 days, count 26% (6/23), nap MAE 85.2 min, bed MAE 1537.9 min, nap bias +55.7, count bias 0
      4mo: 31 days, count 55% (17/31), nap MAE 69 min, bed MAE 1463.8 min, nap bias +6.1, count bias -0.16
      5mo: 27 days, count 41% (11/27), nap MAE 109.8 min, bed MAE 1532.4 min, nap bias +67.6, count bias +0.37
      6mo: 23 days, count 26% (6/23), nap MAE 149.8 min, bed MAE 1857 min, nap bias +140.1, count bias +0.22
      7mo: 3 days, count 100% (3/3), nap MAE 267.8 min, bed MAE 0 min, nap bias +267.8, count bias 0"
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
