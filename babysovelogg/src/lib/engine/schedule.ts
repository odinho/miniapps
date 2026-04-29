import { WAKE_WINDOWS, NAP_COUNTS, SLEEP_NEEDS, RESCUE_NAP, findByAge } from "./constants.js";
export { WAKE_WINDOWS, NAP_COUNTS, SLEEP_NEEDS, RESCUE_NAP, findByAge } from "./constants.js";
export type { SleepEntry } from "$lib/types.js";
import type { SleepEntry, BabyContext, PredictionFeatures } from "$lib/types.js";
import { getHourInTz, setHourInTz, isoToDateInTz } from "$lib/tz.js";
import type { SleepLogRow } from "$lib/types.js";
import { daytimeSleepDuration } from "$lib/data/shine2021.js";

/** Check if a feature is enabled (defaults to true if not specified). */
function feat(ctx: BabyContext, key: keyof PredictionFeatures): boolean {
  return ctx.features?.[key] !== false;
}

/** Get the baby-local date (YYYY-MM-DD) for a UTC ISO timestamp. */
function localDate(iso: string, tz: string): string {
  return isoToDateInTz(iso, tz);
}

// ─── Sleep data cache ──────────────────────────────────────────────────────
// Precomputes sorted/grouped/parsed data once per BabyContext so downstream
// functions avoid redundant sorting, filtering, Date parsing, and isoToDateInTz calls.

interface CachedSleep {
  startMs: number;
  endMs: number;
  type: "nap" | "night";
  localDate: string;
}

interface SleepCache {
  /** All completed sleeps sorted by startMs */
  sorted: CachedSleep[];
  /** Completed naps sorted by startMs */
  naps: CachedSleep[];
  /** Completed nights sorted by startMs */
  nights: CachedSleep[];
  /** Completed sleeps grouped by local date (each group in startMs order) */
  byDay: Map<string, CachedSleep[]>;
  /** Number of completed naps per local date */
  napCountByDay: Map<string, number>;
  /** Days that have at least one night entry (complete data) */
  daysWithNight: Set<string>;
  /** Day keys sorted chronologically */
  sortedDayKeys: string[];
  /** Memoized learned nap count (undefined = not yet computed) */
  learnedNapCount: number | null | undefined;
}

function buildCache(ctx: BabyContext): SleepCache {
  const completed: CachedSleep[] = [];

  for (const s of ctx.recentSleeps) {
    if (!s.end_time) continue;
    completed.push({
      startMs: new Date(s.start_time).getTime(),
      endMs: new Date(s.end_time).getTime(),
      type: s.type,
      localDate: localDate(s.start_time, ctx.tz),
    });
  }

  completed.sort((a, b) => a.startMs - b.startMs);
  // naps and nights are subsets built in insertion order — re-derive from sorted
  // to avoid 2 extra sorts (they're small arrays but this is cleaner)
  const sortedNaps: CachedSleep[] = [];
  const sortedNights: CachedSleep[] = [];
  for (const cs of completed) {
    if (cs.type === "nap") sortedNaps.push(cs);
    else sortedNights.push(cs);
  }

  const byDay = new Map<string, CachedSleep[]>();
  const napCountByDay = new Map<string, number>();

  for (const cs of completed) {
    let dayList = byDay.get(cs.localDate);
    if (!dayList) {
      dayList = [];
      byDay.set(cs.localDate, dayList);
    }
    dayList.push(cs); // Already in startMs order
    if (cs.type === "nap") {
      napCountByDay.set(cs.localDate, (napCountByDay.get(cs.localDate) ?? 0) + 1);
    }
  }

  const daysWithNight = new Set<string>();
  for (const cs of completed) {
    if (cs.type === "night") daysWithNight.add(cs.localDate);
  }

  const sortedDayKeys = [...byDay.keys()].toSorted();

  return { sorted: completed, naps: sortedNaps, nights: sortedNights, byDay, napCountByDay, daysWithNight, sortedDayKeys, learnedNapCount: undefined };
}

function getCache(ctx: BabyContext): SleepCache {
  if (!ctx._cache) ctx._cache = buildCache(ctx);
  return ctx._cache as SleepCache;
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

  const cache = getCache(ctx);
  const avgWW = computeAvgNapWakeWindow(cache);
  if (avgWW === null) return defaultWW;

  const clampRange = getAdaptedWakeWindowRange(ctx);
  return Math.max(clampRange.minMinutes, Math.min(clampRange.maxMinutes, avgWW));
}

/**
 * Get wake window range adapted to the baby's actual nap pattern.
 *
 * For emerging_rhythm babies, the clamp is widened by 20% beyond the age
 * bracket so that early developers whose data consistently falls outside
 * the age table aren't forced back to population norms.
 */
