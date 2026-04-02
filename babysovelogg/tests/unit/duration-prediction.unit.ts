/**
 * Duration and wake-time prediction tests.
 *
 * Implementation-independent: tests outcomes on fixture data, not internals.
 * Any algorithm that predicts nap endTimes and night wake times should pass.
 */
import { describe, expect, it } from "bun:test";
import {
  backtest,
  bucketResultsByAge,
  bucketByWarmup,
} from "$lib/engine/backtest.js";
import type { DayRecord, BacktestResult } from "$lib/engine/backtest.js";
import { computeConfidence } from "$lib/engine/confidence.js";
import { predictDayNaps, calculateAgeMonths } from "$lib/engine/schedule.js";
import type { SleepEntry, BabyContext } from "$lib/types.js";

import halldisData from "../fixtures/halldis-sleep.json";

const BIRTHDATE = "2025-06-12";
const TZ = "Europe/Oslo";
const days = halldisData as DayRecord[];
const result = backtest(days, BIRTHDATE, { tz: TZ });

// ─── Renderers ──────────────────────────────────────────────────────────────

function renderDurationMetrics(r: BacktestResult): string {
  const durBias = r.days.flatMap((d) => d.napDurationErrors);
  const meanBias = durBias.length > 0
    ? Math.round(durBias.reduce((a, b) => a + b, 0) / durBias.length * 10) / 10
    : 0;

  const wakeBias = r.days.map((d) => d.wakeTimeError).filter((e): e is number => e !== null);
  const meanWakeBias = wakeBias.length > 0
    ? Math.round(wakeBias.reduce((a, b) => a + b, 0) / wakeBias.length * 10) / 10
    : 0;

  return [
    `${r.totalDays} days`,
    `nap dur MAE: ${r.napDurationMAE} min (bias ${meanBias > 0 ? "+" : ""}${meanBias})`,
    `nap end MAE: ${r.napEndMAE} min`,
    `wake time MAE: ${r.wakeTimeMAE} min (bias ${meanWakeBias > 0 ? "+" : ""}${meanWakeBias})`,
  ].join("\n");
}

function renderPositionalDurations(): string {
  const byPos = new Map<number, { actual: number[]; errors: number[] }>();

  for (const day of result.days) {
    const matchCount = Math.min(day.predictedNaps.length, day.actualNaps.length);
    for (let k = 0; k < matchCount; k++) {
      if (!byPos.has(k)) byPos.set(k, { actual: [], errors: [] });
      const entry = byPos.get(k)!;
      const actualDur = (new Date(day.actualNaps[k].end_time!).getTime()
        - new Date(day.actualNaps[k].start_time).getTime()) / 60_000;
      entry.actual.push(actualDur);
      entry.errors.push(day.napDurationErrors[k]);
    }
  }

  const lines: string[] = [];
  for (const [pos, data] of [...byPos.entries()].toSorted(([a], [b]) => a - b)) {
    const avgActual = Math.round(data.actual.reduce((a, b) => a + b, 0) / data.actual.length);
    const mae = Math.round(data.errors.reduce((s, e) => s + Math.abs(e), 0) / data.errors.length * 10) / 10;
    const bias = Math.round(data.errors.reduce((a, b) => a + b, 0) / data.errors.length * 10) / 10;
    lines.push(`nap ${pos + 1}: avg ${avgActual} min actual, MAE ${mae}, bias ${bias > 0 ? "+" : ""}${bias} (n=${data.actual.length})`);
  }
  return lines.join("\n");
}

