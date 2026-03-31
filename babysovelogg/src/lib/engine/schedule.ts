import { WAKE_WINDOWS, NAP_COUNTS, findByAge } from "./constants.js";
export { WAKE_WINDOWS, NAP_COUNTS, SLEEP_NEEDS, findByAge } from "./constants.js";
export type { SleepEntry } from "$lib/types.js";
import type { SleepEntry, BabyContext } from "$lib/types.js";
import { getHourInTz, setHourInTz, isoToDateInTz } from "$lib/tz.js";

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

/** Get recommended wake window in minutes. Adapts using 7-day average when recent sleeps available. */
export function getWakeWindow(ctx: BabyContext): number {
  const range = findByAge(WAKE_WINDOWS, ctx.ageMonths);
  const defaultWW = (range.minMinutes + range.maxMinutes) / 2;

  if (ctx.recentSleeps.length < 2) return defaultWW;

  const avgWW = getAverageWakeWindowFromSleeps(ctx.recentSleeps);
  if (avgWW === null) return defaultWW;

  const clampRange = getAdaptedWakeWindowRange(ctx);
  return Math.max(clampRange.minMinutes, Math.min(clampRange.maxMinutes, avgWW));
}

/** Get wake window range adapted to the baby's actual nap pattern. */
function getAdaptedWakeWindowRange(ctx: BabyContext): { minMinutes: number; maxMinutes: number } {
  const ageRange = findByAge(WAKE_WINDOWS, ctx.ageMonths);
  const learnedNaps = getLearnedNapCount(ctx);
  if (learnedNaps === null) return ageRange;

  const ageNaps = findByAge(NAP_COUNTS, ctx.ageMonths).naps;
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
export function predictNextNap(lastWakeTime: string, ctx: BabyContext): string {
  const ww = getWakeWindow(ctx);
  const wake = new Date(lastWakeTime);
  return new Date(wake.getTime() + ww * 60 * 1000).toISOString();
}

export interface PredictedNap {
  startTime: string;
  endTime: string;
}

/** Get expected nap count, using custom override if set. Does NOT use learned data. */
export function getExpectedNapCount(ageMonths: number, customNapCount?: number | null): number {
  if (customNapCount != null) return customNapCount;
  return findByAge(NAP_COUNTS, ageMonths).naps;
}

/** Resolve nap count using the full learning chain: custom override → learned → age default. */
export function resolveNapCount(ctx: BabyContext): number {
  if (ctx.customNapCount != null) return ctx.customNapCount;
  return getLearnedNapCount(ctx) ?? findByAge(NAP_COUNTS, ctx.ageMonths).naps;
}

/** Predict all naps for the day based on wake-up time and recent sleep patterns. */
export function predictDayNaps(wakeUpTime: string, ctx: BabyContext): PredictedNap[] {
  const defaultWW = getWakeWindow(ctx);
  const expectedNaps = resolveNapCount(ctx);
  const positionalWWs = getPositionalWakeWindows(ctx);

  const predictions: PredictedNap[] = [];
  let currentWake = new Date(wakeUpTime);

  // Learn nap duration from recent data, fallback to age-based defaults
  const napDurationMinutes = getLearnedNapDuration(ctx);

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
 * Plan naps backward from a target bedtime.
 * Given a target bedtime and wake-up time, spaces naps optimally working
 * backward from the bedtime. Uses the same wake window and nap duration
 * learning as forward planning, but anchored to the desired bedtime.
 */
export function planBackwardFromBedtime(
  wakeUpTime: string,
  targetBedtime: string,
  ctx: BabyContext,
): PredictedNap[] {
  const napCount = resolveNapCount(ctx);
  if (napCount === 0) return [];

  const bedtimeWW = getLearnedBedtimeWakeWindow(ctx);
  const defaultWW = getWakeWindow(ctx);
  const positionalWWs = getPositionalWakeWindows(ctx);
  const napDuration = getLearnedNapDuration(ctx);

  const bedtimeMs = new Date(targetBedtime).getTime();
  const wakeMs = new Date(wakeUpTime).getTime();

  const naps: { startMs: number; endMs: number }[] = [];
  let cursor = bedtimeMs;

  for (let i = napCount - 1; i >= 0; i--) {
    const ww = i === napCount - 1
      ? bedtimeWW
      : positionalWWs[i + 1] ?? defaultWW;

    const napEnd = cursor - ww * 60_000;
    const napStart = napEnd - napDuration * 60_000;

    if (napStart < wakeMs) {
      const firstWW = positionalWWs[0] ?? defaultWW;
      const adjustedStart = wakeMs + firstWW * 60_000;
      if (adjustedStart < napEnd) {
        naps.unshift({ startMs: adjustedStart, endMs: napEnd });
      }
      break;
    }

    naps.unshift({ startMs: napStart, endMs: napEnd });
    cursor = napStart;
  }

  return naps.map((n) => ({
    startTime: new Date(n.startMs).toISOString(),
    endTime: new Date(n.endMs).toISOString(),
  }));
}

/** Recommend bedtime based on today's sleeps and baby context. */
export function recommendBedtime(todaySleeps: SleepEntry[], ctx: BabyContext): string {
  const targetNaps = resolveNapCount(ctx);

  const lastSleep = [...todaySleeps]
    .filter((s) => s.end_time)
    .toSorted((a, b) => new Date(b.end_time!).getTime() - new Date(a.end_time!).getTime())[0];

  if (!lastSleep?.end_time) {
    return setHourInTz(new Date(), 19, 0, ctx.tz).toISOString();
  }

  // Use the bedtime wake window (nap->night gap) — typically longer than nap wake windows.
  const bedtimeWW = getLearnedBedtimeWakeWindow(ctx);
  const hasEnoughNaps = todaySleeps.filter((s) => s.type === "nap" && s.end_time).length >= targetNaps;
  const multiplier = hasEnoughNaps ? 1.0 : 0.85;
  const bedtime = new Date(
    new Date(lastSleep.end_time).getTime() + bedtimeWW * multiplier * 60 * 1000,
  );

  // Wide sanity clamp in the baby's local time
  const hour = getHourInTz(bedtime, ctx.tz);
  if (hour < 16) return setHourInTz(bedtime, 16, 0, ctx.tz).toISOString();
  if (hour > 23) return setHourInTz(bedtime, 23, 0, ctx.tz).toISOString();

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
function getPositionalWakeWindows(ctx: BabyContext): number[] {
  if (ctx.recentSleeps.length < 4) return [];

  // Group sleeps by baby-local day
  const byDay = new Map<string, SleepEntry[]>();
  for (const s of ctx.recentSleeps) {
    if (!s.end_time) continue;
    const day = localDate(s.start_time, ctx.tz);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(s);
  }

  // Collect wake windows by position across all days.
  // Only count gaps before naps (excludes nap->night evening gap).
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
  const adaptedRange = getAdaptedWakeWindowRange(ctx);
  const result: number[] = [];
  for (const [pos, gaps] of gapsByPosition) {
    if (gaps.length < 2) continue;
    let avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    avg = Math.max(adaptedRange.minMinutes, Math.min(adaptedRange.maxMinutes, avg));
    result[pos] = Math.round(avg);
  }

  return result;
}

/**
 * Learn nap count from recent sleep data using probability-weighted hypothesis scoring.
 *
 * Instead of a hard >60% mode switch, this keeps multiple hypotheses alive
 * and uses recency-weighted scoring to pick the best one. During transitions
 * (e.g. 2→1 naps), recent days get more weight so the engine adapts faster.
 *
 * Returns null only when there's too little data to form any opinion.
 */
function getLearnedNapCount(ctx: BabyContext): number | null {
  if (ctx.recentSleeps.length < 4) return null;

  // Group completed naps by baby-local day, preserving chronological order
  const napsByDay = new Map<string, number>();
  for (const s of ctx.recentSleeps) {
    if (s.type !== "nap" || !s.end_time) continue;
    const day = localDate(s.start_time, ctx.tz);
    napsByDay.set(day, (napsByDay.get(day) ?? 0) + 1);
  }

  if (napsByDay.size < 3) return null;

  // Sort days chronologically and apply recency weights.
  // Most recent day gets weight 1.0, each prior day decays by 0.8x.
  const sortedDays = [...napsByDay.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b));

  const weightedFreq = new Map<number, number>();
  let totalWeight = 0;
  for (let i = 0; i < sortedDays.length; i++) {
    const [, count] = sortedDays[i];
    const recencyWeight = Math.pow(0.8, sortedDays.length - 1 - i);
    weightedFreq.set(count, (weightedFreq.get(count) ?? 0) + recencyWeight);
    totalWeight += recencyWeight;
  }

  // Find the hypothesis with the highest weighted score
  let bestCount = 0, bestScore = 0;
  for (const [count, score] of weightedFreq) {
    if (score > bestScore) {
      bestCount = count;
      bestScore = score;
    }
  }

  // With enough data (5+ days) and strong dominance (>60%), always trust the mode.
  // With less dominance, still return the recency-weighted winner — this lets
  // the engine adapt faster during transitions instead of falling back to age defaults.
  if (napsByDay.size >= 5 && bestScore / totalWeight > 0.6) {
    return bestCount;
  }

  // During transition (no clear winner), use recency-weighted best if it has
  // reasonable support (>40% weighted). This avoids age-default fallback during
  // the messy transition period.
  if (bestScore / totalWeight > 0.4) {
    return bestCount;
  }

  return null;
}

/** Learn the bedtime wake window (last nap end -> night start) from recent data. */
function getLearnedBedtimeWakeWindow(ctx: BabyContext): number {
  const wwRange = findByAge(WAKE_WINDOWS, ctx.ageMonths);
  const defaultWW = (wwRange.minMinutes + wwRange.maxMinutes) / 2 * 1.15;

  if (ctx.recentSleeps.length < 4) return defaultWW;

  const sorted = [...ctx.recentSleeps]
    .filter((s) => s.end_time)
    .toSorted((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  // Collect gaps where the next sleep is a night (nap->night = bedtime gap)
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
function getLearnedNapDuration(ctx: BabyContext): number {
  const ageMonths = ctx.ageMonths;
  const defaultDuration = ageMonths < 6 ? 60 : ageMonths < 12 ? 45 : 30;

  if (ctx.recentSleeps.length === 0) return defaultDuration;

  const naps = ctx.recentSleeps.filter((s) => s.type === "nap" && s.end_time);
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
