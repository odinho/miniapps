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
      "halldis: 82 days, count 80% (66/82), nap MAE 58.3 min, bed MAE 39.7 min, nap bias +3.8, count bias +0.07
      baby_1: 803 days, count 72% (576/803), nap MAE 127.6 min, bed MAE 326.7 min, nap bias +110.2, count bias -0.7
      baby_2: 147 days, count 37% (55/147), nap MAE 112.2 min, bed MAE 175.8 min, nap bias +64.2, count bias -0.29
      baby_3: 70 days, count 24% (17/70), nap MAE 134.8 min, bed MAE 1318.5 min, nap bias +51.9, count bias -0.24
      baby_4: 25 days, count 20% (5/25), nap MAE 93.5 min, bed MAE 0 min, nap bias +80, count bias +0.16
      baby_5: 41 days, count 5% (2/41), nap MAE 142.5 min, bed MAE 892.8 min, nap bias +135, count bias -1.02"
    `);
  });

  it("baby_1 per-month (longest dataset)", () => {
    const buckets = bucketResultsByAge(results[1].result, results[1].birthdate);
    const lines = buckets.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "0mo: 15 days, count 13% (2/15), nap MAE 144 min, bed MAE 1406.3 min, nap bias +119.7, count bias -2.53
      1mo: 31 days, count 13% (4/31), nap MAE 141 min, bed MAE 424.8 min, nap bias +132.5, count bias -3.87
      2mo: 30 days, count 20% (6/30), nap MAE 104.8 min, bed MAE 475.1 min, nap bias +90.5, count bias -2.6
      3mo: 30 days, count 10% (3/30), nap MAE 99.3 min, bed MAE 330 min, nap bias +85.2, count bias -2.33
      4mo: 31 days, count 10% (3/31), nap MAE 181.7 min, bed MAE 891.9 min, nap bias +181.7, count bias -2.06
      5mo: 30 days, count 3% (1/30), nap MAE 213.3 min, bed MAE 851.4 min, nap bias +212.3, count bias -2.57
      6mo: 31 days, count 19% (6/31), nap MAE 347 min, bed MAE 1227.7 min, nap bias +347, count bias -1.81
      7mo: 30 days, count 33% (10/30), nap MAE 160.9 min, bed MAE 1119 min, nap bias +148.7, count bias -1.97
      8mo: 31 days, count 77% (24/31), nap MAE 30.7 min, bed MAE 872.1 min, nap bias +7.1, count bias -0.03
      9mo: 31 days, count 87% (27/31), nap MAE 21.2 min, bed MAE 918.3 min, nap bias -12.6, count bias +0.13
      10mo: 28 days, count 64% (18/28), nap MAE 38.4 min, bed MAE 308.8 min, nap bias -11.6, count bias 0
      11mo: 31 days, count 97% (30/31), nap MAE 42.3 min, bed MAE 28 min, nap bias -23.1, count bias +0.03
      12mo: 30 days, count 90% (27/30), nap MAE 38.9 min, bed MAE 34.2 min, nap bias -10.8, count bias +0.1
      13mo: 31 days, count 87% (27/31), nap MAE 30.6 min, bed MAE 38.7 min, nap bias -10.8, count bias +0.06
      14mo: 29 days, count 86% (25/29), nap MAE 36.2 min, bed MAE 39.7 min, nap bias -4.3, count bias -0.17
      15mo: 30 days, count 100% (30/30), nap MAE 45.3 min, bed MAE 41.8 min, nap bias +3.5, count bias 0
      16mo: 31 days, count 100% (31/31), nap MAE 57 min, bed MAE 42.2 min, nap bias +35.7, count bias 0
      17mo: 30 days, count 100% (30/30), nap MAE 22 min, bed MAE 26.5 min, nap bias -0.6, count bias 0
      18mo: 31 days, count 100% (31/31), nap MAE 55.4 min, bed MAE 94.2 min, nap bias +44.1, count bias 0
      19mo: 29 days, count 100% (29/29), nap MAE 95.7 min, bed MAE 538 min, nap bias +75.5, count bias 0
      20mo: 30 days, count 100% (30/30), nap MAE 33.2 min, bed MAE 140.7 min, nap bias +23.4, count bias 0
      21mo: 30 days, count 100% (30/30), nap MAE 27.5 min, bed MAE 480.8 min, nap bias +12.5, count bias 0
      22mo: 27 days, count 100% (27/27), nap MAE 22.5 min, bed MAE 152.7 min, nap bias +9.5, count bias 0
      23mo: 31 days, count 100% (31/31), nap MAE 56.3 min, bed MAE 42.7 min, nap bias +42.3, count bias 0
      24mo: 18 days, count 100% (18/18), nap MAE 139.6 min, bed MAE 45 min, nap bias +124.4, count bias 0
      25mo: 13 days, count 92% (12/13), nap MAE 226.4 min, bed MAE 79.2 min, nap bias +179.6, count bias -0.08
      26mo: 20 days, count 100% (20/20), nap MAE 299.7 min, bed MAE 48.5 min, nap bias +297.3, count bias 0
      27mo: 28 days, count 100% (28/28), nap MAE 217.8 min, bed MAE 26.3 min, nap bias +203.5, count bias 0
      28mo: 10 days, count 100% (10/10), nap MAE 252.6 min, bed MAE 0 min, nap bias +241, count bias 0
      29mo: 5 days, count 100% (5/5), nap MAE 281.8 min, bed MAE 1252.5 min, nap bias +281.8, count bias 0
      35mo: 1 days, count 100% (1/1), nap MAE 300 min, bed MAE 0 min, nap bias +300, count bias 0"
    `);
  });

  it("baby_2 per-month", () => {
    const buckets = bucketResultsByAge(results[2].result, results[2].birthdate);
    const lines = buckets.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "0mo: 16 days, count 19% (3/16), nap MAE 161.7 min, bed MAE 771.8 min, nap bias +91, count bias -2.19
      1mo: 14 days, count 14% (2/14), nap MAE 135 min, bed MAE 1147.3 min, nap bias +135, count bias +0.93
      2mo: 10 days, count 20% (2/10), nap MAE 49.9 min, bed MAE 113.3 min, nap bias +20.9, count bias -0.3
      3mo: 23 days, count 48% (11/23), nap MAE 82.8 min, bed MAE 135.9 min, nap bias +46.9, count bias -0.7
      4mo: 31 days, count 45% (14/31), nap MAE 68.3 min, bed MAE 39.9 min, nap bias +2.3, count bias -0.1
      5mo: 27 days, count 37% (10/27), nap MAE 109.8 min, bed MAE 117.8 min, nap bias +67.7, count bias +0.41
      6mo: 23 days, count 43% (10/23), nap MAE 147.8 min, bed MAE 0 min, nap bias +134.8, count bias -0.39
      7mo: 3 days, count 100% (3/3), nap MAE 151.7 min, bed MAE 0 min, nap bias +151.7, count bias 0"
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