function renderCIcoverage(): string {
  let total = 0;
  let contained = 0;

  for (let i = 8; i < days.length; i++) {
    const day = days[i];
    const recentSleeps: SleepEntry[] = [];
    for (let j = Math.max(0, i - 7); j < i; j++) {
      recentSleeps.push(...days[j].sleeps.filter((s) => s.end_time));
    }

    const ctx: BabyContext = {
      birthdate: BIRTHDATE,
      ageMonths: calculateAgeMonths(BIRTHDATE, new Date(day.date + "T12:00:00Z")),
      tz: TZ,
      customNapCount: null,
      recentSleeps,
    };

    const predicted = predictDayNaps(day.wakeTime, ctx);
    if (predicted.length === 0) continue;

    const bedtime = day.sleeps.find((s) => s.type === "night")?.start_time
      ?? new Date(day.date + "T19:00:00Z").toISOString();
    const confidence = computeConfidence(predicted, bedtime, ctx.ageMonths, recentSleeps, TZ);
    if (!confidence) continue;

    const actualNaps = day.sleeps
      .filter((s) => s.type === "nap" && s.end_time)
      .toSorted((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

    const matchCount = Math.min(predicted.length, actualNaps.length);
    for (let k = 0; k < matchCount; k++) {
      if (!confidence.napRanges[k]) continue;
      total++;
      const actualMs = new Date(actualNaps[k].start_time).getTime();
      const loMs = new Date(confidence.napRanges[k].startRange.lo).getTime();
      const hiMs = new Date(confidence.napRanges[k].startRange.hi).getTime();
      if (actualMs >= loMs && actualMs <= hiMs) contained++;
    }
  }

  const pct = total > 0 ? Math.round(contained / total * 100) : 0;
  return `${contained}/${total} naps within ±1 SD range (${pct}%)`;
}

const cv = (arr: number[]) => {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const std = Math.sqrt(arr.reduce((sum, x) => sum + (x - mean) ** 2, 0) / arr.length);
  return Math.round(std / mean * 100);
};

const bucket = (arr: number[], lo: number, hi: number) =>
  arr.filter((d) => d >= lo && d < hi).length;

function renderDurationDistribution(): string {
  const napDurs: number[] = [];
  const nightDurs: number[] = [];

  for (const day of days) {
    for (const s of day.sleeps) {
      if (!s.end_time) continue;
      const dur = (new Date(s.end_time).getTime() - new Date(s.start_time).getTime()) / 60_000;
      if (s.type === "nap") napDurs.push(dur);
      else nightDurs.push(dur);
    }
  }

  return [
    `naps: ${napDurs.length} total, CV ${cv(napDurs)}%`,
    `  <30m: ${bucket(napDurs, 0, 30)}, 30-60m: ${bucket(napDurs, 30, 60)}, 60-90m: ${bucket(napDurs, 60, 90)}, 90m+: ${bucket(napDurs, 90, 999)}`,
    `nights: ${nightDurs.length} total, CV ${cv(nightDurs)}%`,
  ].join("\n");
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("duration and wake-time prediction", () => {
  it("overall metrics", () => {
    expect(renderDurationMetrics(result)).toMatchInlineSnapshot(`
      "82 days
      nap dur MAE: 23.5 min (bias -1.9)
      nap end MAE: 64.7 min
      wake time MAE: 46.5 min (bias -18.7)"
    `);

    expect(result.napDurationMAE).toBeLessThan(30);
    expect(result.wakeTimeMAE).toBeLessThan(55);
    expect(result.napEndMAE).toBeLessThan(75);
  });

  it("per-month metrics", () => {
    const buckets = bucketResultsByAge(result, BIRTHDATE);
    const lines = buckets.map((b) => {
      const r = b.result;
      return `${b.label}: dur MAE ${r.napDurationMAE}, wake MAE ${r.wakeTimeMAE}`;
    });
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "6mo: dur MAE 21.3, wake MAE 13.6
      7mo: dur MAE 27.4, wake MAE 31.6
      8mo: dur MAE 17.7, wake MAE 27.1
      9mo: dur MAE 29.2, wake MAE 112.1"
    `);
  });

  it("warm-up curve", () => {
    const warmup = bucketByWarmup(result);
    const lines = warmup.map((b) =>
      `${b.label}: dur MAE ${b.result.napDurationMAE}, wake MAE ${b.result.wakeTimeMAE}`,
    );
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "day 1-3: dur MAE 25.3, wake MAE 17.4
      day 4-7: dur MAE 28.3, wake MAE 33
      day 8-14: dur MAE 24.3, wake MAE 28.7
      day 15+: dur MAE 22.8, wake MAE 50.6"
    `);

    const earlyDur = warmup.find((b) => b.label === "day 1-3")!.result.napDurationMAE;
    const lateDur = warmup.find((b) => b.label === "day 15+")!.result.napDurationMAE;
    expect(lateDur).toBeLessThanOrEqual(earlyDur);
  });

  it("per-position duration (1st nap ≠ 2nd nap)", () => {
    expect(renderPositionalDurations()).toMatchInlineSnapshot(`
      "nap 1: avg 69 min actual, MAE 24.9, bias -3 (n=82)
      nap 2: avg 61 min actual, MAE 21.4, bias +0.1 (n=57)
      nap 3: avg 60 min actual, MAE 23.9, bias -13.4 (n=2)"
    `);
  });
});

describe("confidence interval coverage", () => {
  it("±1 SD ranges contain a reasonable fraction of actuals", () => {
    expect(renderCIcoverage()).toMatchInlineSnapshot(`"68/125 naps within ±1 SD range (54%)"`);

    // Ranges are ±1 SD so ~68% coverage expected if well-calibrated.
    // We accept ≥40% as a floor — below that the ranges are meaningless.
    const match = renderCIcoverage().match(/\((\d+)%\)/);
    const pct = match ? parseInt(match[1]) : 0;
    expect(pct).toBeGreaterThanOrEqual(40);
  });
});

describe("duration data characteristics", () => {
  it("distribution summary", () => {
    expect(renderDurationDistribution()).toMatchInlineSnapshot(`
      "naps: 148 total, CV 47%
        <30m: 15, 30-60m: 51, 60-90m: 56, 90m+: 26
      nights: 79 total, CV 5%"
    `);
  });
});
