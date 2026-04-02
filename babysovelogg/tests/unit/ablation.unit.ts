/**
 * Ablation study: disable each prediction feature one at a time
 * and measure its marginal contribution to overall accuracy.
 *
 * A feature that makes things worse when enabled will show negative delta.
 * This helps identify which features pull their weight and which hurt.
 */
import { describe, expect, it } from "bun:test";
import { backtest, renderSummary } from "$lib/engine/backtest.js";
import type { DayRecord, BacktestResult } from "$lib/engine/backtest.js";
import type { PredictionFeatures } from "$lib/types.js";
import { DEFAULT_FEATURES } from "$lib/types.js";

import halldisData from "../fixtures/halldis-sleep.json";

const BIRTHDATE = "2025-06-12";
const TZ = "Europe/Oslo";
const days = halldisData as DayRecord[];

type FeatureKey = keyof PredictionFeatures;

function runWith(features: Partial<PredictionFeatures>): BacktestResult {
  return backtest(days, BIRTHDATE, { tz: TZ, features });
}

function renderAblation(
  baseline: BacktestResult,
  featureName: string,
  without: BacktestResult,
): string {
  const delta = (metric: keyof BacktestResult, lowerIsBetter = true) => {
    const base = baseline[metric] as number;
    const off = without[metric] as number;
    const diff = off - base;
    // Positive delta = disabling made it worse = feature helps
    const sign = diff > 0 ? "+" : "";
    const label = lowerIsBetter
      ? (diff > 0 ? "helps" : diff < 0 ? "hurts" : "neutral")
      : (diff < 0 ? "helps" : diff > 0 ? "hurts" : "neutral");
    return `${sign}${Math.round(diff * 10) / 10} (${label})`;
  };

  return [
    `${featureName}:`,
    `  nap MAE ${delta("napStartMAE")}`,
    `  dur MAE ${delta("napDurationMAE")}`,
    `  bed MAE ${delta("bedtimeMAE")}`,
    `  wake MAE ${delta("wakeTimeMAE")}`,
  ].join("\n");
}

// ─── Run all variants ───────────────────────────────────────────────────────

const allOn = runWith(DEFAULT_FEATURES);

const featureNames: { key: FeatureKey; label: string }[] = [
  { key: "positionalDuration", label: "positional nap duration" },
  { key: "habitualWake", label: "habitual wake anchor" },
  { key: "habitualBedtime", label: "habitual bedtime anchor" },
  { key: "cycleBias", label: "sleep cycle bias" },
  { key: "sleepBudget", label: "sleep budget" },
  { key: "weightedRecency", label: "weighted recency" },
];

const ablations = featureNames.map(({ key, label }) => ({
  key,
  label,
  result: runWith({ ...DEFAULT_FEATURES, [key]: false }),
}));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("feature ablation", () => {
  it("all features enabled (baseline)", () => {
    expect(renderSummary(allOn, "all-on")).toMatchInlineSnapshot(`"all-on: 82 days, count 80% (66/82), nap MAE 57.8, dur MAE 23.4, bed MAE 22.3, wake MAE 44.9, nap bias +8.7, count bias +0.07"`);
  });

  it("per-feature contribution", () => {
    const lines = ablations.map((a) => renderAblation(allOn, a.label, a.result));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "positional nap duration:
        nap MAE +0.8 (helps)
        dur MAE +0.4 (helps)
        bed MAE 0 (neutral)
        wake MAE 0 (neutral)
      habitual wake anchor:
        nap MAE 0 (neutral)
        dur MAE 0 (neutral)
        bed MAE 0 (neutral)
        wake MAE +3.3 (helps)
      habitual bedtime anchor:
        nap MAE 0 (neutral)
        dur MAE 0 (neutral)
        bed MAE +17 (helps)
        wake MAE 0 (neutral)
      sleep cycle bias:
        nap MAE 0 (neutral)
        dur MAE 0 (neutral)
        bed MAE 0 (neutral)
        wake MAE +0.2 (helps)
      sleep budget:
        nap MAE 0 (neutral)
        dur MAE 0 (neutral)
        bed MAE 0 (neutral)
        wake MAE -1.4 (hurts)
      weighted recency:
        nap MAE 0 (neutral)
        dur MAE 0 (neutral)
        bed MAE 0 (neutral)
        wake MAE 0 (neutral)"
    `);
  });

  it("no feature makes things dramatically worse when enabled", () => {
    for (const a of ablations) {
      // Disabling a good feature should make MAE go up (or stay).
      // If disabling makes MAE drop by >5 min, the feature is actively harmful.
      expect(a.result.napStartMAE).toBeGreaterThanOrEqual(allOn.napStartMAE - 5);
      expect(a.result.bedtimeMAE).toBeGreaterThanOrEqual(allOn.bedtimeMAE - 5);
    }
  });

  it("habitual bedtime is the single biggest contributor", () => {
    const bedtimeFeature = ablations.find((a) => a.key === "habitualBedtime")!;
    // Disabling it should make bedtime MAE at least 10 min worse
    expect(bedtimeFeature.result.bedtimeMAE - allOn.bedtimeMAE).toBeGreaterThan(10);
  });
});
