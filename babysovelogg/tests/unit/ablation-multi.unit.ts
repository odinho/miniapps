/**
 * Multi-baby ablation: run feature ablation on all babies to identify
 * features that consistently help or hurt across populations.
 */
import { describe, expect, it } from "bun:test";
import { backtest } from "$lib/engine/backtest.js";
import type { DayRecord } from "$lib/engine/backtest.js";
import type { PredictionFeatures } from "$lib/types.js";
import { DEFAULT_FEATURES } from "$lib/types.js";

import halldisData from "../fixtures/halldis-sleep.json";
import baby1Data from "../fixtures/baby_1-sleep.json";
import baby2Data from "../fixtures/baby_2-sleep.json";
import baby3Data from "../fixtures/baby_3-sleep.json";
import baby5Data from "../fixtures/baby_5-sleep.json";

interface BabyFixture {
  name: string;
  birthdate: string;
  tz: string;
  days: DayRecord[];
}

const babies: BabyFixture[] = [
  { name: "halldis", birthdate: "2025-06-12", tz: "Europe/Oslo", days: halldisData as DayRecord[] },
  { name: "baby_1", ...(baby1Data as { birthdate: string; days: DayRecord[] }), tz: "America/New_York" },
  { name: "baby_2", ...(baby2Data as { birthdate: string; days: DayRecord[] }), tz: "America/New_York" },
  { name: "baby_3", ...(baby3Data as { birthdate: string; days: DayRecord[] }), tz: "America/New_York" },
  { name: "baby_5", ...(baby5Data as { birthdate: string; days: DayRecord[] }), tz: "America/New_York" },
];

type FeatureKey = keyof PredictionFeatures;

const featureNames: { key: FeatureKey; label: string }[] = [
  { key: "positionalDuration", label: "positionalDuration" },
  { key: "habitualWake", label: "habitualWake" },
  { key: "habitualBedtime", label: "habitualBedtime" },
  { key: "habitualNapStart", label: "habitualNapStart" },
  { key: "cycleBias", label: "cycleBias" },
  { key: "sleepBudget", label: "sleepBudget" },
  { key: "weightedRecency", label: "weightedRecency" },
];

// Pre-compute all results
const baselines = babies.map((b) => ({
  ...b,
  result: backtest(b.days, b.birthdate, { tz: b.tz }),
}));

const ablations = featureNames.map(({ key, label }) => ({
  key,
  label,
  results: babies.map((b) => ({
    name: b.name,
    result: backtest(b.days, b.birthdate, {
      tz: b.tz,
      features: { ...DEFAULT_FEATURES, [key]: false },
    }),
  })),
}));

function delta(base: number, off: number): string {
  const d = Math.round((off - base) * 10) / 10;
  if (d === 0) return "0";
  return `${d > 0 ? "+" : ""}${d}`;
}

describe("multi-baby ablation", () => {
  it("per-feature contribution across all babies", () => {
    const lines: string[] = [];
    for (const abl of ablations) {
      const deltas = abl.results.map((r, i) => {
        const base = baselines[i].result;
        return `${r.name}: nap ${delta(base.napStartMAE, r.result.napStartMAE)}, wake ${delta(base.wakeTimeMAE, r.result.wakeTimeMAE)}`;
      });
      lines.push(`${abl.label}:\n  ${deltas.join("\n  ")}`);
    }
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "positionalDuration:
        halldis: nap 0, wake 0
        baby_1: nap -8.1, wake 0
        baby_2: nap +0.9, wake 0
        baby_3: nap -3, wake 0
        baby_5: nap -5.4, wake 0
      habitualWake:
        halldis: nap 0, wake +3.4
        baby_1: nap 0, wake +20.1
        baby_2: nap 0, wake +13
        baby_3: nap 0, wake +27.7
        baby_5: nap 0, wake +505
      habitualBedtime:
        halldis: nap 0, wake 0
        baby_1: nap 0, wake 0
        baby_2: nap 0, wake 0
        baby_3: nap 0, wake 0
        baby_5: nap 0, wake 0
      habitualNapStart:
        halldis: nap +3.9, wake 0
        baby_1: nap +2.3, wake 0
        baby_2: nap +0.1, wake 0
        baby_3: nap 0, wake 0
        baby_5: nap 0, wake 0
      cycleBias:
        halldis: nap 0, wake 0
        baby_1: nap 0, wake 0
        baby_2: nap 0, wake -0.2
        baby_3: nap 0, wake +0.2
        baby_5: nap 0, wake 0
      sleepBudget:
        halldis: nap 0, wake -0.6
        baby_1: nap 0, wake 0
        baby_2: nap 0, wake +3.2
        baby_3: nap 0, wake -2.3
        baby_5: nap 0, wake 0
      weightedRecency:
        halldis: nap 0, wake +0.3
        baby_1: nap +0.1, wake -0.6
        baby_2: nap +0.8, wake -2.3
        baby_3: nap -0.4, wake +1.3
        baby_5: nap +12.4, wake 0"
    `);
  });

  // Use 5-min threshold — Kaggle data is noisy, small deltas are not meaningful.
  it("no feature hurts nap MAE by > 5 min on 3+ babies", () => {
    for (const abl of ablations) {
      let hurtsCount = 0;
      for (let i = 0; i < babies.length; i++) {
        const base = baselines[i].result.napStartMAE;
        const off = abl.results[i].result.napStartMAE;
        if (off < base - 5) hurtsCount++;
      }
      expect(hurtsCount).toBeLessThan(3);
    }
  });

  it("no feature hurts wake MAE by > 5 min on 3+ babies", () => {
    for (const abl of ablations) {
      let hurtsCount = 0;
      for (let i = 0; i < babies.length; i++) {
        const base = baselines[i].result.wakeTimeMAE;
        const off = abl.results[i].result.wakeTimeMAE;
        if (off < base - 5) hurtsCount++;
      }
      expect(hurtsCount).toBeLessThan(3);
    }
  });
});
