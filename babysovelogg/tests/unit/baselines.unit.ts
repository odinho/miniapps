import { describe, expect, it } from "bun:test";
import {
  backtest,
  bucketResultsByAge,
  renderSummary,
} from "$lib/engine/backtest.js";
import {
  ageDefaultNaps,
  ageDefaultBedtime,
  ageDefaultWakeTime,
  yesterdayRepeatedNaps,
  yesterdayRepeatedBedtime,
  yesterdayRepeatedWakeTime,
  movingAvgNaps,
  movingAvgBedtime,
  movingAvgWakeTime,
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
  predictWakeTime?: NonNullable<Parameters<typeof backtest>[2]>["predictWakeTime"],
) {
  const result = backtest(days, BIRTHDATE, { predict, predictBedtime, predictWakeTime, tz: TZ });
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

const engine = runBaseline("engine", undefined, undefined, undefined);
const ageDefault = runBaseline("age-default", ageDefaultNaps, ageDefaultBedtime, ageDefaultWakeTime);
const yesterday = runBaseline("yesterday", yesterdayRepeatedNaps, yesterdayRepeatedBedtime, yesterdayRepeatedWakeTime);
const movingAvg = runBaseline("3d-avg", movingAvgNaps, movingAvgBedtime, movingAvgWakeTime);
const weighted = runBaseline("weighted", weightedNaps, weightedBedtime, undefined);

// ─── Combined summary ────────────────────────────────────────────────────────

describe("baseline comparison", () => {
  it("all strategies summary", () => {
    const lines = [engine, ageDefault, yesterday, movingAvg, weighted].map(summaryLine);
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "engine: 112 days, count 85% (95/112), nap MAE 41.3, dur MAE 24.3, bed MAE 21.4, wake MAE 25.2, nap bias -3.8, count bias +0.04
      age-default: 112 days, count 50% (56/112), nap MAE 62.1, dur MAE 33.2, bed MAE 85.8, wake MAE 46.8, nap bias -26.1, count bias +0.41
      yesterday: 112 days, count 78% (87/112), nap MAE 52.7, dur MAE 34.3, bed MAE 25.9, wake MAE 26.9, nap bias +6.4, count bias +0.01
      3d-avg: 112 days, count 83% (93/112), nap MAE 45.3, dur MAE 26.7, bed MAE 46.5, wake MAE 23.7, nap bias +1, count bias +0.03
      weighted: 112 days, count 84% (94/112), nap MAE 49.9, dur MAE 24.7, bed MAE 54.1, wake MAE 25.2, nap bias -12.1, count bias +0.04"
    `);
  });

  it("per-month breakdown — engine vs baselines", () => {
    const lines = [engine, ageDefault, yesterday, movingAvg, weighted].map(perMonth);
    expect(lines.join("\n\n")).toMatchInlineSnapshot(`
      "engine 6mo: 5 days, count 60% (3/5), nap MAE 56.5, dur MAE 27.7, bed MAE 28.7, wake MAE 19.9, nap bias +12.9, count bias -0.4
      engine 7mo: 31 days, count 77% (24/31), nap MAE 50.4, dur MAE 26.8, bed MAE 22.3, wake MAE 29.1, nap bias -12.7, count bias +0.16
      engine 8mo: 28 days, count 89% (25/28), nap MAE 27, dur MAE 18.9, bed MAE 15.8, wake MAE 21.8, nap bias -4.8, count bias +0.11
      engine 9mo: 31 days, count 87% (27/31), nap MAE 47.1, dur MAE 26.2, bed MAE 25.2, wake MAE 26.3, nap bias +3.3, count bias 0
      engine 10mo: 17 days, count 94% (16/17), nap MAE 29.3, dur MAE 26.8, bed MAE 19.4, wake MAE 23, nap bias +4.7, count bias -0.06

      age-default 6mo: 5 days, count 20% (1/5), nap MAE 40, dur MAE 20.8, bed MAE 44.9, wake MAE 28, nap bias +25.6, count bias -0.8
      age-default 7mo: 31 days, count 84% (26/31), nap MAE 68.6, dur MAE 30.6, bed MAE 64.9, wake MAE 46.2, nap bias -50.7, count bias +0.1
      age-default 8mo: 28 days, count 89% (25/28), nap MAE 37.2, dur MAE 21.2, bed MAE 36.1, wake MAE 43.2, nap bias -23.8, count bias +0.11
      age-default 9mo: 31 days, count 10% (3/31), nap MAE 86.9, dur MAE 50.1, bed MAE 116.1, wake MAE 42.8, nap bias -31.8, count bias +0.9
      age-default 10mo: 17 days, count 6% (1/17), nap MAE 54.8, dur MAE 51.6, bed MAE 155.4, wake MAE 67.5, nap bias +4.7, count bias +0.94

      yesterday 6mo: 5 days, count 40% (2/5), nap MAE 52.8, dur MAE 34.3, bed MAE 32, wake MAE 29.2, nap bias +14.5, count bias -0.2
      yesterday 7mo: 31 days, count 74% (23/31), nap MAE 68.3, dur MAE 38, bed MAE 28.5, wake MAE 29.2, nap bias +10.2, count bias 0
      yesterday 8mo: 28 days, count 79% (22/28), nap MAE 46.4, dur MAE 25, bed MAE 25.4, wake MAE 21.5, nap bias -3.2, count bias +0.07
      yesterday 9mo: 31 days, count 81% (25/31), nap MAE 45, dur MAE 36.4, bed MAE 26.1, wake MAE 28.3, nap bias +8.8, count bias 0
      yesterday 10mo: 17 days, count 88% (15/17), nap MAE 34.9, dur MAE 46.5, bed MAE 20, wake MAE 27.9, nap bias +10.9, count bias 0

      3d-avg 6mo: 5 days, count 40% (2/5), nap MAE 43.3, dur MAE 27.3, bed MAE 54.1, wake MAE 30.6, nap bias +9.6, count bias -0.2
      3d-avg 7mo: 31 days, count 71% (22/31), nap MAE 56.6, dur MAE 28.4, bed MAE 48.6, wake MAE 27.1, nap bias +3.6, count bias +0.1
      3d-avg 8mo: 28 days, count 89% (25/28), nap MAE 39.4, dur MAE 20.1, bed MAE 29.6, wake MAE 19.2, nap bias -6.9, count bias +0.11
      3d-avg 9mo: 31 days, count 90% (28/31), nap MAE 41.2, dur MAE 31, bed MAE 45, wake MAE 22.1, nap bias +2.6, count bias -0.03
      3d-avg 10mo: 17 days, count 94% (16/17), nap MAE 32.2, dur MAE 33.5, bed MAE 68.9, wake MAE 25.4, nap bias +6.1, count bias -0.06

      weighted 6mo: 5 days, count 60% (3/5), nap MAE 41.7, dur MAE 21.7, bed MAE 59.5, wake MAE 19.9, nap bias +21.8, count bias -0.4
      weighted 7mo: 31 days, count 74% (23/31), nap MAE 51.1, dur MAE 27.6, bed MAE 45.9, wake MAE 29.1, nap bias -6.1, count bias +0.13
      weighted 8mo: 28 days, count 89% (25/28), nap MAE 33.4, dur MAE 17.7, bed MAE 31.2, wake MAE 21.8, nap bias +10.6, count bias +0.11
      weighted 9mo: 31 days, count 87% (27/31), nap MAE 85.5, dur MAE 29.3, bed MAE 61.8, wake MAE 26.3, nap bias -71.7, count bias 0
      weighted 10mo: 17 days, count 94% (16/17), nap MAE 32.6, dur MAE 30, bed MAE 87.9, wake MAE 23, nap bias -11.2, count bias -0.06"
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

  it("engine beats yesterday-repeated on bedtime (habitual anchoring)", () => {
    expect(engine.result.bedtimeMAE).toBeLessThan(yesterday.result.bedtimeMAE);
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

  it("engine wake MAE beats age-default and yesterday", () => {
    expect(engine.result.wakeTimeMAE).toBeLessThanOrEqual(ageDefault.result.wakeTimeMAE);
    expect(engine.result.wakeTimeMAE).toBeLessThanOrEqual(yesterday.result.wakeTimeMAE);
  });

  // NOTE: 3d-avg wake baseline (24 min) currently beats the engine (25.6 min).
  // The engine's wake prediction blends habitual wake + night duration + sleep budget,
  // but a simple 3-day average of actual wake times is more accurate on Halldis data.
  // This suggests the engine's night-side features need tuning.
  it("3d-avg wake baseline exposes engine weakness", () => {
    expect(movingAvg.result.wakeTimeMAE).toBeLessThan(engine.result.wakeTimeMAE);
  });
});
