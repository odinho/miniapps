/**
 * Trivial baseline predictors for backtest comparison.
 *
 * If the main engine can't consistently beat these, it's too complex for its gain.
 * Compare per-month, not just aggregate.
 */

import { WAKE_WINDOWS, NAP_COUNTS, findByAge } from "./constants.js";
import type { PredictedNap } from "./schedule.js";
import type { SleepEntry } from "$lib/types.js";
import { isoToDateInTz } from "$lib/tz.js";

// ─── Age-default-only ────────────────────────────────────────────────────────
// Uses only age-based constants, ignores all recent sleep data.

export function ageDefaultNaps(
  wakeUpTime: string,
  ageMonths: number,
  _recentSleeps: SleepEntry[],
  customNapCount?: number | null,
  _tz?: string,
): PredictedNap[] {
  const range = findByAge(WAKE_WINDOWS, ageMonths);
  const ww = (range.minMinutes + range.maxMinutes) / 2;
  const napCount = customNapCount ?? findByAge(NAP_COUNTS, ageMonths).naps;
  const napDuration = ageMonths < 6 ? 60 : ageMonths < 12 ? 45 : 30;

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

export function ageDefaultBedtime(
  todaySleeps: SleepEntry[],
  ageMonths: number,
  _customNapCount?: number | null,
  _recentSleeps?: SleepEntry[],
  _tz?: string,
): string {
  const range = findByAge(WAKE_WINDOWS, ageMonths);
  const ww = (range.minMinutes + range.maxMinutes) / 2 * 1.15; // bedtime WW is ~15% longer

  const lastSleep = [...todaySleeps]
    .filter((s) => s.end_time)
    .toSorted((a, b) => new Date(b.end_time!).getTime() - new Date(a.end_time!).getTime())[0];

  if (!lastSleep?.end_time) {
    // No sleeps — derive a 19:00 bedtime from today's nap date or fall back
    const ref = todaySleeps[0]?.start_time ?? new Date().toISOString();
    const dateStr = ref.slice(0, 10);
    return new Date(`${dateStr}T19:00:00Z`).toISOString();
  }

  return new Date(new Date(lastSleep.end_time).getTime() + ww * 60_000).toISOString();
}

// ─── Yesterday-repeated ──────────────────────────────────────────────────────
// Copies yesterday's actual nap times (shifted to today's date).
// Cold start: falls back to age-default.

export function yesterdayRepeatedNaps(
  wakeUpTime: string,
  ageMonths: number,
  recentSleeps: SleepEntry[],
  customNapCount?: number | null,
  tz?: string,
): PredictedNap[] {
  const timezone = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const todayDate = isoToDateInTz(wakeUpTime, timezone);

  // Find yesterday's naps
  const yesterdayNaps = recentSleeps
    .filter((s) => {
      if (s.type !== "nap" || !s.end_time) return false;
      const day = isoToDateInTz(s.start_time, timezone);
      return daysBetween(day, todayDate) === 1;
    })
    .toSorted((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  if (yesterdayNaps.length === 0) {
    return ageDefaultNaps(wakeUpTime, ageMonths, recentSleeps, customNapCount, tz);
  }

  // Shift yesterday's nap offsets-from-wake to today
  const todayWakeMs = new Date(wakeUpTime).getTime();

  // Find yesterday's effective wake time (start of first gap before first nap)
  // Approximate: use start of first nap minus first wake window
  const firstNapStart = new Date(yesterdayNaps[0].start_time).getTime();

  // Find yesterday's wake-up: look for night sleep ending that day or just use first nap start
  const yesterdayWakeMs = findYesterdayWake(recentSleeps, todayDate, timezone) ?? firstNapStart - 120 * 60_000;
  const dayOffset = todayWakeMs - yesterdayWakeMs;

  return yesterdayNaps.map((nap) => ({
    startTime: new Date(new Date(nap.start_time).getTime() + dayOffset).toISOString(),
    endTime: new Date(new Date(nap.end_time!).getTime() + dayOffset).toISOString(),
  }));
}

export function yesterdayRepeatedBedtime(
  todaySleeps: SleepEntry[],
  ageMonths: number,
  customNapCount?: number | null,
  recentSleeps?: SleepEntry[],
  tz?: string,
): string {
  if (!recentSleeps || recentSleeps.length === 0) {
    return ageDefaultBedtime(todaySleeps, ageMonths, customNapCount, recentSleeps, tz);
  }

  // Find the most recent night sleep start (= most recent bedtime)
  const sorted = [...recentSleeps]
    .filter((s) => s.type === "night" && s.start_time)
    .toSorted((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime());

  if (sorted.length === 0) {
    return ageDefaultBedtime(todaySleeps, ageMonths, customNapCount, recentSleeps, tz);
  }

  // Shift last bedtime to today's date (derive "today" from todaySleeps or the bedtime itself)
  const lastBedtime = new Date(sorted[0].start_time);
  const todayRef = todaySleeps[0]?.start_time ?? sorted[0].start_time;
  const todayDate = todayRef.slice(0, 10);
  const timeOfDay = lastBedtime.toISOString().slice(11); // HH:MM:SS.mmmZ
  return new Date(`${todayDate}T${timeOfDay}`).toISOString();
}

// ─── 3-day moving average ────────────────────────────────────────────────────
// Averages the last 3 days' nap-start offsets from wake-up.

export function movingAvgNaps(
  wakeUpTime: string,
  ageMonths: number,
  recentSleeps: SleepEntry[],
  customNapCount?: number | null,
  tz?: string,
): PredictedNap[] {
  const timezone = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const todayDate = isoToDateInTz(wakeUpTime, timezone);

  // Group last 3 days of naps
  const dayNaps = new Map<string, SleepEntry[]>();
  for (const s of recentSleeps) {
    if (s.type !== "nap" || !s.end_time) continue;
    const day = isoToDateInTz(s.start_time, timezone);
    const dist = daysBetween(day, todayDate);
    if (dist >= 1 && dist <= 3) {
      if (!dayNaps.has(day)) dayNaps.set(day, []);
      dayNaps.get(day)!.push(s);
    }
  }

  if (dayNaps.size === 0) {
    return ageDefaultNaps(wakeUpTime, ageMonths, recentSleeps, customNapCount, tz);
  }

  // For each day, compute nap offsets from the day's wake-up
  const dayOffsets: { offsets: number[]; durations: number[] }[] = [];
  for (const [day, naps] of dayNaps) {
    const sorted = naps.toSorted(
      (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime(),
    );
    const dayWakeMs = findWakeForDate(recentSleeps, day, timezone)
      ?? new Date(sorted[0].start_time).getTime() - 120 * 60_000;
    const offsets = sorted.map(
      (n) => (new Date(n.start_time).getTime() - dayWakeMs) / 60_000,
    );
    const durations = sorted.map(
      (n) => (new Date(n.end_time!).getTime() - new Date(n.start_time).getTime()) / 60_000,
    );
    dayOffsets.push({ offsets, durations });
  }

  // Average nap count (rounded)
  const avgNapCount = Math.round(
    dayOffsets.reduce((sum, d) => sum + d.offsets.length, 0) / dayOffsets.length,
  );
  if (avgNapCount === 0) {
    return ageDefaultNaps(wakeUpTime, ageMonths, recentSleeps, customNapCount, tz);
  }

  const todayWakeMs = new Date(wakeUpTime).getTime();
  const predictions: PredictedNap[] = [];

  for (let i = 0; i < avgNapCount; i++) {
    // Average offset and duration for nap position i
    const posOffsets = dayOffsets.filter((d) => d.offsets.length > i).map((d) => d.offsets[i]);
    const posDurations = dayOffsets.filter((d) => d.durations.length > i).map((d) => d.durations[i]);

    if (posOffsets.length === 0) break;

    const avgOffset = posOffsets.reduce((a, b) => a + b, 0) / posOffsets.length;
    const avgDuration = posDurations.length > 0
      ? posDurations.reduce((a, b) => a + b, 0) / posDurations.length
      : 45;

    const napStart = new Date(todayWakeMs + avgOffset * 60_000);
    const napEnd = new Date(napStart.getTime() + avgDuration * 60_000);
    predictions.push({ startTime: napStart.toISOString(), endTime: napEnd.toISOString() });
  }

  return predictions;
}

export function movingAvgBedtime(
  todaySleeps: SleepEntry[],
  ageMonths: number,
  customNapCount?: number | null,
  recentSleeps?: SleepEntry[],
  tz?: string,
): string {
  if (!recentSleeps || recentSleeps.length === 0) {
    return ageDefaultBedtime(todaySleeps, ageMonths, customNapCount, recentSleeps, tz);
  }

  // Average the last 3 bedtime gaps (last nap end → night start)
  const sorted = [...recentSleeps]
    .filter((s) => s.end_time)
    .toSorted((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].type !== "night") continue;
    if (sorted[i - 1].type !== "nap") continue;
    const prevEnd = new Date(sorted[i - 1].end_time!).getTime();
    const nextStart = new Date(sorted[i].start_time).getTime();
    const gapMin = (nextStart - prevEnd) / 60_000;
    if (gapMin >= 60 && gapMin <= 600) {
      gaps.push(gapMin);
    }
  }

  // Take only last 3
  const recent = gaps.slice(-3);
  if (recent.length === 0) {
    return ageDefaultBedtime(todaySleeps, ageMonths, customNapCount, recentSleeps, tz);
  }

  const avgGap = recent.reduce((a, b) => a + b, 0) / recent.length;
  const lastSleep = [...todaySleeps]
    .filter((s) => s.end_time)
    .toSorted((a, b) => new Date(b.end_time!).getTime() - new Date(a.end_time!).getTime())[0];

  if (!lastSleep?.end_time) {
    const ref = todaySleeps[0]?.start_time ?? recentSleeps[recentSleeps.length - 1]?.start_time ?? new Date().toISOString();
    const dateStr = ref.slice(0, 10);
    return new Date(`${dateStr}T19:00:00Z`).toISOString();
  }

  return new Date(new Date(lastSleep.end_time).getTime() + avgGap * 60_000).toISOString();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function daysBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA + "T00:00:00Z").getTime();
  const b = new Date(dateB + "T00:00:00Z").getTime();
  return Math.round(Math.abs(b - a) / 86_400_000);
}

function findYesterdayWake(
  sleeps: SleepEntry[],
  todayDate: string,
  tz: string,
): number | null {
  // Yesterday is the day before todayDate
  const yesterday = new Date(todayDate + "T00:00:00Z");
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);
  return findWakeForDate(sleeps, yesterdayStr, tz);
}

function findWakeForDate(
  sleeps: SleepEntry[],
  dateStr: string,
  tz: string,
): number | null {
  // Look for night sleep ending on this date (= wake-up for the day)
  for (const s of sleeps) {
    if (s.type !== "night" || !s.end_time) continue;
    const endDay = isoToDateInTz(s.end_time, tz);
    if (endDay === dateStr) {
      return new Date(s.end_time).getTime();
    }
  }
  return null;
}
