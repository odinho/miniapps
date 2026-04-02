import { WAKE_WINDOWS, NAP_COUNTS, SLEEP_NEEDS, findByAge } from "./constants.js";
export { WAKE_WINDOWS, NAP_COUNTS, SLEEP_NEEDS, findByAge } from "./constants.js";
export type { SleepEntry } from "$lib/types.js";
import type { SleepEntry, BabyContext, PredictionFeatures } from "$lib/types.js";
import { getHourInTz, setHourInTz, isoToDateInTz } from "$lib/tz.js";

/** Check if a feature is enabled (defaults to true if not specified). */
function feat(ctx: BabyContext, key: keyof PredictionFeatures): boolean {
  return ctx.features?.[key] !== false;
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

interface WeightedSample {
  value: number;
  weight: number;
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
  const positionalDurs = getPositionalNapDurations(ctx);
  const defaultDuration = getLearnedNapDuration(ctx);

  const predictions: PredictedNap[] = [];
  let currentWake = new Date(wakeUpTime);

  for (let i = 0; i < expectedNaps; i++) {
    const ww = positionalWWs[i] ?? defaultWW;
    const duration = (feat(ctx, "positionalDuration") ? positionalDurs[i] : undefined) ?? defaultDuration;
    const napStart = new Date(currentWake.getTime() + ww * 60 * 1000);
    const napEnd = new Date(napStart.getTime() + duration * 60 * 1000);

    predictions.push({
      startTime: napStart.toISOString(),
      endTime: napEnd.toISOString(),
    });

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
  const positionalDurs = getPositionalNapDurations(ctx);
  const defaultDuration = getLearnedNapDuration(ctx);

  const bedtimeMs = new Date(targetBedtime).getTime();
  const wakeMs = new Date(wakeUpTime).getTime();

  const naps: { startMs: number; endMs: number }[] = [];
  let cursor = bedtimeMs;

  for (let i = napCount - 1; i >= 0; i--) {
    const ww = i === napCount - 1
      ? bedtimeWW
      : positionalWWs[i + 1] ?? defaultWW;
    const duration = (feat(ctx, "positionalDuration") ? positionalDurs[i] : undefined) ?? defaultDuration;

    const napEnd = cursor - ww * 60_000;
    const napStart = napEnd - duration * 60_000;

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

  // Pressure-based: last nap end + bedtime wake window
  const bedtimeWW = getLearnedBedtimeWakeWindow(ctx);
  const hasEnoughNaps = todaySleeps.filter((s) => s.type === "nap" && s.end_time).length >= targetNaps;
  const multiplier = hasEnoughNaps ? 1.0 : 0.85;
  const pressureBedtime = new Date(
    new Date(lastSleep.end_time).getTime() + bedtimeWW * multiplier * 60 * 1000,
  );

  // Habitual: what time does this family usually do bedtime?
  const habitualBedtimeMs = feat(ctx, "habitualBedtime")
    ? getHabitualBedtimePrediction(pressureBedtime, ctx) : null;
  let bedtime: Date;
  if (habitualBedtimeMs !== null) {
    // Blend based on data consistency — consistent family → habitual dominates.
    // But if naps were missed (multiplier < 1), shift toward pressure-based
    // since the day was unusual and earlier bedtime is appropriate.
    const baseWeight = getHabitualBedtimeWeight(ctx);
    const weight = hasEnoughNaps ? baseWeight : baseWeight * 0.5;
    const blendedMs = pressureBedtime.getTime() * (1 - weight) + habitualBedtimeMs * weight;
    bedtime = new Date(Math.round(blendedMs));
  } else {
    bedtime = pressureBedtime;
  }

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
 * Compute per-position average nap durations from recent sleeps.
 * 1st nap of the day is typically longer than 2nd nap.
 * Returns a sparse array indexed by position (0-based).
 */
function getPositionalNapDurations(ctx: BabyContext): number[] {
  if (ctx.recentSleeps.length < 4) return [];

  const byDay = new Map<string, SleepEntry[]>();
  for (const s of ctx.recentSleeps) {
    if (s.type !== "nap" || !s.end_time) continue;
    const day = localDate(s.start_time, ctx.tz);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(s);
  }

  const dursByPosition = new Map<number, number[]>();
  for (const dayNaps of byDay.values()) {
    const sorted = dayNaps
      .toSorted((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
    for (let i = 0; i < sorted.length; i++) {
      const dur = (new Date(sorted[i].end_time!).getTime() - new Date(sorted[i].start_time).getTime()) / 60_000;
      if (dur < 10 || dur > 180) continue;
      if (!dursByPosition.has(i)) dursByPosition.set(i, []);
      dursByPosition.get(i)!.push(dur);
    }
  }

  const result: number[] = [];
  for (const [pos, durs] of dursByPosition) {
    if (durs.length < 2) continue;
    result[pos] = Math.round(durs.reduce((a, b) => a + b, 0) / durs.length);
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

/** Learn average night sleep duration (minutes) from recent completed nights. */
export function getLearnedNightDuration(ctx: BabyContext): number {
  const sleepNeed = findByAge(SLEEP_NEEDS, ctx.ageMonths);
  const napDur = getLearnedNapDuration(ctx);
  const napCount = resolveNapCount(ctx);
  const defaultNight = (sleepNeed.totalHours * 60) - (napDur * napCount);

  if (feat(ctx, "weightedRecency")) {
    const samples = collectWeightedDurations(ctx.recentSleeps, "night", 360, 900);
    if (samples.length < 2) return Math.round(defaultNight);
    const learned = weightedTrimmedMean(samples);
    return Math.round(blendEstimate(defaultNight, learned, samples.length, 2, 6));
  }

  // Simple average fallback
  const nights = ctx.recentSleeps.filter((s) => s.type === "night" && s.end_time);
  if (nights.length < 2) return Math.round(defaultNight);
  const durations = nights
    .map((s) => (new Date(s.end_time!).getTime() - new Date(s.start_time).getTime()) / 60000)
    .filter((d) => d >= 360 && d <= 900);
  if (durations.length < 2) return Math.round(defaultNight);
  return Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
}

/** Learn average nap duration from recent completed naps, fallback to age-based defaults. */
export function getLearnedNapDuration(ctx: BabyContext): number {
  const ageMonths = ctx.ageMonths;
  const defaultDuration = ageMonths < 6 ? 60 : ageMonths < 12 ? 45 : 30;
  if (ctx.recentSleeps.length === 0) return defaultDuration;

  if (feat(ctx, "weightedRecency")) {
    const samples = collectWeightedDurations(ctx.recentSleeps, "nap", 10, 180);
    if (samples.length < 3) return defaultDuration;
    const learned = weightedTrimmedMean(samples);
    return Math.round(blendEstimate(defaultDuration, learned, samples.length, 3, 8));
  }

  // Simple average fallback
  const naps = ctx.recentSleeps.filter((s) => s.type === "nap" && s.end_time);
  if (naps.length < 3) return defaultDuration;
  const durations = naps
    .map((s) => (new Date(s.end_time!).getTime() - new Date(s.start_time).getTime()) / 60000)
    .filter((d) => d >= 10 && d <= 180);
  if (durations.length < 3) return defaultDuration;
  return Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
}

/** Predict the likely end of an active nap using learned duration and cycle boundaries. */
export function predictNapEndTime(startTime: string, ctx: BabyContext): string {
  const startMs = new Date(startTime).getTime();
  const targetDuration = getLearnedNapDuration(ctx);
  let predictedDuration = targetDuration;
  if (feat(ctx, "cycleBias")) {
    const cycleMinutes = getSleepCycleMinutes(ctx.ageMonths);
    predictedDuration = snapToCycleBoundary(targetDuration, cycleMinutes, 1, 3, 10, 180);
  }
  return new Date(startMs + predictedDuration * 60_000).toISOString();
}

/**
 * Predict the likely wake-up time from an active night sleep.
 * @param todayNapMinutes - optional total nap minutes today, for sleep budget adjustment
 */
export function predictNightEndTime(startTime: string, ctx: BabyContext, todayNapMinutes?: number): string {
  const start = new Date(startTime);
  const startMs = start.getTime();
  const cycleMinutes = getSleepCycleMinutes(ctx.ageMonths);
  let durationEstimate = getLearnedNightDuration(ctx);

  // Sleep budget: if today's naps were unusually long/short, adjust night prediction.
  // Not fully compensatory — baby doesn't perfectly trade nap for night.
  if (feat(ctx, "sleepBudget") && todayNapMinutes !== undefined) {
    const expectedNapMin = getLearnedNapDuration(ctx) * resolveNapCount(ctx);
    const napDelta = todayNapMinutes - expectedNapMin;
    // ~25% compensation: 60 extra nap minutes → ~15 min shorter night.
    // Kept low because the signal is noisy (logging delays, varied nap quality).
    durationEstimate = Math.max(360, durationEstimate - napDelta * 0.25);
  }
  let durationMin = durationEstimate;
  if (feat(ctx, "cycleBias")) {
    durationMin = snapToCycleBoundary(durationEstimate, cycleMinutes, 6, 16, 360, 900);
  }
  const durationBasedMs = startMs + durationMin * 60_000;

  if (!feat(ctx, "habitualWake")) {
    return new Date(durationBasedMs).toISOString();
  }

  const habitualWake = getHabitualWakeTimePrediction(start, ctx);
  if (habitualWake === null) {
    return new Date(durationBasedMs).toISOString();
  }

  // Data-driven blend: use whichever signal is more consistent.
  // For a baby with a rock-solid 06:45 wake, habitual dominates (~100%).
  // For a baby whose wake time follows bedtime, duration dominates.
  const habitualWeight = getHabitualVsDurationWeight(ctx);
  const blendedMs = durationBasedMs * (1 - habitualWeight) + habitualWake * habitualWeight;
  const minWakeMs = startMs + 360 * 60_000;
  const maxWakeMs = startMs + 900 * 60_000;
  return new Date(clamp(Math.round(blendedMs), minWakeMs, maxWakeMs)).toISOString();
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

function collectWeightedDurations(
  sleeps: SleepEntry[],
  type: SleepEntry["type"],
  minMinutes: number,
  maxMinutes: number,
): WeightedSample[] {
  const sorted = [...sleeps]
    .filter((s) => s.type === type && s.end_time)
    .toSorted((a, b) => new Date(a.end_time!).getTime() - new Date(b.end_time!).getTime());

  return sorted
    .map((s, idx) => ({
      value: (new Date(s.end_time!).getTime() - new Date(s.start_time).getTime()) / 60_000,
      weight: Math.pow(0.85, sorted.length - 1 - idx),
    }))
    .filter((sample) => sample.value >= minMinutes && sample.value <= maxMinutes);
}

function weightedTrimmedMean(samples: WeightedSample[], trimFraction = 0.15): number {
  const sorted = [...samples].toSorted((a, b) => a.value - b.value);
  if (sorted.length <= 2) return weightedMean(sorted);

  const trimCount = Math.floor(sorted.length * trimFraction);
  const kept = sorted.slice(trimCount, Math.max(trimCount + 1, sorted.length - trimCount));
  return weightedMean(kept);
}

function weightedMean(samples: WeightedSample[]): number {
  const totalWeight = samples.reduce((sum, sample) => sum + sample.weight, 0);
  if (totalWeight === 0) return 0;
  return samples.reduce((sum, sample) => sum + sample.value * sample.weight, 0) / totalWeight;
}

function blendEstimate(
  fallback: number,
  learned: number,
  sampleCount: number,
  minSamples: number,
  fullLearningSamples: number,
): number {
  if (sampleCount < minSamples) return fallback;
  const blend = clamp((sampleCount - minSamples + 1) / (fullLearningSamples - minSamples + 1), 0, 1);
  return fallback * (1 - blend) + learned * blend;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getSleepCycleMinutes(ageMonths: number): number {
  // Research: newborn ~50 min, infant ~50-60 min, toddler ~60 min
  // School-age 85-90 min. See docs/sleep-science-research.md
  if (ageMonths < 3) return 50;
  if (ageMonths < 6) return 50;
  if (ageMonths < 12) return 55;
  return 60;
}

/**
 * Soft-snap to nearest sleep cycle boundary.
 * Blends between the raw duration and the nearest cycle multiple
 * (30% cycle bias, 70% raw data), so the data is nudged toward
 * cycle boundaries but not forced there.
 */
function snapToCycleBoundary(
  durationMinutes: number,
  cycleMinutes: number,
  _minCycles: number,
  _maxCycles: number,
  minMinutes: number,
  maxMinutes: number,
): number {
  const bounded = clamp(durationMinutes, minMinutes, maxMinutes);
  // Find nearest cycle boundary (including half-cycles for naps)
  const halfCycle = cycleMinutes / 2;
  const nearestBoundary = Math.round(bounded / halfCycle) * halfCycle;
  // Soft blend: 70% raw data, 30% cycle boundary
  const blended = bounded * 0.7 + nearestBoundary * 0.3;
  return clamp(Math.round(blended), minMinutes, maxMinutes);
}

/**
 * Compute how much to trust habitual wake time vs duration-based.
 * Returns 0..1 where 1 = fully habitual (consistent wake times),
 * 0 = fully duration-based (variable wake times, consistent night lengths).
 *
 * Logic: compare the coefficient of variation (SD/mean) of wake times
 * vs night durations. The more consistent signal gets more weight.
 * With very few samples, stays conservative (0.5).
 */
function getHabitualVsDurationWeight(ctx: BabyContext): number {
  const wakeSamples = collectNightWakeMinuteSamples(ctx);
  const durationSamples = collectWeightedDurations(ctx.recentSleeps, "night", 360, 900);

  if (wakeSamples.length < 3 || durationSamples.length < 3) return 0.5;

  const wakeSD = weightedSD(wakeSamples);
  const durSD = weightedSD(durationSamples);

  // If both are very consistent, lean habitual (circadian is real)
  // If wake times are 2x more variable than durations, lean duration
  // The ratio determines the blend smoothly
  if (wakeSD + durSD === 0) return 0.5;
  return clamp(durSD / (wakeSD + durSD), 0.15, 0.85);
}

/** Collect bedtime (local minute of day) samples from recent nights. */
function collectBedtimeMinuteSamples(ctx: BabyContext): WeightedSample[] {
  const nights = [...ctx.recentSleeps]
    .filter((s) => s.type === "night")
    .toSorted((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  return nights.map((s, idx) => ({
    value: getLocalMinuteOfDay(new Date(s.start_time), ctx.tz),
    weight: Math.pow(0.85, nights.length - 1 - idx),
  }));
}

/** Predict habitual bedtime for the given reference date. Returns epoch ms or null. */
function getHabitualBedtimePrediction(refDate: Date, ctx: BabyContext): number | null {
  const samples = collectBedtimeMinuteSamples(ctx);
  if (samples.length < 2) return null;

  const habitualMinute = weightedMedian(samples);
  const dateStr = isoToDateInTz(refDate.toISOString(), ctx.tz);
  return setLocalClockTime(dateStr, habitualMinute, ctx.tz).getTime();
}

/**
 * How much to trust habitual bedtime vs pressure-based.
 * Consistent bedtime families → weight near 1.0.
 * Variable bedtime → weight near 0.0.
 */
function getHabitualBedtimeWeight(ctx: BabyContext): number {
  const samples = collectBedtimeMinuteSamples(ctx);
  if (samples.length < 3) return 0;

  const sd = weightedSD(samples);
  // SD < 15 min → very consistent → weight ~0.8
  // SD > 45 min → very variable → weight ~0.1
  // Linear interpolation between
  return clamp(1 - (sd - 10) / 50, 0.1, 0.85);
}

/** Weighted standard deviation of sample values. */
function weightedSD(samples: WeightedSample[]): number {
  if (samples.length < 2) return 0;
  const mean = weightedMean(samples);
  const totalWeight = samples.reduce((sum, s) => sum + s.weight, 0);
  if (totalWeight === 0) return 0;
  const variance = samples.reduce((sum, s) => sum + s.weight * (s.value - mean) ** 2, 0) / totalWeight;
  return Math.sqrt(variance);
}

function collectNightWakeMinuteSamples(ctx: BabyContext): WeightedSample[] {
  const nights = [...ctx.recentSleeps]
    .filter((s) => s.type === "night" && s.end_time)
    .toSorted((a, b) => new Date(a.end_time!).getTime() - new Date(b.end_time!).getTime());

  return nights.map((s, idx) => ({
    value: getLocalMinuteOfDay(new Date(s.end_time!), ctx.tz),
    weight: Math.pow(0.85, nights.length - 1 - idx),
  }));
}

function getHabitualWakeTimePrediction(
  start: Date,
  ctx: BabyContext,
): number | null {
  const samples = collectNightWakeMinuteSamples(ctx);
  if (samples.length < 2) return null;

  const habitualMinute = weightedMedian(samples);
  const predicted = new Date(start);
  predicted.setUTCDate(predicted.getUTCDate() + 1);
  const wakeDate = isoToDateInTz(predicted.toISOString(), ctx.tz);
  const candidate = setLocalClockTime(wakeDate, habitualMinute, ctx.tz);
  return candidate.getTime();
}

function weightedMedian(samples: WeightedSample[]): number {
  const sorted = [...samples].toSorted((a, b) => a.value - b.value);
  const totalWeight = sorted.reduce((sum, sample) => sum + sample.weight, 0);
  if (totalWeight === 0) return sorted[0]?.value ?? 0;

  let running = 0;
  for (const sample of sorted) {
    running += sample.weight;
    if (running >= totalWeight / 2) return sample.value;
  }

  return sorted[sorted.length - 1]?.value ?? 0;
}

function getLocalMinuteOfDay(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

function setLocalClockTime(dateStr: string, minuteOfDay: number, tz: string): Date {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return setHourInTz(new Date(`${dateStr}T12:00:00.000Z`), hour, minute, tz);
}
