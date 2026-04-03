/**
 * Trivial baseline predictors for backtest comparison.
 *
 * If the main engine can't consistently beat these, it's too complex for its gain.
 * Compare per-month, not just aggregate.
 */

import { WAKE_WINDOWS, NAP_COUNTS, SLEEP_NEEDS, findByAge } from "./constants.js";
import type { PredictedNap } from "./schedule.js";
import type { SleepEntry, BabyContext } from "$lib/types.js";
import { isoToDateInTz } from "$lib/tz.js";

// ─── Age-default-only ────────────────────────────────────────────────────────
// Uses only age-based constants, ignores all recent sleep data.

export function ageDefaultNaps(wakeUpTime: string, ctx: BabyContext): PredictedNap[] {
  const range = findByAge(WAKE_WINDOWS, ctx.ageMonths);
  const ww = (range.minMinutes + range.maxMinutes) / 2;
  const napCount = ctx.customNapCount ?? findByAge(NAP_COUNTS, ctx.ageMonths).naps;
  const napDuration = ctx.ageMonths < 6 ? 60 : ctx.ageMonths < 12 ? 45 : 30;

  const predictions: PredictedNap[] = [];
  let currentWake = new Date(wakeUpTime);

  for (let i = 0; i < napCount; i++) {
    const napStart = new Date(currentWake.getTime() + ww * 60_000);
    const napEnd = new Date(napStart.getTime() + napDuration * 60_000);
    predictions.push({ startTime: napStart.toISOString(), endTime: napEnd.toISOString() });
    currentWake = napEnd;
  }

  return predictions;
}

export function ageDefaultBedtime(todaySleeps: SleepEntry[], ctx: BabyContext): string {
  const range = findByAge(WAKE_WINDOWS, ctx.ageMonths);
  const ww = (range.minMinutes + range.maxMinutes) / 2 * 1.15;

  const lastSleep = [...todaySleeps]
    .filter((s) => s.end_time)
    .toSorted((a, b) => new Date(b.end_time!).getTime() - new Date(a.end_time!).getTime())[0];

  if (!lastSleep?.end_time) {
    const ref = todaySleeps[0]?.start_time ?? new Date().toISOString();
    return new Date(`${ref.slice(0, 10)}T19:00:00Z`).toISOString();
  }

  return new Date(new Date(lastSleep.end_time).getTime() + ww * 60_000).toISOString();
}

// ─── Yesterday-repeated ──────────────────────────────────────────────────────

