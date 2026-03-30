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
      "engine: 82 days, count 80% (66/82), nap MAE 58.3 min, bed MAE 39.7 min, nap bias +3.8, count bias +0.07
      age-default: 82 days, count 66% (54/82), nap MAE 72 min, bed MAE 54.9 min, nap bias -44.6, count bias +0.22
      yesterday: 82 days, count 73% (60/82), nap MAE 66.2 min, bed MAE 26.1 min, nap bias +6.7, count bias +0.02
      3d-avg: 82 days, count 79% (65/82), nap MAE 57.6 min, bed MAE 41.3 min, nap bias +3.3, count bias +0.06
      weighted: 82 days, count 80% (66/82), nap MAE 60.4 min, bed MAE 43.2 min, nap bias -8.6, count bias +0.07"
    `);
  });

  it("per-month breakdown — engine vs baselines", () => {
    const lines = [engine, ageDefault, yesterday, movingAvg, weighted].map(perMonth);
    expect(lines.join("\n\n")).toMatchInlineSnapshot(`
      "engine 6mo: 5 days, count 60% (3/5), nap MAE 47.3 min, bed MAE 61.5 min, nap bias +27.4, count bias -0.4
      engine 7mo: 31 days, count 74% (23/31), nap MAE 49.7 min, bed MAE 41.9 min, nap bias -16, count bias +0.13
      engine 8mo: 28 days, count 89% (25/28), nap MAE 32.7 min, bed MAE 26.5 min, nap bias +8.7, count bias +0.11
      engine 9mo: 18 days, count 83% (15/18), nap MAE 162.7 min, bed MAE 49.6 min, nap bias +34.7, count bias +0.06

      age-default 6mo: 5 days, count 20% (1/5), nap MAE 32 min, bed MAE 44.9 min, nap bias +11.9, count bias -0.8
      age-default 7mo: 31 days, count 84% (26/31), nap MAE 69.3 min, bed MAE 64.9 min, nap bias -60.3, count bias +0.1
      age-default 8mo: 28 days, count 89% (25/28), nap MAE 35.9 min, bed MAE 36.1 min, nap bias -28.5, count bias +0.11
      age-default 9mo: 18 days, count 11% (2/18), nap MAE 195.3 min, bed MAE 68.8 min, nap bias -70.3, count bias +0.89

      yesterday 6mo: 5 days, count 40% (2/5), nap MAE 51 min, bed MAE 32 min, nap bias +3.1, count bias -0.2
      yesterday 7mo: 31 days, count 74% (23/31), nap MAE 69.5 min, bed MAE 28.5 min, nap bias +3, count bias 0
      yesterday 8mo: 28 days, count 79% (22/28), nap MAE 44.8 min, bed MAE 25.4 min, nap bias -10.6, count bias +0.07
      yesterday 9mo: 18 days, count 72% (13/18), nap MAE 127.3 min, bed MAE 21.2 min, nap bias +69.6, count bias +0.06

      3d-avg 6mo: 5 days, count 40% (2/5), nap MAE 39.1 min, bed MAE 54.1 min, nap bias -3, count bias -0.2
      3d-avg 7mo: 31 days, count 71% (22/31), nap MAE 56.1 min, bed MAE 48.6 min, nap bias -5.5, count bias +0.1
      3d-avg 8mo: 28 days, count 89% (25/28), nap MAE 38.2 min, bed MAE 29.6 min, nap bias -10.7, count bias +0.11
      3d-avg 9mo: 18 days, count 89% (16/18), nap MAE 128 min, bed MAE 42.5 min, nap bias +72, count bias 0

      weighted 6mo: 5 days, count 60% (3/5), nap MAE 38.6 min, bed MAE 59.5 min, nap bias +15.4, count bias -0.4
      weighted 7mo: 31 days, count 74% (23/31), nap MAE 49.9 min, bed MAE 45.9 min, nap bias -15.4, count bias +0.13
      weighted 8mo: 28 days, count 89% (25/28), nap MAE 31.9 min, bed MAE 31.2 min, nap bias +7.9, count bias +0.11
      weighted 9mo: 18 days, count 83% (15/18), nap MAE 185 min, bed MAE 51.8 min, nap bias -49.5, count bias +0.06"
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
