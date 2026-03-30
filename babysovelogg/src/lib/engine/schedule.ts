import { WAKE_WINDOWS, NAP_COUNTS, findByAge } from "./constants.js";
export { WAKE_WINDOWS, NAP_COUNTS, SLEEP_NEEDS, findByAge } from "./constants.js";
export type { SleepEntry } from "$lib/types.js";
import type { SleepEntry } from "$lib/types.js";
import { getHourInTz, setHourInTz, isoToDateInTz } from "$lib/tz.js";

/** Resolve baby's timezone. Defaults to server-local (= baby's TZ in production). */
function resolveTz(tz?: string): string {
  return tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Get the baby-local date (YYYY-MM-DD) for a UTC ISO timestamp. */
function localDate(iso: string, tz: string): string {
  return isoToDateInTz(iso, tz);
}

/** Calculate age in months from birthdate ISO string. */
export function calculateAgeMonths(birthdate: string, now?: Date): number {
  const birth = new Date(birthdate);
  const ref = now ?? new Date();
  let months = (ref.getFullYear() - birth.getFullYear()) * 12 + (ref.getMonth() - birth.getMonth());
  if (ref.getDate() < birth.getDate()) months--;
  return Math.max(0, months);
}

/** Get recommended wake window in minutes. If recentSleeps provided, adapts using 7-day average. */
export function getWakeWindow(ageMonths: number, recentSleeps?: SleepEntry[], tz?: string): number {
  const range = findByAge(WAKE_WINDOWS, ageMonths);
  const defaultWW = (range.minMinutes + range.maxMinutes) / 2;

  if (!recentSleeps || recentSleeps.length < 2) return defaultWW;

  const avgWW = getAverageWakeWindowFromSleeps(recentSleeps);
  if (avgWW === null) return defaultWW;

  const clampRange = getAdaptedWakeWindowRange(ageMonths, recentSleeps, tz);
  return Math.max(clampRange.minMinutes, Math.min(clampRange.maxMinutes, avgWW));
}

/** Get wake window range adapted to the baby's actual nap pattern. */
function getAdaptedWakeWindowRange(
  ageMonths: number,
  recentSleeps: SleepEntry[],
  tz?: string,
): { minMinutes: number; maxMinutes: number } {
  const ageRange = findByAge(WAKE_WINDOWS, ageMonths);
  const learnedNaps = getLearnedNapCount(recentSleeps, tz);
  if (learnedNaps === null) return ageRange;

  const ageNaps = findByAge(NAP_COUNTS, ageMonths).naps;
  if (learnedNaps === ageNaps) return ageRange;

  // Baby does fewer/more naps than age default. Find ALL age brackets where
  // this nap count is within the acceptable range, and look up the CORRESPONDING
  // wake window range by age (not by array index — the two tables have different sizes).
  let minWW = ageRange.minMinutes;
  let maxWW = ageRange.maxMinutes;
  for (const nc of NAP_COUNTS) {
    if (learnedNaps >= nc.range[0] && learnedNaps <= nc.range[1]) {
      const ww = findByAge(WAKE_WINDOWS, nc.minMonths);
      minWW = Math.min(minWW, ww.minMinutes);
      maxWW = Math.max(maxWW, ww.maxMinutes);
    }
  }
  return { minMinutes: minWW, maxMinutes: maxWW };
}

/** Predict next nap time as ISO string. */
export function predictNextNap(
  lastWakeTime: string,
  ageMonths: number,
  recentSleeps?: SleepEntry[],
): string {
  const ww = getWakeWindow(ageMonths, recentSleeps);
  const wake = new Date(lastWakeTime);
  return new Date(wake.getTime() + ww * 60 * 1000).toISOString();
}

export interface PredictedNap {
  startTime: string;
  endTime: string;
}

/** Get expected nap count, using custom override if set. */
export function getExpectedNapCount(ageMonths: number, customNapCount?: number | null): number {
  if (customNapCount != null) return customNapCount;
  return findByAge(NAP_COUNTS, ageMonths).naps;
}

/** Predict all naps for the day based on wake-up time and recent sleep patterns. */
export function predictDayNaps(
  wakeUpTime: string,
  ageMonths: number,
  recentSleeps?: SleepEntry[],
  customNapCount?: number | null,
  tz?: string,
): PredictedNap[] {
  const defaultWW = getWakeWindow(ageMonths, recentSleeps, tz);
  const expectedNaps =
    customNapCount != null
      ? customNapCount
      : getLearnedNapCount(recentSleeps, tz) ?? findByAge(NAP_COUNTS, ageMonths).naps;
  const positionalWWs = getPositionalWakeWindows(recentSleeps, ageMonths, tz);

  const predictions: PredictedNap[] = [];
  let currentWake = new Date(wakeUpTime);

  // Learn nap duration from recent data, fallback to age-based defaults
  const napDurationMinutes = getLearnedNapDuration(recentSleeps, ageMonths);

  for (let i = 0; i < expectedNaps; i++) {
    // Use positional wake window if available, otherwise fall back to global average
    const ww = positionalWWs[i] ?? defaultWW;
    const napStart = new Date(currentWake.getTime() + ww * 60 * 1000);
    const napEnd = new Date(napStart.getTime() + napDurationMinutes * 60 * 1000);

    predictions.push({
      startTime: napStart.toISOString(),
      endTime: napEnd.toISOString(),
    });

    // Next wake window starts after this nap ends
    currentWake = napEnd;
  }

  return predictions;
}

/**
 * Recommend bedtime based on today's sleeps and age.
 * @param tz - IANA timezone for the baby. Defaults to server-local (= baby's TZ in production).
 */
export function recommendBedtime(
  todaySleeps: SleepEntry[],
  ageMonths: number,
  customNapCount?: number | null,
  recentSleeps?: SleepEntry[],
  tz?: string,
): string {
  const targetNaps = getExpectedNapCount(ageMonths, customNapCount);
  const timezone = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const lastSleep = [...todaySleeps]
    .filter((s) => s.end_time)
    .toSorted((a, b) => new Date(b.end_time!).getTime() - new Date(a.end_time!).getTime())[0];

  if (!lastSleep?.end_time) {
    return setHourInTz(new Date(), 19, 0, timezone).toISOString();
  }

  // Use the bedtime wake window (nap→night gap) — typically longer than nap wake windows.
  const bedtimeWW = getLearnedBedtimeWakeWindow(recentSleeps, ageMonths);
  const hasEnoughNaps = todaySleeps.filter((s) => s.type === "nap" && s.end_time).length >= targetNaps;
  const multiplier = hasEnoughNaps ? 1.0 : 0.85;
  const bedtime = new Date(
    new Date(lastSleep.end_time).getTime() + bedtimeWW * multiplier * 60 * 1000,
  );

  // Wide sanity clamp in the baby's local time
  const hour = getHourInTz(bedtime, timezone);
  if (hour < 16) return setHourInTz(bedtime, 16, 0, timezone).toISOString();
  if (hour > 23) return setHourInTz(bedtime, 23, 0, timezone).toISOString();

  return bedtime.toISOString();
}

/** Detect if baby is transitioning to fewer naps. Returns suggested new nap count or null. */
export function detectNapTransition(
  recentDaysSleeps: SleepEntry[][],
): { dropping: boolean; currentAvgNaps: number; suggestedNaps: number } | null {
  if (recentDaysSleeps.length < 5) return null;

  const napCounts = recentDaysSleeps.map(
    (day) => day.filter((s) => s.type === "nap" && s.end_time).length,
  );
  const avgNaps = napCounts.reduce((a, b) => a + b, 0) / napCounts.length;

  // Check if trending lower (last 3 days vs first days)
  const recent3 = napCounts.slice(-3);
  const earlier = napCounts.slice(0, -3);
  const recentAvg = recent3.reduce((a, b) => a + b, 0) / recent3.length;
  const earlierAvg = earlier.reduce((a, b) => a + b, 0) / earlier.length;

  if (earlierAvg - recentAvg >= 0.5) {
    return {
      dropping: true,
      currentAvgNaps: Math.round(avgNaps * 10) / 10,
      suggestedNaps: Math.round(recentAvg),
    };
  }

  return {
    dropping: false,
    currentAvgNaps: Math.round(avgNaps * 10) / 10,
    suggestedNaps: Math.round(avgNaps),
  };
}

/**
 * Compute per-position average wake windows (1st WW, 2nd WW, etc.) from recent sleeps.
 * First WW is typically shorter, last WW is typically longer.
 * Returns a sparse array indexed by position (0-based).
 */
function getPositionalWakeWindows(recentSleeps?: SleepEntry[], ageMonths?: number, tz?: string): number[] {
  if (!recentSleeps || recentSleeps.length < 4) return [];

  const range = ageMonths != null ? findByAge(WAKE_WINDOWS, ageMonths) : null;
  const timezone = resolveTz(tz);

  // Group sleeps by baby-local day
  const byDay = new Map<string, SleepEntry[]>();
  for (const s of recentSleeps) {
    if (!s.end_time) continue;
    const day = localDate(s.start_time, timezone);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(s);
  }

  // Collect wake windows by position across all days.
  // Only count gaps before naps (excludes nap→night evening gap).
  const gapsByPosition = new Map<number, number[]>();
  for (const daySleeps of byDay.values()) {
    const sorted = [...daySleeps]
      .filter((s) => s.end_time)
      .toSorted((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

    let napPosition = 0;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].type !== "nap") continue; // skip gaps before night sleep
      const prevEnd = new Date(sorted[i - 1].end_time!).getTime();
      const nextStart = new Date(sorted[i].start_time).getTime();
      const gapMin = (nextStart - prevEnd) / 60000;
      if (gapMin >= 10 && gapMin <= 480) {
        if (!gapsByPosition.has(napPosition)) gapsByPosition.set(napPosition, []);
        gapsByPosition.get(napPosition)!.push(gapMin);
      }
      napPosition++;
    }
  }

  // Average each position, clamped to adapted range
  const adaptedRange = ageMonths != null
    ? getAdaptedWakeWindowRange(ageMonths, recentSleeps)
    : null;
  const result: number[] = [];
  for (const [pos, gaps] of gapsByPosition) {
    if (gaps.length < 2) continue;
    let avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const r = adaptedRange ?? range;
    if (r) {
      avg = Math.max(r.minMinutes, Math.min(r.maxMinutes, avg));
    }
    result[pos] = Math.round(avg);
  }

  return result;
}

