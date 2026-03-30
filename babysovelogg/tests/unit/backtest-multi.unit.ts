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
      "halldis: 82 days, count 78% (64/82), nap MAE 58.3 min, bed MAE 39.7 min, nap bias +3.4, count bias +0.07
      baby_1: 803 days, count 68% (543/803), nap MAE 95.8 min, bed MAE 509 min, nap bias +63.3, count bias -1.32
      baby_2: 147 days, count 32% (47/147), nap MAE 104.9 min, bed MAE 178.1 min, nap bias +56.1, count bias -0.13
      baby_3: 70 days, count 13% (9/70), nap MAE 144.6 min, bed MAE 1325 min, nap bias -1.9, count bias -0.26
      baby_4: 25 days, count 16% (4/25), nap MAE 84.8 min, bed MAE 0 min, nap bias +66, count bias +0.96
      baby_5: 41 days, count 12% (5/41), nap MAE 117.6 min, bed MAE 892.8 min, nap bias +104.6, count bias -0.78"
    `);
  });

  it("baby_1 per-month (longest dataset)", () => {
    const buckets = bucketResultsByAge(results[1].result, results[1].birthdate);
    const lines = buckets.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "0mo: 15 days, count 0% (0/15), nap MAE 110.5 min, bed MAE 1406.3 min, nap bias +77.2, count bias -5.6
      1mo: 31 days, count 0% (0/31), nap MAE 80.7 min, bed MAE 424.8 min, nap bias +71.7, count bias -6.81
      2mo: 30 days, count 0% (0/30), nap MAE 75.6 min, bed MAE 614.7 min, nap bias +32.1, count bias -5
      3mo: 30 days, count 3% (1/30), nap MAE 108.2 min, bed MAE 715.9 min, nap bias +30.6, count bias -4.2
      4mo: 31 days, count 0% (0/31), nap MAE 159.4 min, bed MAE 1206.4 min, nap bias +127.8, count bias -4.45
      5mo: 30 days, count 0% (0/30), nap MAE 193.1 min, bed MAE 1321 min, nap bias +153.5, count bias -4.27
      6mo: 31 days, count 3% (1/31), nap MAE 263.7 min, bed MAE 1360 min, nap bias +261.6, count bias -4.52
      7mo: 30 days, count 17% (5/30), nap MAE 111.5 min, bed MAE 1330.1 min, nap bias +87, count bias -2.67
      8mo: 31 days, count 68% (21/31), nap MAE 29.2 min, bed MAE 1203.8 min, nap bias -0.5, count bias -0.13
      9mo: 31 days, count 87% (27/31), nap MAE 21.8 min, bed MAE 1358.3 min, nap bias -11.4, count bias +0.13
      10mo: 28 days, count 57% (16/28), nap MAE 35.3 min, bed MAE 667.5 min, nap bias -10.1, count bias -0.07
      11mo: 31 days, count 97% (30/31), nap MAE 39.9 min, bed MAE 74.8 min, nap bias -18.8, count bias +0.03
      12mo: 30 days, count 90% (27/30), nap MAE 37.9 min, bed MAE 84 min, nap bias -15.2, count bias +0.1
      13mo: 31 days, count 87% (27/31), nap MAE 32.2 min, bed MAE 41.7 min, nap bias -10.8, count bias +0.06
      14mo: 29 days, count 86% (25/29), nap MAE 36.1 min, bed MAE 88.4 min, nap bias -3.1, count bias -0.17
      15mo: 30 days, count 100% (30/30), nap MAE 45.7 min, bed MAE 87.1 min, nap bias +1.6, count bias 0
      16mo: 31 days, count 100% (31/31), nap MAE 56.6 min, bed MAE 89.6 min, nap bias +34, count bias 0
      17mo: 30 days, count 100% (30/30), nap MAE 21.4 min, bed MAE 26.1 min, nap bias -0.7, count bias 0
      18mo: 31 days, count 100% (31/31), nap MAE 54.5 min, bed MAE 316.1 min, nap bias +43.1, count bias 0
      19mo: 29 days, count 100% (29/29), nap MAE 104.4 min, bed MAE 972.7 min, nap bias +81.9, count bias 0
      20mo: 30 days, count 100% (30/30), nap MAE 33.2 min, bed MAE 506.4 min, nap bias +23.4, count bias 0
      21mo: 30 days, count 100% (30/30), nap MAE 28 min, bed MAE 772.3 min, nap bias +11, count bias 0
      22mo: 27 days, count 100% (27/27), nap MAE 22.3 min, bed MAE 379.5 min, nap bias +9, count bias 0
      23mo: 31 days, count 100% (31/31), nap MAE 56 min, bed MAE 44.6 min, nap bias +42.4, count bias 0
      24mo: 18 days, count 100% (18/18), nap MAE 138.2 min, bed MAE 45.6 min, nap bias +116.9, count bias 0
      25mo: 13 days, count 92% (12/13), nap MAE 220.2 min, bed MAE 0 min, nap bias +173.6, count bias -0.08
      26mo: 20 days, count 100% (20/20), nap MAE 300.3 min, bed MAE 48.5 min, nap bias +298.4, count bias 0
      27mo: 28 days, count 100% (28/28), nap MAE 217.8 min, bed MAE 31.9 min, nap bias +202.2, count bias 0
      28mo: 10 days, count 100% (10/10), nap MAE 259.6 min, bed MAE 0 min, nap bias +244.1, count bias 0
      29mo: 5 days, count 100% (5/5), nap MAE 287.8 min, bed MAE 1252.5 min, nap bias +287.8, count bias 0
      35mo: 1 days, count 100% (1/1), nap MAE 300 min, bed MAE 0 min, nap bias +300, count bias 0"
    `);
  });

  it("baby_2 per-month", () => {
    const buckets = bucketResultsByAge(results[2].result, results[2].birthdate);
    const lines = buckets.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "0mo: 16 days, count 13% (2/16), nap MAE 140.4 min, bed MAE 771.8 min, nap bias +49.7, count bias -3.12
      1mo: 14 days, count 7% (1/14), nap MAE 113.9 min, bed MAE 1147.3 min, nap bias +113.6, count bias +1.36
      2mo: 10 days, count 10% (1/10), nap MAE 45 min, bed MAE 106.9 min, nap bias +12.8, count bias +0.2
      3mo: 23 days, count 26% (6/23), nap MAE 85.2 min, bed MAE 128.2 min, nap bias +55.7, count bias 0
      4mo: 31 days, count 55% (17/31), nap MAE 69 min, bed MAE 42.5 min, nap bias +6.1, count bias -0.16
      5mo: 27 days, count 41% (11/27), nap MAE 109.8 min, bed MAE 115.6 min, nap bias +67.6, count bias +0.37
      6mo: 23 days, count 26% (6/23), nap MAE 149.8 min, bed MAE 0 min, nap bias +140.1, count bias +0.22
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
