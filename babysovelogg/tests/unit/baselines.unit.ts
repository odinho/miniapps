import { describe, expect, it } from "bun:test";
import {
  backtest,
  bucketResultsByAge,
  renderSummary,
} from "$lib/engine/backtest.js";
import {
  ageDefaultNaps,
  ageDefaultBedtime,
  yesterdayRepeatedNaps,
  yesterdayRepeatedBedtime,
  movingAvgNaps,
  movingAvgBedtime,
} from "$lib/engine/baselines.js";
import {
  weightedNaps,
  weightedBedtime,
} from "$lib/engine/weighted.js";
import type { DayRecord } from "$lib/engine/backtest.js";

import halldisData from "../fixtures/halldis-sleep.json";

const BIRTHDATE = "2025-06-12";
const TZ = "Europe/Oslo";
const days = halldisData as DayRecord[];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function runBaseline(
  label: string,
  predict: NonNullable<Parameters<typeof backtest>[2]>["predict"],
  predictBedtime: NonNullable<Parameters<typeof backtest>[2]>["predictBedtime"],
) {
  const result = backtest(days, BIRTHDATE, { predict, predictBedtime, tz: TZ });
  const buckets = bucketResultsByAge(result, BIRTHDATE);
  return { result, buckets, label };
}

function summaryLine(b: ReturnType<typeof runBaseline>) {
  return renderSummary(b.result, b.label);
}

function perMonth(b: ReturnType<typeof runBaseline>) {
  return b.buckets.map((bucket) => renderSummary(bucket.result, `${b.label} ${bucket.label}`)).join("\n");
}

// ─── Run all strategies ──────────────────────────────────────────────────────

const engine = runBaseline("engine", undefined, undefined);
const ageDefault = runBaseline("age-default", ageDefaultNaps, ageDefaultBedtime);
const yesterday = runBaseline("yesterday", yesterdayRepeatedNaps, yesterdayRepeatedBedtime);
const movingAvg = runBaseline("3d-avg", movingAvgNaps, movingAvgBedtime);
const weighted = runBaseline("weighted", weightedNaps, weightedBedtime);

// ─── Combined summary ────────────────────────────────────────────────────────