function getAdaptedWakeWindowRange(ctx: BabyContext): { minMinutes: number; maxMinutes: number } {
  const ageRange = findByAge(WAKE_WINDOWS, ctx.ageMonths);
  const learnedNaps = getLearnedNapCount(ctx);

  let minWW = ageRange.minMinutes;
  let maxWW = ageRange.maxMinutes;

  if (learnedNaps !== null) {
    const ageNaps = findByAge(NAP_COUNTS, ctx.ageMonths).naps;
    if (learnedNaps !== ageNaps) {
      // Baby does fewer/more naps than age default. Find ALL age brackets where
      // this nap count is within the acceptable range, and look up the CORRESPONDING
      // wake window range by age (not by array index — the two tables have different sizes).
      for (const nc of NAP_COUNTS) {
        if (learnedNaps >= nc.range[0] && learnedNaps <= nc.range[1]) {
          const ww = findByAge(WAKE_WINDOWS, nc.minMonths);
          minWW = Math.min(minWW, ww.minMinutes);
          maxWW = Math.max(maxWW, ww.maxMinutes);
        }
      }
    }
  }

  // Emerging babies: widen the clamp so the engine can follow the baby's
  // actual rhythm rather than forcing it back to age-table boundaries
  if (ctx.strategy === "emerging_rhythm") {
    const margin = (maxWW - minWW) * 0.2;
    minWW = Math.max(15, minWW - margin);
    maxWW = maxWW + margin;
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
  const expectedNaps = resolveNapCount(ctx);
  const defaultWW = getWakeWindow(ctx);
  // During transitions, filter positional data to days matching the predicted nap count.
  // This prevents 2-nap wake windows (~120 min) from being used in 1-nap predictions (~240 min).
  const { wws: positionalWWs, durs: positionalDurs } =
    getPositionalDataForNapCount(ctx, expectedNaps);
  const defaultDuration = getLearnedNapDuration(ctx);

  // Habitual nap start anchoring: only meaningful once circadian rhythm develops (~5mo+)
  const useHabitualNapStart = feat(ctx, "habitualNapStart") && ctx.ageMonths >= 5;
  let habitualStarts: (number | undefined)[] = [];
  let habitualWeights: number[] = [];
  if (useHabitualNapStart) {
    // Single pass collects both start times and wake window samples
    const napData = collectHabitualNapData(ctx, expectedNaps);
    habitualStarts = computeHabitualNapStarts(wakeUpTime, ctx, expectedNaps, napData.startSamples);
    habitualWeights = computeHabitualNapWeights(expectedNaps, napData.startSamples, napData.wwSamples);
  }

  const predictions: PredictedNap[] = [];
  let currentWake = new Date(wakeUpTime);

  for (let i = 0; i < expectedNaps; i++) {
    const ww = positionalWWs[i] ?? defaultWW;
    const duration = (feat(ctx, "positionalDuration") ? positionalDurs[i] : undefined) ?? defaultDuration;
    const pressureStart = new Date(currentWake.getTime() + ww * 60 * 1000);

    // Blend pressure-based start with habitual start (like bedtime anchoring)
    // Sanity: habitual must be after current wake (can't nap before waking up)
    let napStart: Date;
    const habitualMs = habitualStarts[i];
    const weight = habitualWeights[i] ?? 0;
    if (habitualMs !== undefined && weight > 0 && habitualMs > currentWake.getTime()) {
      const blendedMs = pressureStart.getTime() * (1 - weight) + habitualMs * weight;
      napStart = new Date(Math.round(blendedMs));
    } else {
      napStart = pressureStart;
    }

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
    // At day start, all sleeps are synthetic (predicted, with future end times).
    // Reduce habitual influence since we're building on predictions, not actuals.
    const now = Date.now();
    const allSynthetic = todaySleeps.every((s) => !s.end_time || new Date(s.end_time).getTime() > now);
    const syntheticPenalty = allSynthetic ? 0.5 : 1.0;
    const weight = (hasEnoughNaps ? baseWeight : baseWeight * 0.5) * syntheticPenalty;
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

  const cache = getCache(ctx);

  // Collect wake windows by position across complete days only.
  // Skip days without night entries — their nap gaps may span missing overnight sleep.
  const gapsByPosition = new Map<number, number[]>();
  for (const [dayKey, daySleeps] of cache.byDay) {
    if (!cache.daysWithNight.has(dayKey)) continue;
    let napPosition = 0;
    for (let i = 1; i < daySleeps.length; i++) {
      if (daySleeps[i].type !== "nap") continue; // skip gaps before night sleep
      const gapMin = (daySleeps[i].startMs - daySleeps[i - 1].endMs) / 60000;
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
 * Get positional wake windows and durations filtered to days with a specific nap count.
 * During transitions (e.g. 2→1 naps), the overall averages are poisoned by data from
 * both schedules. This filters to only days that match the predicted schedule.
 * Falls back to unfiltered data if not enough filtered days.
 */
function getPositionalDataForNapCount(
  ctx: BabyContext,
  targetNapCount: number,
): { wws: number[]; durs: number[] } {
  if (ctx.recentSleeps.length < 4) return { wws: [], durs: [] };

  const cache = getCache(ctx);

  // Filter to complete days with the target nap count
  const matchingDayKeys: string[] = [];
  for (const [day, count] of cache.napCountByDay) {
    if (count === targetNapCount && cache.daysWithNight.has(day)) matchingDayKeys.push(day);
  }

  // Only apply filtering if there's actual mixed nap counts (transition).
  // If all days have the same count, or not enough matching days, use unfiltered.
  const uniqueCounts = new Set(cache.napCountByDay.values());
  if (uniqueCounts.size <= 1 || matchingDayKeys.length < 2) {
    return {
      wws: getPositionalWakeWindows(ctx),
      durs: feat(ctx, "positionalDuration") ? getPositionalNapDurations(ctx) : [],
    };
  }

  // Compute positional wake windows from matching days only
  const adaptedRange = getAdaptedWakeWindowRange(ctx);
  const gapsByPos = new Map<number, number[]>();
  const dursByPos = new Map<number, number[]>();

  for (const dayKey of matchingDayKeys) {
    const daySleeps = cache.byDay.get(dayKey)!;

    let napPos = 0;
    for (let i = 1; i < daySleeps.length; i++) {
      if (daySleeps[i].type !== "nap") continue;
      const gapMin = (daySleeps[i].startMs - daySleeps[i - 1].endMs) / 60000;
      if (gapMin >= 10 && gapMin <= 480) {
        if (!gapsByPos.has(napPos)) gapsByPos.set(napPos, []);
        gapsByPos.get(napPos)!.push(gapMin);
      }
      napPos++;
    }

    // Collect durations
    const dayNaps = daySleeps.filter((s) => s.type === "nap");
    for (let i = 0; i < dayNaps.length; i++) {
      const dur = (dayNaps[i].endMs - dayNaps[i].startMs) / 60_000;
      if (dur >= 10 && dur <= 180) {
        if (!dursByPos.has(i)) dursByPos.set(i, []);
        dursByPos.get(i)!.push(dur);
      }
    }
  }

  const wws: number[] = [];
  for (const [pos, gaps] of gapsByPos) {
    if (gaps.length < 2) continue;
    let avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    avg = Math.max(adaptedRange.minMinutes, Math.min(adaptedRange.maxMinutes, avg));
    wws[pos] = Math.round(avg);
  }

  const durs: number[] = [];
  if (feat(ctx, "positionalDuration")) {
    for (const [pos, ds] of dursByPos) {
      if (ds.length < 2) continue;
      durs[pos] = Math.round(ds.reduce((a, b) => a + b, 0) / ds.length);
    }
  }

  return { wws, durs };
}

/**
 * Compute per-position average nap durations from recent sleeps.
 * 1st nap of the day is typically longer than 2nd nap.
 * Returns a sparse array indexed by position (0-based).
 */
function getPositionalNapDurations(ctx: BabyContext): number[] {
  if (ctx.recentSleeps.length < 4) return [];

  const cache = getCache(ctx);
  const dursByPosition = new Map<number, number[]>();

  for (const [dayKey, daySleeps] of cache.byDay) {
    if (!cache.daysWithNight.has(dayKey)) continue;
    let napIdx = 0;
    for (const s of daySleeps) {
      if (s.type !== "nap") continue;
      const dur = (s.endMs - s.startMs) / 60_000;
      if (dur >= 10 && dur <= 180) {
        if (!dursByPosition.has(napIdx)) dursByPosition.set(napIdx, []);
        dursByPosition.get(napIdx)!.push(dur);
      }
      napIdx++;
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
  const cache = getCache(ctx);
  if (cache.learnedNapCount !== undefined) return cache.learnedNapCount;

  if (ctx.recentSleeps.length < 4 || cache.napCountByDay.size < 3) {
    cache.learnedNapCount = null;
    return null;
  }

  // Sort days with naps chronologically and apply recency weights.
  // Most recent day gets weight 1.0, each prior day decays by 0.8x.
  // Only include complete days (have a night entry) — incomplete days
  // may have inflated nap counts from misclassified overnight fragments.
  const sortedDays: [string, number][] = [];
  for (const day of cache.sortedDayKeys) {
    const count = cache.napCountByDay.get(day);
    if (count !== undefined && cache.daysWithNight.has(day)) sortedDays.push([day, count]);
  }

  if (sortedDays.length < 3) {
    cache.learnedNapCount = null;
    return null;
  }

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
  let result: number | null;
  if (sortedDays.length >= 5 && bestScore / totalWeight > 0.6) {
    result = bestCount;
  } else if (bestScore / totalWeight > 0.4) {
    result = bestCount;
  } else {
    result = null;
  }

  cache.learnedNapCount = result;
  return result;
}

/** Learn the bedtime wake window (last nap end -> night start) from recent data. */
export function getLearnedBedtimeWakeWindow(ctx: BabyContext): number {
  const wwRange = findByAge(WAKE_WINDOWS, ctx.ageMonths);
  const defaultWW = (wwRange.minMinutes + wwRange.maxMinutes) / 2 * 1.15;

  if (ctx.recentSleeps.length < 4) return defaultWW;

  const cache = getCache(ctx);

  // Collect gaps where the next sleep is a night (nap->night = bedtime gap)
  const gaps: number[] = [];
  for (let i = 1; i < cache.sorted.length; i++) {
    if (cache.sorted[i].type !== "night") continue;
    if (cache.sorted[i - 1].type !== "nap") continue;
    const gapMin = (cache.sorted[i].startMs - cache.sorted[i - 1].endMs) / 60000;
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

  const cache = getCache(ctx);

  if (feat(ctx, "weightedRecency")) {
    const samples = collectWeightedDurationsFromCache(cache.nights, 360, 900);
    if (samples.length < 2) return Math.round(defaultNight);
    const learned = weightedTrimmedMean(samples);
    return Math.round(blendEstimate(defaultNight, learned, samples.length, 2, 6));
  }

  // Simple average fallback
  if (cache.nights.length < 2) return Math.round(defaultNight);
  const durations = cache.nights
    .map((s) => (s.endMs - s.startMs) / 60000)
    .filter((d) => d >= 360 && d <= 900);
  if (durations.length < 2) return Math.round(defaultNight);
  return Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
}

/**
 * SHINE-derived total daytime sleep at a given age (minutes), linearly interpolated
 * between the published age bands (1, 6, 12, 24 months). Anchors the per-nap prior
 * so a 1-nap baby and a 2-nap baby of the same age get sensible — and different —
 * duration defaults, instead of a single hardcoded number that implicitly assumes
 * a fixed nap count.
 */
export function shineDaytimeSleepMinutes(ageMonths: number): number {
  const bands = daytimeSleepDuration;
  const age = Math.max(0, ageMonths);
  if (age <= bands[0].ageMonths) return bands[0].median;
  for (let i = 1; i < bands.length; i++) {
    const lo = bands[i - 1];
    const hi = bands[i];
    if (age <= hi.ageMonths) {
      const t = (age - lo.ageMonths) / (hi.ageMonths - lo.ageMonths);
      return lo.median + t * (hi.median - lo.median);
    }
  }
  return bands[bands.length - 1].median;
}

/**
 * Default per-nap duration prior (minutes): SHINE total daytime sleep / nap count,
 * clamped to a plausible range. Replaces the previous hardcoded 60/45/30 ladder
 * which silently assumed 2 naps and pulled 1-nap babies' predictions toward an
 * implausibly short value (e.g. 45 min for a 10-month-old who naps once a day).
 */
function defaultNapDurationPrior(ctx: BabyContext): number {
  const totalDaytime = shineDaytimeSleepMinutes(ctx.ageMonths);
  const napCount = Math.max(1, resolveNapCount(ctx));
  return clamp(Math.round(totalDaytime / napCount), 20, 180);
}

/** Learn average nap duration from recent completed naps, fallback to age-based defaults. */
export function getLearnedNapDuration(ctx: BabyContext): number {
  const defaultDuration = defaultNapDurationPrior(ctx);
  if (ctx.recentSleeps.length === 0) return defaultDuration;

  const cache = getCache(ctx);

  // Only learn from naps on complete days (have a night entry).
  // Naps from incomplete days may include misclassified overnight fragments.
  const completeNaps = cache.naps.filter((s) => cache.daysWithNight.has(s.localDate));

  if (feat(ctx, "weightedRecency")) {
    const samples = collectWeightedDurationsFromCache(completeNaps, 10, 180);
    if (samples.length < 3) return defaultDuration;
    const learned = weightedTrimmedMean(samples);
    return Math.round(blendEstimate(defaultDuration, learned, samples.length, 3, 8));
  }

  // Simple average fallback
  if (completeNaps.length < 3) return defaultDuration;
  const durations = completeNaps
    .map((s) => (s.endMs - s.startMs) / 60000)
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

/** Result of rescue nap analysis. */
export interface RescueNapInfo {
  /** Recommended time to wake the baby */
  recommendedWakeTime: string;
  /** Why this was flagged as a rescue nap */
  reason: "extra_nap" | "short_prior_nap" | "both";
}

/**
 * Compute the "short nap" threshold (minutes) in a cycle-aware way.
 *
 * A nap is "short" (needs rescue) if it missed at least one of the baby's
 * expected sleep cycles. We use `learnedNapMin - cycleMin * 0.5` so that:
 * - A 2-cycle napper (e.g. 110m with 55m cycle): threshold 82m → 1-cycle nap is short
 * - A 1-cycle napper (e.g. 55m with 55m cycle): threshold 27m → 36m+ nap is fine
 * - A 3-cycle napper: threshold flags missing a single cycle
 */
export function computeShortNapThreshold(learnedNapMin: number, cycleMin: number): number {
  return Math.max(
    RESCUE_NAP.SHORT_NAP_FLOOR_MIN,
    Math.round(learnedNapMin - cycleMin * 0.5),
  );
}

/**
 * Compute the rescue nap duration cap (minutes).
 *
 * We aim to wake during the light phase that precedes a cycle boundary — waking
 * in light sleep is smoother than waking from deep/REM. The target is midway
 * through the pre-boundary light window: `cycleMin - LIGHT_WINDOW / 2`.
 * Bounded by floor/ceiling to guard against bad data and runaway cycle estimates.
 */
export function computeRescueNapCap(learnedCycleMin: number): number {
  const target = Math.round(learnedCycleMin - RESCUE_NAP.LIGHT_WINDOW_MIN / 2);
  return Math.max(
    RESCUE_NAP.CAP_FLOOR_MIN,
    Math.min(RESCUE_NAP.CAP_CEILING_MIN, target),
  );
}

/**
 * Check if an active nap is a rescue nap and compute recommended wake time.
 * `shortNapThresholdMin` is the per-baby threshold below which the prior nap
 * counts as "short". `rescueCapMin` is the per-baby max rescue nap duration.
 * Returns null if this is a normal nap.
 */
export function detectRescueNap(
  napStartTime: string,
  completedNaps: { start_time: string; end_time: string }[],
  expectedNapCount: number,
  bedtime: string | null,
  shortNapThresholdMin: number,
  rescueCapMin: number,
): RescueNapInfo | null {
  const isExtraNap = completedNaps.length >= expectedNapCount;

  const lastNap = completedNaps[0]; // sorted most recent first
  const lastNapShort = lastNap && (
    (new Date(lastNap.end_time).getTime() - new Date(lastNap.start_time).getTime())
    < shortNapThresholdMin * 60_000
  );

  if (!isExtraNap && !lastNapShort) return null;

  const napStartMs = new Date(napStartTime).getTime();
  let capEndMs = napStartMs + rescueCapMin * 60_000;

  if (bedtime) {
    const bedtimeMs = new Date(bedtime).getTime();
    const latestEndMs = bedtimeMs - RESCUE_NAP.MIN_PRE_BEDTIME_WAKE * 60_000;
    capEndMs = Math.min(capEndMs, latestEndMs);
  }

  // Don't recommend waking before the nap even started
  if (capEndMs <= napStartMs) capEndMs = napStartMs + 20 * 60_000;

  const reason = isExtraNap && lastNapShort ? "both"
    : isExtraNap ? "extra_nap"
    : "short_prior_nap";

  return {
    recommendedWakeTime: new Date(capEndMs).toISOString(),
    reason,
  };
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

/** Compute average wake window before NAPS from cached sorted sleeps.
 *  Only includes gaps where both sleeps are from complete days (have a night). */
function computeAvgNapWakeWindow(cache: SleepCache): number | null {
  if (cache.sorted.length < 2) return null;

  const gaps: number[] = [];
  for (let i = 1; i < cache.sorted.length; i++) {
    if (cache.sorted[i].type !== "nap") continue;
    // Skip if either sleep's day is incomplete — the gap could span a missing night
    if (!cache.daysWithNight.has(cache.sorted[i].localDate)) continue;
    if (!cache.daysWithNight.has(cache.sorted[i - 1].localDate)) continue;
    const gapMin = (cache.sorted[i].startMs - cache.sorted[i - 1].endMs) / 60000;
    if (gapMin >= 10 && gapMin <= 480) {
      gaps.push(gapMin);
    }
  }

  if (gaps.length === 0) return null;
  return gaps.reduce((a, b) => a + b, 0) / gaps.length;
}

/** Collect recency-weighted duration samples from pre-filtered cached sleeps. */
function collectWeightedDurationsFromCache(
  items: CachedSleep[],
  minMinutes: number,
  maxMinutes: number,
): WeightedSample[] {
  // Sort by endMs for recency weighting (items are already sorted by startMs)
  const sorted = items.toSorted((a, b) => a.endMs - b.endMs);

  return sorted
    .map((s, idx) => ({
      value: (s.endMs - s.startMs) / 60_000,
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

/**
 * Estimate the baby's individual sleep cycle length from nap duration data.
 * Nap durations naturally cluster at cycle multiples (1×, 2×, 3×).
 * Returns the estimated cycle length or the age-based default.
 */
export function estimateSleepCycleFromData(ctx: BabyContext): number {
  const cache = getCache(ctx);
  const naps = cache.naps.filter((s) => cache.daysWithNight.has(s.localDate));
  if (naps.length < 5) return getSleepCycleMinutes(ctx.ageMonths);

  const durations = naps
    .map((s) => Math.round((s.endMs - s.startMs) / 60000))
    .filter((d) => d >= 20 && d <= 180);
  if (durations.length < 5) return getSleepCycleMinutes(ctx.ageMonths);

  // Test cycle lengths from 35-60 min and score each by how well
  // durations cluster at multiples
  let bestCycle = getSleepCycleMinutes(ctx.ageMonths);
  let bestScore = -Infinity;

  for (let c = 35; c <= 60; c++) {
    let score = 0;
    for (const d of durations) {
      // Distance to nearest cycle boundary
      const remainder = d % c;
      const dist = Math.min(remainder, c - remainder);
      // Gaussian-like scoring: closer to boundary = higher score
      score += Math.exp(-(dist * dist) / (8 * 8));
    }
    if (score > bestScore) {
      bestScore = score;
      bestCycle = c;
    }
  }

  return bestCycle;
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
  const cache = getCache(ctx);
  const durationSamples = collectWeightedDurationsFromCache(cache.nights, 360, 900);

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
  const cache = getCache(ctx);
  // cache.nights is already sorted by startMs
  return cache.nights.map((s, idx) => ({
    value: getLocalMinuteOfDay(new Date(s.startMs), ctx.tz),
    weight: Math.pow(0.85, cache.nights.length - 1 - idx),
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
  const cache = getCache(ctx);
  // cache.nights are already filtered for end_time; sort by endMs for recency
  const sorted = cache.nights.toSorted((a, b) => a.endMs - b.endMs);

  return sorted.map((s, idx) => ({
    value: getLocalMinuteOfDay(new Date(s.endMs), ctx.tz),
    weight: Math.pow(0.85, sorted.length - 1 - idx),
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

const minuteOfDayFormatters = new Map<string, Intl.DateTimeFormat>();
function getLocalMinuteOfDay(date: Date, tz: string): number {
  let fmt = minuteOfDayFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    minuteOfDayFormatters.set(tz, fmt);
  }
  const parts = fmt.formatToParts(date);

  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

function setLocalClockTime(dateStr: string, minuteOfDay: number, tz: string): Date {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return setHourInTz(new Date(`${dateStr}T12:00:00.000Z`), hour, minute, tz);
}

// ─── Habitual nap start anchoring ──────────────────────────────────────────

/**
 * Collect per-position nap start times AND wake window samples in a single pass.
 * Filters to days matching the target nap count during transitions.
 * Returns both datasets to avoid redundant day-grouping work.
 */
function collectHabitualNapData(
  ctx: BabyContext,
  targetNapCount: number,
): { startSamples: Map<number, WeightedSample[]>; wwSamples: Map<number, WeightedSample[]> } {
  const empty = { startSamples: new Map(), wwSamples: new Map() };
  if (ctx.recentSleeps.length < 4) return empty;

  const cache = getCache(ctx);

  // Filter to days matching target nap count during transitions
  const uniqueCounts = new Set(cache.napCountByDay.values());
  const useFiltered = uniqueCounts.size > 1;

  const startSamples = new Map<number, WeightedSample[]>();
  const wwSamples = new Map<number, WeightedSample[]>();

  for (let dayIdx = 0; dayIdx < cache.sortedDayKeys.length; dayIdx++) {
    const dayKey = cache.sortedDayKeys[dayIdx];
    if (!cache.daysWithNight.has(dayKey)) continue; // skip incomplete days
    const napCount = cache.napCountByDay.get(dayKey) ?? 0;
    if (napCount === 0) continue;

    // Skip days with wrong nap count during transitions
    if (useFiltered && napCount !== targetNapCount) continue;

    const recencyWeight = Math.pow(0.85, cache.sortedDayKeys.length - 1 - dayIdx);
    const daySleeps = cache.byDay.get(dayKey)!; // already sorted by startMs

    // Nap start times by position
    let pos = 0;
    for (const s of daySleeps) {
      if (s.type !== "nap") continue;
      const minuteOfDay = getLocalMinuteOfDay(new Date(s.startMs), ctx.tz);
      if (!startSamples.has(pos)) startSamples.set(pos, []);
      startSamples.get(pos)!.push({ value: minuteOfDay, weight: recencyWeight });
      pos++;
    }

    // Wake windows by position (gaps between consecutive sleeps before naps)
    // Previous day's last sleep end — needed for gap before the first nap,
    // since overnight sleeps are keyed to the day they started.
    let prevSleepEndMs: number | undefined;
    if (dayIdx > 0) {
      const prevDaySleeps = cache.byDay.get(cache.sortedDayKeys[dayIdx - 1]);
      if (prevDaySleeps && prevDaySleeps.length > 0) {
        prevSleepEndMs = prevDaySleeps[prevDaySleeps.length - 1].endMs;
      }
    }

    let napPos = 0;
    for (let i = 0; i < daySleeps.length; i++) {
      if (daySleeps[i].type !== "nap") continue;
      const prevEndMs = i > 0 ? daySleeps[i - 1].endMs : prevSleepEndMs;
      if (prevEndMs !== undefined) {
        const gapMin = (daySleeps[i].startMs - prevEndMs) / 60000;
        if (gapMin >= 10 && gapMin <= 480) {
          if (!wwSamples.has(napPos)) wwSamples.set(napPos, []);
          wwSamples.get(napPos)!.push({ value: gapMin, weight: recencyWeight });
        }
      }
      napPos++;
    }
  }

  return { startSamples, wwSamples };
}

/** Compute habitual nap start times (epoch ms) from pre-collected samples. */
function computeHabitualNapStarts(
  wakeUpTime: string,
  ctx: BabyContext,
  targetNapCount: number,
  startSamples: Map<number, WeightedSample[]>,
): (number | undefined)[] {
  if (startSamples.size === 0) return [];

  const wakeDate = isoToDateInTz(wakeUpTime, ctx.tz);
  const result: (number | undefined)[] = [];

  for (let pos = 0; pos < targetNapCount; pos++) {
    const posSamples = startSamples.get(pos);
    if (!posSamples || posSamples.length < 2) continue;
    const habitualMinute = weightedMedian(posSamples);
    result[pos] = setLocalClockTime(wakeDate, habitualMinute, ctx.tz).getTime();
  }

  return result;
}

/**
 * Compute habitual nap start weights from pre-collected samples.
 *
 * Dynamic approach:
 * - Absolute gate: SD > 40 min → no habitual signal
 * - Ratio: compare nap start SD vs wake window SD (clock vs pressure driven)
 * - Ramp: weight increases with sample count
 */
function computeHabitualNapWeights(
  targetNapCount: number,
  startSamples: Map<number, WeightedSample[]>,
  wwSamples: Map<number, WeightedSample[]>,
): number[] {
  if (startSamples.size === 0) return [];

  const weights: number[] = [];

  for (let pos = 0; pos < targetNapCount; pos++) {
    const napSamples = startSamples.get(pos);
    if (!napSamples || napSamples.length < 3) {
      weights[pos] = 0;
      continue;
    }

    const napStartSD = weightedSD(napSamples);

    // Absolute gate: if nap start times vary by more than 40 min SD,
    // there's no habitual signal worth anchoring to.
    if (napStartSD > 40) {
      weights[pos] = 0;
      continue;
    }

    // Base consistency weight from absolute SD
    // SD < 15 min → base 0.65, SD = 40 → base 0
    const consistencyWeight = clamp(1 - (napStartSD - 10) / 45, 0, 0.65);

    // If we have WW data, modulate by the ratio (clock vs pressure driven)
    const wwSamplesForPos = wwSamples.get(pos);
    let ratioModulator = 1.0;
    if (wwSamplesForPos && wwSamplesForPos.length >= 3) {
      const wwSD = weightedSD(wwSamplesForPos);
      // If WW SD >> nap start SD, timing is clock-driven → keep full weight
      // If WW SD << nap start SD, timing is pressure-driven → reduce weight
      if (napStartSD + wwSD > 0) {
        ratioModulator = clamp(wwSD / (napStartSD + wwSD) * 2, 0.3, 1.0);
      }
    }

    // Ramp up with sample count (like blendEstimate): 3 samples → 33%, 6+ → 100%
    const sampleRamp = clamp((napSamples.length - 2) / 4, 0.25, 1);

    weights[pos] = consistencyWeight * ratioModulator * sampleRamp;
  }

  return weights;
}

// ─── Plan scoring and selection ──────────────────────────────────────────────

export interface PlanCandidate {
  naps: PredictedNap[];
  bedtime: string;
}

export interface PlanScore {
  feasible: boolean;
  cost: number;
  hardViolations: string[];
}

export interface SelectedPlan extends PlanCandidate {
  source: "natural" | "target-guided";
}

const DAILY_SHIFT_CAP_MS = 15 * 60_000;

/** Convert a "HH:MM" target bedtime to an ISO timestamp for today in the baby's timezone. */
export function targetBedtimeToISO(hhmm: string, now: number, tz: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return setHourInTz(new Date(now), h, m, tz).toISOString();
}

/**
 * Build the sleep list for recommendBedtime: actual completed sleeps + synthetic
 * entries for active nap (predicted end) and remaining predicted naps.
 */
export function buildSleepsForBedtime(
  todaySleeps: SleepEntry[],
  activeSleep: SleepLogRow | undefined,
  remainingPredicted: PredictedNap[],
  ctx: BabyContext,
): SleepEntry[] {
  const sleeps = [...todaySleeps];
  if (activeSleep && activeSleep.type === "nap" && !activeSleep.end_time) {
    sleeps.push({
      start_time: activeSleep.start_time,
      end_time: predictNapEndTime(activeSleep.start_time, ctx),
      type: "nap",
    });
  }
  for (const pn of remainingPredicted) {
    sleeps.push({ start_time: pn.startTime, end_time: pn.endTime, type: "nap" });
  }
  return sleeps;
}

// Scoring weights
const W_TARGET = 1.0;
const W_WW = 0.5;
const W_DUR = 0.3;
const W_CYCLE = 0.1;

/** Score a candidate day plan against hard and soft constraints.
 *  @param expectedNapCount — the natural plan's nap count; plans with fewer naps get penalized. */
export function scorePlan(
  plan: PlanCandidate,
  ctx: BabyContext,
  wakeUpTimeMs: number,
  targetBedtimeMs?: number | null,
  expectedNapCount?: number,
): PlanScore {
  const hardViolations: string[] = [];
  const range = getAdaptedWakeWindowRange(ctx);
  const positionalWWs = getPositionalWakeWindows(ctx);
  const positionalDurs = getPositionalNapDurations(ctx);
  const cycleMin = getSleepCycleMinutes(ctx.ageMonths);
  const bedtimeMs = new Date(plan.bedtime).getTime();

  // Collect wake windows and nap durations
  let prevEnd = wakeUpTimeMs;
  const wws: number[] = [];
  const durs: number[] = [];

  for (let i = 0; i < plan.naps.length; i++) {
    const startMs = new Date(plan.naps[i].startTime).getTime();
    const endMs = new Date(plan.naps[i].endTime).getTime();
    const ww = (startMs - prevEnd) / 60_000;
    const dur = (endMs - startMs) / 60_000;

    wws.push(ww);
    durs.push(dur);

    // Hard: wake window within adapted range
    if (ww < range.minMinutes - 1 || ww > range.maxMinutes + 1) {
      hardViolations.push(`nap${i} ww ${Math.round(ww)}min outside [${range.minMinutes},${range.maxMinutes}]`);
    }

    // Hard: B8 — no nap within 60 min of bedtime
    if (startMs >= bedtimeMs - 60 * 60_000) {
      hardViolations.push(`nap${i} within 60min of bedtime`);
    }

    prevEnd = endMs;
  }

  // Hard: final wake window (last sleep end → bedtime, or wake → bedtime if no naps)
  // The pre-bedtime wake window is naturally longer than mid-day wake windows,
  // so we use a wider range: up to 1.3× the normal max.
  {
    const finalWW = (bedtimeMs - prevEnd) / 60_000;
    const finalMax = Math.round(range.maxMinutes * 1.3);
    if (finalWW < range.minMinutes - 1 || finalWW > finalMax + 1) {
      hardViolations.push(`final ww ${Math.round(finalWW)}min outside [${range.minMinutes},${finalMax}]`);
    }
  }

  if (hardViolations.length > 0) {
    return { feasible: false, cost: Infinity, hardViolations };
  }

  // Soft costs (minutes²)
  let cost = 0;

  // Target proximity
  if (targetBedtimeMs != null) {
    const diffMin = (bedtimeMs - targetBedtimeMs) / 60_000;
    cost += W_TARGET * diffMin * diffMin;
  }

  // Wake window deviation from learned positional values
  for (let i = 0; i < wws.length; i++) {
    const learned = positionalWWs[i];
    if (learned !== undefined) {
      const diff = wws[i] - learned;
      cost += W_WW * diff * diff;
    }
  }

  // Nap duration deviation from learned positional values
  for (let i = 0; i < durs.length; i++) {
    const learned = positionalDurs[i];
    if (learned !== undefined) {
      const diff = durs[i] - learned;
      cost += W_DUR * diff * diff;
    }
  }

  // Cycle alignment
  for (const dur of durs) {
    const snapped = snapToCycleBoundary(dur, cycleMin, 1, 3, 10, 180);
    const diff = dur - snapped;
    cost += W_CYCLE * diff * diff;
  }

  // Nap count penalty: dropping naps to hit a target is too aggressive
  if (expectedNapCount !== undefined && plan.naps.length < expectedNapCount) {
    const dropped = expectedNapCount - plan.naps.length;
    cost += 500 * dropped; // Heavy penalty per dropped nap
  }

  return { feasible: true, cost, hardViolations: [] };
}

/**
 * Generate and score natural + target-guided plans, return the best feasible one.
 * When no target is set, returns the natural (forward-walk) plan directly.
 */
export function selectBestPlan(
  wakeUpTime: string,
  todaySleeps: SleepEntry[],
  activeSleep: SleepLogRow | undefined,
  ctx: BabyContext,
  now: number,
): SelectedPlan {
  const wakeUpMs = new Date(wakeUpTime).getTime();

  // Natural plan: forward walk + learned bedtime
  const naturalNaps = predictDayNaps(wakeUpTime, ctx);
  const sleepsForBedtime = buildSleepsForBedtime(todaySleeps, activeSleep, naturalNaps, ctx);
  const naturalBedtime = recommendBedtime(sleepsForBedtime, ctx);
  const naturalPlan: PlanCandidate = { naps: naturalNaps, bedtime: naturalBedtime };

  if (!ctx.targetBedtime) {
    return { ...naturalPlan, source: "natural" };
  }

  // Compute effective target (capped ±15 min from natural bedtime)
  const naturalBedtimeMs = new Date(naturalBedtime).getTime();
  const rawTargetMs = new Date(targetBedtimeToISO(ctx.targetBedtime, now, ctx.tz)).getTime();
  const shift = Math.max(-DAILY_SHIFT_CAP_MS, Math.min(DAILY_SHIFT_CAP_MS, rawTargetMs - naturalBedtimeMs));
  const effectiveTargetMs = naturalBedtimeMs + shift;
  const effectiveTarget = new Date(effectiveTargetMs).toISOString();

  // Target-guided plan: backward walk from effective target
  const targetNaps = planBackwardFromBedtime(wakeUpTime, effectiveTarget, ctx);
  const targetPlan: PlanCandidate = { naps: targetNaps, bedtime: effectiveTarget };

  // Score both against the effective target (today's objective), not the raw target
  const naturalScore = scorePlan(naturalPlan, ctx, wakeUpMs, effectiveTargetMs, naturalNaps.length);
  const targetScore = scorePlan(targetPlan, ctx, wakeUpMs, effectiveTargetMs, naturalNaps.length);

  if (targetScore.feasible && targetScore.cost <= naturalScore.cost) {
    return { ...targetPlan, source: "target-guided" };
  }
  return { ...naturalPlan, source: "natural" };
}
