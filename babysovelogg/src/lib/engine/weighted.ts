/**
 * Weighted recency predictor — exponential decay instead of flat 7-day average.
 *
 * Backtest-only for now. Risk of overfitting to noise with small datasets.
 * Compare against the flat-average engine to see if it helps.
 */

import { WAKE_WINDOWS, NAP_COUNTS, findByAge } from "./constants.js";
import type { PredictedNap } from "./schedule.js";
import type { SleepEntry } from "$lib/types.js";
import { isoToDateInTz } from "$lib/tz.js";

const DECAY = 0.85; // Weight halves roughly every 4 days

export function weightedNaps(
  wakeUpTime: string,
  ageMonths: number,
  recentSleeps: SleepEntry[],
  customNapCount?: number | null,
  tz?: string,
): PredictedNap[] {
  const timezone = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const napCount = customNapCount ?? learnNapCountWeighted(recentSleeps, timezone) ?? findByAge(NAP_COUNTS, ageMonths).naps;
  const ww = learnWakeWindowWeighted(recentSleeps, ageMonths, timezone);
  const napDur = learnNapDurationWeighted(recentSleeps, ageMonths);
  const positionalWWs = learnPositionalWWsWeighted(recentSleeps, ageMonths, timezone);

  const predictions: PredictedNap[] = [];
  let currentWake = new Date(wakeUpTime);

  for (let i = 0; i < napCount; i++) {
    const posWW = positionalWWs[i] ?? ww;
    const napStart = new Date(currentWake.getTime() + posWW * 60_000);
    const napEnd = new Date(napStart.getTime() + napDur * 60_000);
    predictions.push({ startTime: napStart.toISOString(), endTime: napEnd.toISOString() });
    currentWake = napEnd;
  }

  return predictions;
}

export function weightedBedtime(
  todaySleeps: SleepEntry[],
  ageMonths: number,
  customNapCount?: number | null,
  recentSleeps?: SleepEntry[],
  _tz?: string,
): string {
  const lastSleep = [...todaySleeps]
    .filter((s) => s.end_time)
    .toSorted((a, b) => new Date(b.end_time!).getTime() - new Date(a.end_time!).getTime())[0];

  if (!lastSleep?.end_time) {
    const ref = todaySleeps[0]?.start_time ?? new Date().toISOString();
    return new Date(`${ref.slice(0, 10)}T19:00:00Z`).toISOString();
  }

  const bedtimeWW = learnBedtimeWWWeighted(recentSleeps, ageMonths);
  const targetNaps = customNapCount ?? findByAge(NAP_COUNTS, ageMonths).naps;
  const hasEnoughNaps = todaySleeps.filter((s) => s.type === "nap" && s.end_time).length >= targetNaps;
  const multiplier = hasEnoughNaps ? 1.0 : 0.85;

  return new Date(
    new Date(lastSleep.end_time).getTime() + bedtimeWW * multiplier * 60_000,
  ).toISOString();
}

// ─── Weighted learning functions ─────────────────────────────────────────────

function weightedMean(values: { value: number; date: string }[], latestDate: string): number | null {
  if (values.length === 0) return null;
  let sumWeighted = 0, sumWeights = 0;
  for (const { value, date } of values) {
    const daysAgo = daysBetween(date, latestDate);
    const weight = Math.pow(DECAY, daysAgo);
    sumWeighted += value * weight;
    sumWeights += weight;
  }
  return sumWeights > 0 ? sumWeighted / sumWeights : null;
}

function learnWakeWindowWeighted(
  recentSleeps: SleepEntry[],
  ageMonths: number,
  tz: string,
): number {
  const range = findByAge(WAKE_WINDOWS, ageMonths);
  const defaultWW = (range.minMinutes + range.maxMinutes) / 2;

  if (recentSleeps.length < 2) return defaultWW;

  const sorted = [...recentSleeps]
    .filter((s) => s.end_time)
    .toSorted((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  const entries: { value: number; date: string }[] = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].type !== "nap") continue;
    const gapMin = (new Date(sorted[i].start_time).getTime() - new Date(sorted[i - 1].end_time!).getTime()) / 60_000;
    if (gapMin >= 10 && gapMin <= 480) {
      entries.push({ value: gapMin, date: isoToDateInTz(sorted[i].start_time, tz) });
    }
  }

  if (entries.length < 2) return defaultWW;
  const latest = entries.toSorted((a, b) => b.date.localeCompare(a.date))[0].date;
  const avg = weightedMean(entries, latest);
  if (avg === null) return defaultWW;

  return Math.max(range.minMinutes, Math.min(range.maxMinutes, avg));
}