describe("baseline comparison", () => {
  it("all strategies summary", () => {
    const lines = [engine, ageDefault, yesterday, movingAvg, weighted].map(summaryLine);
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "engine: 82 days, count 80% (66/82), nap MAE 57.8, dur MAE 23.4, bed MAE 39.3, wake MAE 43.2, nap bias +8.7, count bias +0.07
      age-default: 82 days, count 66% (54/82), nap MAE 70, dur MAE 28.6, bed MAE 54.9, wake MAE 43.2, nap bias -27.3, count bias +0.22
      yesterday: 82 days, count 73% (60/82), nap MAE 65.4, dur MAE 33.1, bed MAE 26.1, wake MAE 43.2, nap bias +14.1, count bias +0.02
      3d-avg: 82 days, count 79% (65/82), nap MAE 57.9, dur MAE 25.3, bed MAE 41.3, wake MAE 43.2, nap bias +9.4, count bias +0.06
      weighted: 82 days, count 80% (66/82), nap MAE 60.3, dur MAE 23.8, bed MAE 43.2, wake MAE 43.2, nap bias -1.6, count bias +0.07"
    `);
  });

  it("per-month breakdown — engine vs baselines", () => {
    const lines = [engine, ageDefault, yesterday, movingAvg, weighted].map(perMonth);
    expect(lines.join("\n\n")).toMatchInlineSnapshot(`
      "engine 6mo: 5 days, count 60% (3/5), nap MAE 45.9, dur MAE 23.2, bed MAE 61.5, wake MAE 10, nap bias +26.5, count bias -0.4
      engine 7mo: 31 days, count 74% (23/31), nap MAE 50.3, dur MAE 26.3, bed MAE 43.8, wake MAE 28.2, nap bias -7.2, count bias +0.13
      engine 8mo: 28 days, count 89% (25/28), nap MAE 33.8, dur MAE 19, bed MAE 26.5, wake MAE 21.3, nap bias +11, count bias +0.11
      engine 9mo: 18 days, count 83% (15/18), nap MAE 148.9, dur MAE 27, bed MAE 44.3, wake MAE 112.8, nap bias +38.4, count bias +0.06

      age-default 6mo: 5 days, count 20% (1/5), nap MAE 40, dur MAE 20.8, bed MAE 44.9, wake MAE 10, nap bias +25.6, count bias -0.8
      age-default 7mo: 31 days, count 84% (26/31), nap MAE 68.6, dur MAE 30.6, bed MAE 64.9, wake MAE 28.2, nap bias -50.7, count bias +0.1
      age-default 8mo: 28 days, count 89% (25/28), nap MAE 37.2, dur MAE 21.2, bed MAE 36.1, wake MAE 21.3, nap bias -23.8, count bias +0.11
      age-default 9mo: 18 days, count 11% (2/18), nap MAE 135.2, dur MAE 46.3, bed MAE 68.8, wake MAE 112.8, nap bias -12.4, count bias +0.89

      yesterday 6mo: 5 days, count 40% (2/5), nap MAE 52.8, dur MAE 34.3, bed MAE 32, wake MAE 10, nap bias +14.5, count bias -0.2
      yesterday 7mo: 31 days, count 74% (23/31), nap MAE 68.3, dur MAE 38, bed MAE 28.5, wake MAE 28.2, nap bias +10.2, count bias 0
      yesterday 8mo: 28 days, count 79% (22/28), nap MAE 46.4, dur MAE 25, bed MAE 25.4, wake MAE 21.3, nap bias -3.2, count bias +0.07
      yesterday 9mo: 18 days, count 72% (13/18), nap MAE 112.6, dur MAE 40.3, bed MAE 21.2, wake MAE 112.8, nap bias +67.5, count bias +0.06

      3d-avg 6mo: 5 days, count 40% (2/5), nap MAE 43.3, dur MAE 27.3, bed MAE 54.1, wake MAE 10, nap bias +9.6, count bias -0.2
      3d-avg 7mo: 31 days, count 71% (22/31), nap MAE 56.6, dur MAE 28.4, bed MAE 48.6, wake MAE 28.2, nap bias +3.6, count bias +0.1
      3d-avg 8mo: 28 days, count 89% (25/28), nap MAE 39.4, dur MAE 20.1, bed MAE 29.6, wake MAE 21.3, nap bias -6.9, count bias +0.11
      3d-avg 9mo: 18 days, count 89% (16/18), nap MAE 121.6, dur MAE 29.5, bed MAE 42.5, wake MAE 112.8, nap bias +70.8, count bias 0

      weighted 6mo: 5 days, count 60% (3/5), nap MAE 41.7, dur MAE 21.7, bed MAE 59.5, wake MAE 10, nap bias +21.8, count bias -0.4
      weighted 7mo: 31 days, count 74% (23/31), nap MAE 51.1, dur MAE 27.6, bed MAE 45.9, wake MAE 28.2, nap bias -6.1, count bias +0.13
      weighted 8mo: 28 days, count 89% (25/28), nap MAE 33.4, dur MAE 17.7, bed MAE 31.2, wake MAE 21.3, nap bias +10.6, count bias +0.11
      weighted 9mo: 18 days, count 83% (15/18), nap MAE 168, dur MAE 30.4, bed MAE 51.8, wake MAE 112.8, nap bias -34.6, count bias +0.06"
    `);
  });
});

// ─── Engine vs baselines: where does it win? ─────────────────────────────────

describe("engine beats baselines", () => {
  it("engine beats age-default on bedtime, nap count, and nap timing", () => {
    expect(engine.result.bedtimeMAE).toBeLessThan(ageDefault.result.bedtimeMAE);
    expect(engine.result.napCountAccuracy).toBeGreaterThan(ageDefault.result.napCountAccuracy);
    expect(engine.result.napStartMAE).toBeLessThan(ageDefault.result.napStartMAE);
  });

  it("engine beats yesterday-repeated on nap timing and nap count", () => {
    expect(engine.result.napStartMAE).toBeLessThan(yesterday.result.napStartMAE);
    expect(engine.result.napCountAccuracy).toBeGreaterThan(yesterday.result.napCountAccuracy);
  });

  // NOTE: yesterday-repeated bedtime (26.1 min MAE) beats the engine (39.7 min).
  // This suggests the engine's bedtime learning has room for improvement — simply
  // repeating yesterday's bedtime is a strong heuristic for consistent babies.
  it("yesterday-repeated bedtime beats the engine (known gap)", () => {
    expect(yesterday.result.bedtimeMAE).toBeLessThan(engine.result.bedtimeMAE);
  });

  // After transition logic improvement, engine now beats 3d-avg on nap count too
  it("engine nap count ≥ 3d-avg (transition logic closed the gap)", () => {
    expect(engine.result.napCountAccuracy).toBeGreaterThanOrEqual(movingAvg.result.napCountAccuracy);
  });
});

// ─── Duration comparison ────────────────────────────────────────────────────

describe("duration: engine vs baselines", () => {
  it("engine beats age-default on nap duration", () => {
    expect(engine.result.napDurationMAE).toBeLessThan(ageDefault.result.napDurationMAE);
  });

  it("engine beats yesterday-repeated on nap duration", () => {
    expect(engine.result.napDurationMAE).toBeLessThan(yesterday.result.napDurationMAE);
  });

  it("engine beats or matches 3d-avg on nap duration", () => {
    expect(engine.result.napDurationMAE).toBeLessThanOrEqual(movingAvg.result.napDurationMAE);
  });

  // NOTE: wake MAE is identical across strategies because they all use the
  // engine's getLearnedNightDuration as default. Differentiating this
  // requires strategy-specific night duration predictors (Phase 1d future work).
  it("wake MAE is the same across all strategies (known limitation)", () => {
    expect(engine.result.wakeTimeMAE).toBe(ageDefault.result.wakeTimeMAE);
    expect(engine.result.wakeTimeMAE).toBe(yesterday.result.wakeTimeMAE);
  });
});
