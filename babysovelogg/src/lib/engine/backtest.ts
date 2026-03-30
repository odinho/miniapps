import type { SleepEntry } from "$lib/types.js";
import type { PredictedNap } from "./schedule.js";
import { predictDayNaps, recommendBedtime, calculateAgeMonths } from "./schedule.js";

/** A single day's recorded sleep data. */
export interface DayRecord {
  date: string; // YYYY-MM-DD
  wakeTime: string; // ISO — when baby woke up for the day
  sleeps: SleepEntry[]; // actual sleeps this day (naps + night)
}

/** Per-day comparison result. */
export interface DayResult {
  date: string;
  dayIndex: number; // 0-based index in the input array (how many prior days of data)
  predictedNaps: PredictedNap[];
  actualNaps: SleepEntry[];
  predictedBedtime: string;
  actualBedtime: string | null;
  napCountError: number; // predicted - actual (positive = over-predicted)
  napStartErrors: number[]; // minutes, per matched nap (positive = predicted later than actual)
  bedtimeError: number | null; // minutes (positive = predicted later than actual)
}

/** Aggregate metrics across all backtested days. */
export interface BacktestResult {
  days: DayResult[];
  totalDays: number;
  napCountAccuracy: number; // fraction of days where predicted count == actual count
  napStartMAE: number; // mean absolute error in minutes across all matched naps
  bedtimeMAE: number; // mean absolute error in minutes
  napCountBias: number; // mean signed error (positive = over-predicting nap count)
  napStartBias: number; // mean signed error (positive = predicting too late)
}

/** Predictor function signature — matches predictDayNaps interface. */
export type NapPredictor = (
  wakeUpTime: string,
  ageMonths: number,
  recentSleeps: SleepEntry[],
  customNapCount?: number | null,
  tz?: string,
) => PredictedNap[];

/** Bedtime predictor function signature. */
export type BedtimePredictor = (
  todaySleeps: SleepEntry[],
  ageMonths: number,
  customNapCount?: number | null,
  recentSleeps?: SleepEntry[],
  tz?: string,
) => string;

/**
 * Run a backtest: replay historical sleep data day-by-day, predict each day
 * using only prior data, and compare predictions to actuals.
 *
 * @param days - Chronologically ordered day records
 * @param birthdate - Baby's birthdate (ISO string)
 * @param options - Optional overrides for predictor functions and lookback window
 */
export function backtest(
  days: DayRecord[],
  birthdate: string,
  options?: {
    lookbackDays?: number;
    predict?: NapPredictor;
    predictBedtime?: BedtimePredictor;
    customNapCount?: number | null;
    tz?: string;
  },
): BacktestResult {
  const lookback = options?.lookbackDays ?? 7;
  const predict = options?.predict ?? predictDayNaps;
  const bedtimePredict = options?.predictBedtime ?? recommendBedtime;
  const customNapCount = options?.customNapCount ?? null;

  const results: DayResult[] = [];

  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const ageMonths = calculateAgeMonths(birthdate, new Date(day.date + "T12:00:00Z"));

    // Collect recent sleeps from prior days (lookback window)
    const recentSleeps: SleepEntry[] = [];
    for (let j = Math.max(0, i - lookback); j < i; j++) {
      recentSleeps.push(...days[j].sleeps.filter((s) => s.end_time));
    }

    // Need at least 1 prior day to have any learning signal
    if (i < 1) continue;

    // Predict naps
    const predictedNaps = predict(day.wakeTime, ageMonths, recentSleeps, customNapCount, options?.tz);

    // Predict bedtime using today's actual nap data (as if naps happened)
    const actualNaps = day.sleeps.filter((s) => s.type === "nap" && s.end_time);
    const predictedBedtime = bedtimePredict(actualNaps, ageMonths, customNapCount, recentSleeps, options?.tz);

    // Find actual bedtime (tonight's night sleep start)
    const nightSleep = day.sleeps.find((s) => s.type === "night");
    const actualBedtime = nightSleep?.start_time ?? null;

    // Match predicted naps to actual naps by order
    const napStartErrors: number[] = [];
    const matchCount = Math.min(predictedNaps.length, actualNaps.length);
    for (let k = 0; k < matchCount; k++) {
      const predictedStart = new Date(predictedNaps[k].startTime).getTime();
      const actualStart = new Date(actualNaps[k].start_time).getTime();
      napStartErrors.push((predictedStart - actualStart) / 60000);
    }

    // Bedtime error — only score when we have both naps and a bedtime.
    // Without naps, the predictor falls back to "19:00 today" which uses
    // the current date (wrong for historical backtest days).
    let bedtimeError: number | null = null;
    if (actualBedtime && actualNaps.length > 0) {
      bedtimeError =
        (new Date(predictedBedtime).getTime() - new Date(actualBedtime).getTime()) / 60000;
    }

    results.push({
      date: day.date,
      dayIndex: i,
      predictedNaps,
      actualNaps,
      predictedBedtime,
      actualBedtime,
      napCountError: predictedNaps.length - actualNaps.length,
      napStartErrors,
      bedtimeError,
    });
  }

  return summarize(results);
}

