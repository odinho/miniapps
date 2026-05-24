/**
 * Intra-day backtest: after each completed nap, predict the next nap start.
 *
 * Unlike the day-ahead backtest (which predicts all naps at wake-up),
 * this replays each nap sequentially and measures how well the engine
 * predicts the next one given what actually happened.
 *
 * This is the right harness for testing nap-quality adjustments:
 * does knowing the previous nap's duration improve the next prediction?
 */

import type { SleepEntry, BabyContext } from "$lib/types.js";
import { calculateAgeMonths, getWakeWindow } from "./schedule.js";
import type { DayRecord } from "./backtest.js";

export interface IntradayPrediction {
  date: string;
  napIndex: number; // which nap we're predicting (0-based)
  prevNapDuration: number; // minutes
  actualGap: number; // actual gap from prev nap end to this nap start (minutes)
  predictedGap: number; // what the engine predicted (minutes)
  error: number; // predicted - actual (positive = predicted too late)
}

export interface IntradayResult {
  predictions: IntradayPrediction[];
  mae: number;
  bias: number;
  count: number;
}

/** Strategy for predicting the next wake window. */
export type IntradayStrategy = (
  baseWW: number,
  prevNapDurationMin: number,
) => number;

/** No adjustment — always use the base wake window. */
export const noAdjustment: IntradayStrategy = (baseWW) => baseWW;

/** Nap quality adjustment hypothesis (short → shorter, long → longer).
 * Tested and rejected: doesn't improve predictions on Halldis data. */
export const napQualityAdjustment: IntradayStrategy = (baseWW, napDur) => {
  if (napDur <= 30) return Math.round(baseWW * 0.85);
  if (napDur >= 90) return Math.round(baseWW * 1.10);
  return baseWW;
};

/**
 * Run the intra-day backtest.
 *
 * For each day with 2+ naps, after each nap ends, predict when the next
 * nap will start. Compare predicted gap to actual gap.
 */
export function intradayBacktest(
  days: DayRecord[],
  birthdate: string,
  strategy: IntradayStrategy,
  options?: { lookbackDays?: number; tz?: string },
): IntradayResult {
  const lookback = options?.lookbackDays ?? 7;
  const tz = options?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const predictions: IntradayPrediction[] = [];

  for (let i = 1; i < days.length; i++) {
    const day = days[i];
    const ageMonths = calculateAgeMonths(birthdate, new Date(day.date + "T12:00:00Z"));

    // Collect recent sleeps from prior days
    const recentSleeps: SleepEntry[] = [];
    for (let j = Math.max(0, i - lookback); j < i; j++) {
      recentSleeps.push(...days[j].sleeps.filter((s) => s.end_time));
    }
    // Cycle estimator window mirrors prod's 180d window. All-prior-history
    // is fine here — backtests stay below 180 days for most fixtures.
    const cycleSleeps: SleepEntry[] = [];
    for (let j = 0; j < i; j++) {
      cycleSleeps.push(...days[j].sleeps.filter((s) => s.end_time));
    }

    const ctx: BabyContext = {
      birthdate,
      ageMonths,
      tz,
      customNapCount: null,
      recentSleeps,
      cycleSleeps,
    };

    // Get the day's naps in order
    const naps = day.sleeps
      .filter((s) => s.type === "nap" && s.end_time)
      .toSorted((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

    if (naps.length < 2) continue;

    // Base wake window from the engine (learned from recent data)
    const baseWW = getWakeWindow(ctx);

    // For each consecutive nap pair, predict the gap
    for (let n = 0; n < naps.length - 1; n++) {
      const prevNap = naps[n];
      const nextNap = naps[n + 1];

      const prevEnd = new Date(prevNap.end_time!).getTime();
      const nextStart = new Date(nextNap.start_time).getTime();
      const actualGap = (nextStart - prevEnd) / 60_000;

      // Skip unreasonable gaps
      if (actualGap < 10 || actualGap > 480) continue;

      const prevDuration = (new Date(prevNap.end_time!).getTime() - new Date(prevNap.start_time).getTime()) / 60_000;
      const predictedGap = strategy(baseWW, prevDuration);

      predictions.push({
        date: day.date,
        napIndex: n + 1,
        prevNapDuration: Math.round(prevDuration),
        actualGap: Math.round(actualGap),
        predictedGap: Math.round(predictedGap),
        error: Math.round(predictedGap - actualGap),
      });
    }
  }

  const count = predictions.length;
  const mae = count > 0
    ? Math.round(predictions.reduce((sum, p) => sum + Math.abs(p.error), 0) / count * 10) / 10
    : 0;
  const bias = count > 0
    ? Math.round(predictions.reduce((sum, p) => sum + p.error, 0) / count * 10) / 10
    : 0;

  return { predictions, mae, bias, count };
}

/**
 * Split results by previous nap duration bucket.
 * Shows whether the strategy helps more for short vs long naps.
 */
export function bucketByNapDuration(
  result: IntradayResult,
): { label: string; mae: number; bias: number; count: number }[] {
  const buckets = [
    { label: "short (≤30m)", filter: (p: IntradayPrediction) => p.prevNapDuration <= 30 },
    { label: "normal (31-89m)", filter: (p: IntradayPrediction) => p.prevNapDuration > 30 && p.prevNapDuration < 90 },
    { label: "long (≥90m)", filter: (p: IntradayPrediction) => p.prevNapDuration >= 90 },
  ];

  return buckets.map(({ label, filter }) => {
    const preds = result.predictions.filter(filter);
    const count = preds.length;
    const mae = count > 0
      ? Math.round(preds.reduce((sum, p) => sum + Math.abs(p.error), 0) / count * 10) / 10
      : 0;
    const bias = count > 0
      ? Math.round(preds.reduce((sum, p) => sum + p.error, 0) / count * 10) / 10
      : 0;
    return { label, mae, bias, count };
  }).filter((b) => b.count > 0);
}