/**
 * Learn nap count from recent sleep data. Returns the most common nap count
 * if it dominates (>60% of days), or null to fall back to age default.
 * Requires 5+ days with naps to produce a result.
 */
function getLearnedNapCount(recentSleeps?: SleepEntry[], tz?: string): number | null {
  if (!recentSleeps || recentSleeps.length < 4) return null;

  const timezone = resolveTz(tz);

  // Group completed naps by baby-local day
  const napsByDay = new Map<string, number>();
  for (const s of recentSleeps) {
    if (s.type !== "nap" || !s.end_time) continue;
    const day = localDate(s.start_time, timezone);
    napsByDay.set(day, (napsByDay.get(day) ?? 0) + 1);
  }

  if (napsByDay.size < 5) return null;

  // Find the mode (most common nap count)
  const freq = new Map<number, number>();
  for (const n of napsByDay.values()) {
    freq.set(n, (freq.get(n) ?? 0) + 1);
  }
  let mode = 0, modeCount = 0;
  for (const [n, c] of freq) {
    if (c > modeCount) { mode = n; modeCount = c; }
  }

  // Only override age default if the mode is clearly dominant
  return modeCount / napsByDay.size > 0.6 ? mode : null;
}

/** Learn the bedtime wake window (last nap end → night start) from recent data. */
function getLearnedBedtimeWakeWindow(recentSleeps?: SleepEntry[], ageMonths?: number): number {
  const defaultWW = ageMonths != null
    ? (findByAge(WAKE_WINDOWS, ageMonths).minMinutes + findByAge(WAKE_WINDOWS, ageMonths).maxMinutes) / 2 * 1.15
    : 210;

  if (!recentSleeps || recentSleeps.length < 4) return defaultWW;

  const sorted = [...recentSleeps]
    .filter((s) => s.end_time)
    .toSorted((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  // Collect gaps where the next sleep is a night (nap→night = bedtime gap)
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].type !== "night") continue;
    if (sorted[i - 1].type !== "nap") continue;
    const prevEnd = new Date(sorted[i - 1].end_time!).getTime();
    const nextStart = new Date(sorted[i].start_time).getTime();
    const gapMin = (nextStart - prevEnd) / 60000;
    if (gapMin >= 60 && gapMin <= 600) {
      gaps.push(gapMin);
    }
  }

  if (gaps.length < 2) return defaultWW;
  return gaps.reduce((a, b) => a + b, 0) / gaps.length;
}