function learnPositionalWWsWeighted(
  recentSleeps: SleepEntry[],
  ageMonths: number,
  tz: string,
): number[] {
  if (recentSleeps.length < 4) return [];

  const byDay = new Map<string, SleepEntry[]>();
  for (const s of recentSleeps) {
    if (!s.end_time) continue;
    const day = isoToDateInTz(s.start_time, tz);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(s);
  }

  const gapsByPosition = new Map<number, { value: number; date: string }[]>();
  for (const [day, daySleeps] of byDay) {
    const sorted = daySleeps.toSorted(
      (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime(),
    );
    let napPos = 0;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].type !== "nap") continue;
      const gapMin = (new Date(sorted[i].start_time).getTime() - new Date(sorted[i - 1].end_time!).getTime()) / 60_000;
      if (gapMin >= 10 && gapMin <= 480) {
        if (!gapsByPosition.has(napPos)) gapsByPosition.set(napPos, []);
        gapsByPosition.get(napPos)!.push({ value: gapMin, date: day });
      }
      napPos++;
    }
  }

  const range = findByAge(WAKE_WINDOWS, ageMonths);
  const allDates = [...byDay.keys()].toSorted();
  const latest = allDates[allDates.length - 1];
  const result: number[] = [];

  for (const [pos, entries] of gapsByPosition) {
    if (entries.length < 2) continue;
    const avg = weightedMean(entries, latest);
    if (avg !== null) {
      result[pos] = Math.round(Math.max(range.minMinutes, Math.min(range.maxMinutes, avg)));
    }
  }

  return result;
}

function learnNapDurationWeighted(recentSleeps: SleepEntry[], ageMonths: number): number {
  const defaultDur = ageMonths < 6 ? 60 : ageMonths < 12 ? 45 : 30;
  const naps = recentSleeps.filter((s) => s.type === "nap" && s.end_time);
  if (naps.length < 3) return defaultDur;

  const entries = naps
    .map((s) => ({
      value: (new Date(s.end_time!).getTime() - new Date(s.start_time).getTime()) / 60_000,
      date: s.start_time.slice(0, 10),
    }))
    .filter((e) => e.value >= 10 && e.value <= 180);

  if (entries.length < 3) return defaultDur;
  const latest = entries.toSorted((a, b) => b.date.localeCompare(a.date))[0].date;
  return Math.round(weightedMean(entries, latest) ?? defaultDur);
}

function learnBedtimeWWWeighted(recentSleeps?: SleepEntry[], ageMonths?: number): number {
  const defaultWW = ageMonths != null
    ? (findByAge(WAKE_WINDOWS, ageMonths).minMinutes + findByAge(WAKE_WINDOWS, ageMonths).maxMinutes) / 2 * 1.15
    : 210;

  if (!recentSleeps || recentSleeps.length < 4) return defaultWW;

  const sorted = [...recentSleeps]
    .filter((s) => s.end_time)
    .toSorted((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  const entries: { value: number; date: string }[] = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].type !== "night" || sorted[i - 1].type !== "nap") continue;
    const gapMin = (new Date(sorted[i].start_time).getTime() - new Date(sorted[i - 1].end_time!).getTime()) / 60_000;
    if (gapMin >= 60 && gapMin <= 600) {
      entries.push({ value: gapMin, date: sorted[i].start_time.slice(0, 10) });
    }
  }

  if (entries.length < 2) return defaultWW;
  const latest = entries.toSorted((a, b) => b.date.localeCompare(a.date))[0].date;
  return weightedMean(entries, latest) ?? defaultWW;
}

function learnNapCountWeighted(recentSleeps: SleepEntry[], tz: string): number | null {
  if (recentSleeps.length < 4) return null;
  const napsByDay = new Map<string, number>();
  for (const s of recentSleeps) {
    if (s.type !== "nap" || !s.end_time) continue;
    const day = isoToDateInTz(s.start_time, tz);
    napsByDay.set(day, (napsByDay.get(day) ?? 0) + 1);
  }
  if (napsByDay.size < 3) return null;

  const sortedDays = [...napsByDay.entries()].toSorted(([a], [b]) => a.localeCompare(b));
  const latest = sortedDays[sortedDays.length - 1][0];
  const freq = new Map<number, number>();
  let totalWeight = 0;

  for (const [day, count] of sortedDays) {
    const daysAgo = daysBetween(day, latest);
    const weight = Math.pow(DECAY, daysAgo);
    freq.set(count, (freq.get(count) ?? 0) + weight);
    totalWeight += weight;
  }

  let best = 0, bestScore = 0;
  for (const [count, score] of freq) {
    if (score > bestScore) { best = count; bestScore = score; }
  }

  return bestScore / totalWeight > 0.4 ? best : null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function daysBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA + "T00:00:00Z").getTime();
  const b = new Date(dateB + "T00:00:00Z").getTime();
  return Math.round(Math.abs(b - a) / 86_400_000);
}