function summarize(days: DayResult[]): BacktestResult {
  const totalDays = days.length;
  if (totalDays === 0) {
    return {
      days,
      totalDays: 0,
      napCountAccuracy: 0,
      napStartMAE: 0,
      bedtimeMAE: 0,
      napCountBias: 0,
      napStartBias: 0,
    };
  }

  // Nap count accuracy
  const napCountCorrect = days.filter((d) => d.napCountError === 0).length;
  const napCountAccuracy = napCountCorrect / totalDays;

  // Nap start errors (across all matched naps)
  const allStartErrors = days.flatMap((d) => d.napStartErrors);
  const napStartMAE =
    allStartErrors.length > 0
      ? allStartErrors.reduce((sum, e) => sum + Math.abs(e), 0) / allStartErrors.length
      : 0;
  const napStartBias =
    allStartErrors.length > 0
      ? allStartErrors.reduce((sum, e) => sum + e, 0) / allStartErrors.length
      : 0;

  // Bedtime errors
  const bedtimeErrors = days.map((d) => d.bedtimeError).filter((e): e is number => e !== null);
  const bedtimeMAE =
    bedtimeErrors.length > 0
      ? bedtimeErrors.reduce((sum, e) => sum + Math.abs(e), 0) / bedtimeErrors.length
      : 0;

  // Nap count bias
  const napCountBias = days.reduce((sum, d) => sum + d.napCountError, 0) / totalDays;

  return {
    days,
    totalDays,
    napCountAccuracy,
    napStartMAE: Math.round(napStartMAE * 10) / 10,
    bedtimeMAE: Math.round(bedtimeMAE * 10) / 10,
    napCountBias: Math.round(napCountBias * 100) / 100,
    napStartBias: Math.round(napStartBias * 10) / 10,
  };
}

/**
 * Split a full BacktestResult into per-month age buckets.
 * Runs on the RESULTS, not the input — so each day retains its full lookback.
 */
export function bucketResultsByAge(
  result: BacktestResult,
  birthdate: string,
): { label: string; result: BacktestResult }[] {
  const byMonth = new Map<number, DayResult[]>();

  for (const day of result.days) {
    const age = calculateAgeMonths(birthdate, new Date(day.date + "T12:00:00Z"));
    if (!byMonth.has(age)) byMonth.set(age, []);
    byMonth.get(age)!.push(day);
  }

  return [...byMonth.entries()]
    .toSorted(([a], [b]) => a - b)
    .map(([age, days]) => ({
      label: `${age}mo`,
      result: summarize(days),
    }));
}

/**
 * Split results by how many prior days of data were available.
 * Shows cold-start penalty and how quickly predictions stabilize.
 */
export function bucketByWarmup(
  result: BacktestResult,
  brackets: [number, number][] = [[1, 3], [4, 7], [8, 14], [15, Infinity]],
): { label: string; result: BacktestResult }[] {
  return brackets
    .map(([lo, hi]) => {
      const days = result.days.filter((d) => d.dayIndex >= lo && d.dayIndex <= hi);
      return {
        label: hi === Infinity ? `day ${lo}+` : `day ${lo}-${hi}`,
        result: summarize(days),
      };
    })
    .filter((b) => b.result.totalDays > 0);
}

/** Compact one-line summary for snapshot assertions. */
export function renderSummary(result: BacktestResult, label: string): string {
  const pct = Math.round(result.napCountAccuracy * 100);
  const correct = result.days.filter((d) => d.napCountError === 0).length;
  return [
    `${label}:`,
    `${result.totalDays} days,`,
    `count ${pct}% (${correct}/${result.totalDays}),`,
    `nap MAE ${result.napStartMAE} min,`,
    `bed MAE ${result.bedtimeMAE} min,`,
    `nap bias ${result.napStartBias > 0 ? "+" : ""}${result.napStartBias},`,
    `count bias ${result.napCountBias > 0 ? "+" : ""}${result.napCountBias}`,
  ].join(" ");
}

/** Format a backtest result as a human-readable report string. */
export function formatReport(result: BacktestResult, label?: string): string {
  const lines: string[] = [];
  const hdr = label ?? "Backtest";
  lines.push(`${hdr} (${result.totalDays} days)`);
  lines.push("═".repeat(50));

  for (const day of result.days) {
    const actual = day.actualNaps.length;
    const predicted = day.predictedNaps.length;
    const countOk = day.napCountError === 0 ? "✓" : "✗";
    lines.push(
      `${day.date}: ${countOk} predicted ${predicted} naps, actual ${actual}`,
    );

    for (let i = 0; i < day.napStartErrors.length; i++) {
      const err = day.napStartErrors[i];
      const pStart = day.predictedNaps[i].startTime.slice(11, 16);
      const aStart = day.actualNaps[i].start_time.slice(11, 16);
      const sign = err >= 0 ? "+" : "";
      lines.push(`  Nap ${i + 1}: predicted ${pStart}, actual ${aStart} → ${sign}${Math.round(err)} min`);
    }

    if (day.bedtimeError !== null) {
      const pBed = day.predictedBedtime.slice(11, 16);
      const aBed = day.actualBedtime!.slice(11, 16);
      const sign = day.bedtimeError >= 0 ? "+" : "";
      lines.push(`  Bedtime: predicted ${pBed}, actual ${aBed} → ${sign}${Math.round(day.bedtimeError)} min`);
    }
  }

  lines.push("═".repeat(50));
  lines.push(`Nap count accuracy: ${Math.round(result.napCountAccuracy * 100)}% (${result.days.filter((d) => d.napCountError === 0).length}/${result.totalDays})`);
  lines.push(`Nap start MAE: ${result.napStartMAE} min`);
  lines.push(`Nap start bias: ${result.napStartBias > 0 ? "+" : ""}${result.napStartBias} min (positive = predicting too late)`);
  lines.push(`Bedtime MAE: ${result.bedtimeMAE} min`);
  lines.push(`Nap count bias: ${result.napCountBias > 0 ? "+" : ""}${result.napCountBias} (positive = over-predicting)`);

  return lines.join("\n");
}