/** Learn average nap duration from recent completed naps, fallback to age-based defaults. */
function getLearnedNapDuration(recentSleeps?: SleepEntry[], ageMonths?: number): number {
  const defaultDuration = !ageMonths ? 45 : ageMonths < 6 ? 60 : ageMonths < 12 ? 45 : 30;

  if (!recentSleeps || recentSleeps.length === 0) return defaultDuration;

  const naps = recentSleeps.filter((s) => s.type === "nap" && s.end_time);
  if (naps.length < 3) return defaultDuration;

  const durations = naps
    .map((s) => {
      const dur = (new Date(s.end_time!).getTime() - new Date(s.start_time).getTime()) / 60000;
      return dur;
    })
    .filter((d) => d >= 10 && d <= 180); // Filter out unreasonable values

  if (durations.length < 3) return defaultDuration;
  return Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
}

/**
 * Compute average wake window before NAPS from a list of sleeps (in minutes).
 * Only counts gaps where the next sleep is a nap — excludes the evening
 * nap-to-bedtime gap which inflates the average for nap prediction.
 */
function getAverageWakeWindowFromSleeps(sleeps: SleepEntry[]): number | null {
  const sorted = [...sleeps]
    .filter((s) => s.end_time)
    .toSorted((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  if (sorted.length < 2) return null;

  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    // Only count gaps before naps (not before night sleep)
    if (sorted[i].type !== "nap") continue;
    const prevEnd = new Date(sorted[i - 1].end_time!).getTime();
    const nextStart = new Date(sorted[i].start_time).getTime();
    const gapMin = (nextStart - prevEnd) / 60000;
    if (gapMin >= 10 && gapMin <= 480) {
      gaps.push(gapMin);
    }
  }

  if (gaps.length === 0) return null;
  return gaps.reduce((a, b) => a + b, 0) / gaps.length;
}