export function yesterdayRepeatedNaps(wakeUpTime: string, ctx: BabyContext): PredictedNap[] {
  const todayDate = isoToDateInTz(wakeUpTime, ctx.tz);

  const yesterdayNaps = ctx.recentSleeps
    .filter((s) => {
      if (s.type !== "nap" || !s.end_time) return false;
      return daysBetween(isoToDateInTz(s.start_time, ctx.tz), todayDate) === 1;
    })
    .toSorted((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  if (yesterdayNaps.length === 0) return ageDefaultNaps(wakeUpTime, ctx);

  const todayWakeMs = new Date(wakeUpTime).getTime();
  const firstNapStart = new Date(yesterdayNaps[0].start_time).getTime();
  const yesterdayWakeMs = findYesterdayWake(ctx.recentSleeps, todayDate, ctx.tz) ?? firstNapStart - 120 * 60_000;
  const dayOffset = todayWakeMs - yesterdayWakeMs;

  return yesterdayNaps.map((nap) => ({
    startTime: new Date(new Date(nap.start_time).getTime() + dayOffset).toISOString(),
    endTime: new Date(new Date(nap.end_time!).getTime() + dayOffset).toISOString(),
  }));
}

export function yesterdayRepeatedBedtime(todaySleeps: SleepEntry[], ctx: BabyContext): string {
  if (ctx.recentSleeps.length === 0) return ageDefaultBedtime(todaySleeps, ctx);

  const sorted = [...ctx.recentSleeps]
    .filter((s) => s.type === "night" && s.start_time)
    .toSorted((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime());

  if (sorted.length === 0) return ageDefaultBedtime(todaySleeps, ctx);

  const lastBedtime = new Date(sorted[0].start_time);
  const todayRef = todaySleeps[0]?.start_time ?? sorted[0].start_time;
  const timeOfDay = lastBedtime.toISOString().slice(11);
  return new Date(`${todayRef.slice(0, 10)}T${timeOfDay}`).toISOString();
}

// ─── 3-day moving average ────────────────────────────────────────────────────

export function movingAvgNaps(wakeUpTime: string, ctx: BabyContext): PredictedNap[] {
  const todayDate = isoToDateInTz(wakeUpTime, ctx.tz);

  const dayNaps = new Map<string, SleepEntry[]>();
  for (const s of ctx.recentSleeps) {
    if (s.type !== "nap" || !s.end_time) continue;
    const day = isoToDateInTz(s.start_time, ctx.tz);
    const dist = daysBetween(day, todayDate);
    if (dist >= 1 && dist <= 3) {
      if (!dayNaps.has(day)) dayNaps.set(day, []);
      dayNaps.get(day)!.push(s);
    }
  }

  if (dayNaps.size === 0) return ageDefaultNaps(wakeUpTime, ctx);

  const dayOffsets: { offsets: number[]; durations: number[] }[] = [];
  for (const [day, naps] of dayNaps) {
    const sorted = naps.toSorted(
      (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime(),
    );
    const dayWakeMs = findWakeForDate(ctx.recentSleeps, day, ctx.tz)
      ?? new Date(sorted[0].start_time).getTime() - 120 * 60_000;
    dayOffsets.push({
      offsets: sorted.map((n) => (new Date(n.start_time).getTime() - dayWakeMs) / 60_000),
      durations: sorted.map((n) => (new Date(n.end_time!).getTime() - new Date(n.start_time).getTime()) / 60_000),
    });
  }

  const avgNapCount = Math.round(
    dayOffsets.reduce((sum, d) => sum + d.offsets.length, 0) / dayOffsets.length,
  );
  if (avgNapCount === 0) return ageDefaultNaps(wakeUpTime, ctx);

  const todayWakeMs = new Date(wakeUpTime).getTime();
  const predictions: PredictedNap[] = [];

  for (let i = 0; i < avgNapCount; i++) {
    const posOffsets = dayOffsets.filter((d) => d.offsets.length > i).map((d) => d.offsets[i]);
    const posDurations = dayOffsets.filter((d) => d.durations.length > i).map((d) => d.durations[i]);
    if (posOffsets.length === 0) break;

    const avgOffset = posOffsets.reduce((a, b) => a + b, 0) / posOffsets.length;
    const avgDuration = posDurations.length > 0
      ? posDurations.reduce((a, b) => a + b, 0) / posDurations.length : 45;

    const napStart = new Date(todayWakeMs + avgOffset * 60_000);
    const napEnd = new Date(napStart.getTime() + avgDuration * 60_000);
    predictions.push({ startTime: napStart.toISOString(), endTime: napEnd.toISOString() });
  }

  return predictions;
}

export function movingAvgBedtime(todaySleeps: SleepEntry[], ctx: BabyContext): string {
  if (ctx.recentSleeps.length === 0) return ageDefaultBedtime(todaySleeps, ctx);

  const sorted = [...ctx.recentSleeps]
    .filter((s) => s.end_time)
    .toSorted((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].type !== "night" || sorted[i - 1].type !== "nap") continue;
    const gapMin = (new Date(sorted[i].start_time).getTime() - new Date(sorted[i - 1].end_time!).getTime()) / 60_000;
    if (gapMin >= 60 && gapMin <= 600) gaps.push(gapMin);
  }

  const recent = gaps.slice(-3);
  if (recent.length === 0) return ageDefaultBedtime(todaySleeps, ctx);

  const avgGap = recent.reduce((a, b) => a + b, 0) / recent.length;
  const lastSleep = [...todaySleeps]
    .filter((s) => s.end_time)
    .toSorted((a, b) => new Date(b.end_time!).getTime() - new Date(a.end_time!).getTime())[0];

  if (!lastSleep?.end_time) {
    const ref = todaySleeps[0]?.start_time ?? ctx.recentSleeps[ctx.recentSleeps.length - 1]?.start_time ?? new Date().toISOString();
    return new Date(`${ref.slice(0, 10)}T19:00:00Z`).toISOString();
  }

  return new Date(new Date(lastSleep.end_time).getTime() + avgGap * 60_000).toISOString();
}

// ─── Wake time baselines ────────────────────────────────────────────────────

/** Age-default night duration: bedtime + expected night hours from SLEEP_NEEDS. */
export function ageDefaultWakeTime(bedtime: string, ctx: BabyContext, _todayNapMin: number): string {
  const need = findByAge(SLEEP_NEEDS, ctx.ageMonths);
  const napCount = findByAge(NAP_COUNTS, ctx.ageMonths).naps;
  const napDur = ctx.ageMonths < 6 ? 60 : ctx.ageMonths < 12 ? 45 : 30;
  const nightMin = (need.totalHours * 60) - (napDur * napCount);
  return new Date(new Date(bedtime).getTime() + nightMin * 60_000).toISOString();
}

/** Yesterday-repeated: apply yesterday's actual wake time to tomorrow. */
export function yesterdayRepeatedWakeTime(bedtime: string, ctx: BabyContext, _todayNapMin: number): string {
  // Find the most recent night end time
  const nights = ctx.recentSleeps
    .filter((s) => s.type === "night" && s.end_time)
    .toSorted((a, b) => new Date(b.end_time!).getTime() - new Date(a.end_time!).getTime());

  if (nights.length === 0) return ageDefaultWakeTime(bedtime, ctx, _todayNapMin);

  // Apply yesterday's wake hour to tomorrow's date
  const lastWake = new Date(nights[0].end_time!);
  const tomorrowDate = new Date(new Date(bedtime).getTime() + 12 * 3600_000)
    .toISOString().slice(0, 10);
  const timeOfDay = lastWake.toISOString().slice(11);
  return new Date(`${tomorrowDate}T${timeOfDay}`).toISOString();
}

/** 3-day moving average of wake times. */
export function movingAvgWakeTime(bedtime: string, ctx: BabyContext, _todayNapMin: number): string {
  const nights = ctx.recentSleeps
    .filter((s) => s.type === "night" && s.end_time)
    .toSorted((a, b) => new Date(b.end_time!).getTime() - new Date(a.end_time!).getTime())
    .slice(0, 3);

  if (nights.length === 0) return ageDefaultWakeTime(bedtime, ctx, _todayNapMin);

  // Average the time-of-day portion (minutes since midnight UTC)
  const avgMinutes = nights.reduce((sum, n) => {
    const d = new Date(n.end_time!);
    return sum + d.getUTCHours() * 60 + d.getUTCMinutes();
  }, 0) / nights.length;

  const tomorrowDate = new Date(new Date(bedtime).getTime() + 12 * 3600_000)
    .toISOString().slice(0, 10);
  const h = String(Math.floor(avgMinutes / 60)).padStart(2, "0");
  const m = String(Math.round(avgMinutes % 60)).padStart(2, "0");
  return new Date(`${tomorrowDate}T${h}:${m}:00.000Z`).toISOString();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function daysBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA + "T00:00:00Z").getTime();
  const b = new Date(dateB + "T00:00:00Z").getTime();
  return Math.round(Math.abs(b - a) / 86_400_000);
}

function findYesterdayWake(sleeps: SleepEntry[], todayDate: string, tz: string): number | null {
  const yesterday = new Date(todayDate + "T00:00:00Z");
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return findWakeForDate(sleeps, yesterday.toISOString().slice(0, 10), tz);
}

function findWakeForDate(sleeps: SleepEntry[], dateStr: string, tz: string): number | null {
  for (const s of sleeps) {
    if (s.type !== "night" || !s.end_time) continue;
    if (isoToDateInTz(s.end_time, tz) === dateStr) return new Date(s.end_time).getTime();
  }
  return null;
}
