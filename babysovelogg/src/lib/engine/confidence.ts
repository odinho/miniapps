/**
 * Confidence intervals for sleep predictions.
 *
 * Uses variance from the lookback window to produce prediction ranges.
 * Wider when the baby's pattern is variable, narrower when consistent.
 * Falls back to age-based ranges when data is sparse.
 */

import { WAKE_WINDOWS, findByAge } from "./constants.js";
import type { SleepEntry } from "$lib/types.js";
import type { PredictedNap } from "./schedule.js";
import { isoToDateInTz } from "$lib/tz.js";

export interface PredictionRange {
  point: string; // ISO timestamp (best estimate)
  lo: string;    // ISO timestamp (early bound, ~-1 SD)
  hi: string;    // ISO timestamp (late bound, ~+1 SD)
  sdMinutes: number; // standard deviation in minutes
}

export interface NapPredictionWithRange extends PredictedNap {
  startRange: PredictionRange;
}

export interface ConfidenceResult {
  napRanges: NapPredictionWithRange[];
  bedtimeRange: PredictionRange;
  /** Overall confidence level: "high" (SD<15), "medium" (SD<30), "low" (SD≥30 or sparse data) */
  level: "high" | "medium" | "low";
  /** Number of days of data used for variance estimation */
  dataPoints: number;
}

const MIN_SD_MINUTES = 10; // Even consistent babies vary by ±10 min

/**
 * Confidence range around an active sleep's predicted wake time. Built from
 * the same per-sleep-type duration variance the schedule engine uses for
 * predictions, so a baby with very consistent naps gets a tight band and
 * a noisy one gets a wide one. Returns null when wakePoint is null.
 */
export function computeWakeRange(
  wakePoint: string | null,
  type: "nap" | "night",
  ageMonths: number,
  recentSleeps?: SleepEntry[],
): PredictionRange | null {
  if (!wakePoint) return null;
  const durationSd =
    type === "night"
      ? getNightDurationStats(recentSleeps, ageMonths).sd
      : getNapDurationStats(recentSleeps, ageMonths).sd;
  return makeRange(wakePoint, Math.max(MIN_SD_MINUTES, durationSd));
}

/**
 * Compute confidence intervals for a set of predicted naps and bedtime.
 */
export function computeConfidence(
  predictedNaps: PredictedNap[],
  predictedBedtime: string,
  ageMonths: number,
  recentSleeps?: SleepEntry[],
  tz?: string,
): ConfidenceResult {
  const timezone = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const napWWStats = getNapWakeWindowStats(recentSleeps, ageMonths, timezone);
  const bedtimeWWStats = getBedtimeWakeWindowStats(recentSleeps, ageMonths);
  const napDurationStats = getNapDurationStats(recentSleeps, ageMonths);

  // For naps, uncertainty compounds: each nap's start depends on the previous nap's end
  const napRanges: NapPredictionWithRange[] = predictedNaps.map((nap, i) => {
    // Compounding: SD grows with sqrt(n) for independent errors
    const posSD = napWWStats.positionalSDs[i] ?? napWWStats.globalSD;
    // Combined uncertainty: wake window SD + nap duration SD for prior naps
    const compoundedSD = Math.sqrt(
      posSD ** 2 * (i + 1) + napDurationStats.sd ** 2 * i,
    );
    const napSD = Math.max(MIN_SD_MINUTES, compoundedSD);

    return {
      ...nap,
      startRange: makeRange(nap.startTime, napSD),
    };
  });

  const bedtimeSD = Math.max(MIN_SD_MINUTES, bedtimeWWStats.sd);
  const bedtimeRange = makeRange(predictedBedtime, bedtimeSD);

  // Overall confidence from worst of (median nap SD, bedtime SD) + data scarcity
  const allSDs = napRanges.map((n) => n.startRange.sdMinutes);
  const medianSD = allSDs.length > 0
    ? allSDs.toSorted((a, b) => a - b)[Math.floor(allSDs.length / 2)]
    : bedtimeSD;
  const worstSD = Math.max(medianSD, bedtimeSD);
  // Thresholds calibrated to typical baby sleep variability (~20-35 min SD is normal)
  const level: ConfidenceResult["level"] =
    napWWStats.dataPoints < 3 ? "low"
    : worstSD < 20 ? "high"
    : worstSD < 40 ? "medium"
    : "low";

  return {
    napRanges,
    bedtimeRange,
    level,
    dataPoints: napWWStats.dataPoints,
  };
}

function makeRange(isoPoint: string, sdMinutes: number): PredictionRange {
  const ms = new Date(isoPoint).getTime();
  const sdMs = sdMinutes * 60_000;
  return {
    point: isoPoint,
    lo: new Date(ms - sdMs).toISOString(),
    hi: new Date(ms + sdMs).toISOString(),
    sdMinutes: Math.round(sdMinutes),
  };
}

// ─── Wake window statistics ──────────────────────────────────────────────────

interface WakeWindowStats {
  globalSD: number;
  positionalSDs: number[]; // sparse, indexed by nap position
  dataPoints: number;
}

function getNapWakeWindowStats(
  recentSleeps: SleepEntry[] | undefined,
  ageMonths: number,
  tz: string,
): WakeWindowStats {
  const ageRange = findByAge(WAKE_WINDOWS, ageMonths);
  const fallbackSD = (ageRange.maxMinutes - ageRange.minMinutes) / 4; // ~1 SD of full range

  if (!recentSleeps || recentSleeps.length < 4) {
    return { globalSD: fallbackSD, positionalSDs: [], dataPoints: 0 };
  }

  // Group by start-anchored local day, then collect wake→nap gaps by position.
  // The morning overnight that ends *this* morning is start-anchored to
  // YESTERDAY's bucket, so position 0's gap (morning wake → nap1) has to be
  // anchored to the previous day's last night end — mirroring schedule.ts's
  // `morningWakeMs`. Without it, the first gap measured inside today's bucket
  // is nap1→nap2 and every positional SD is shifted by one (Codex/Claude
  // 2026-06-12 deep-review bug #1).
  const byDay = new Map<string, SleepEntry[]>();
  for (const s of recentSleeps) {
    if (!s.end_time) continue;
    const day = isoToDateInTz(s.start_time, tz);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(s);
  }
  const sortedDayKeys = [...byDay.keys()].toSorted();
  for (const [day, list] of byDay) {
    byDay.set(day, list.toSorted((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()));
  }
  const morningWakeMs = (dayKey: string): number | null => {
    const idx = sortedDayKeys.indexOf(dayKey);
    if (idx <= 0) return null;
    const prev = byDay.get(sortedDayKeys[idx - 1]);
    if (!prev) return null;
    for (let k = prev.length - 1; k >= 0; k--) {
      if (prev[k].type === "night") return new Date(prev[k].end_time!).getTime();
    }
    return null;
  };

  const gapsByPosition = new Map<number, number[]>();
  const allGaps: number[] = [];

  for (const dayKey of sortedDayKeys) {
    const daySleeps = byDay.get(dayKey)!;
    const priorEndMs = morningWakeMs(dayKey);

    let napPos = 0;
    for (let i = 0; i < daySleeps.length; i++) {
      if (daySleeps[i].type !== "nap") continue;
      const prevEndMs = i === 0 ? priorEndMs : new Date(daySleeps[i - 1].end_time!).getTime();
      if (prevEndMs == null) {
        napPos++;
        continue;
      }
      const gapMin = (new Date(daySleeps[i].start_time).getTime() - prevEndMs) / 60_000;
      if (gapMin >= 10 && gapMin <= 480) {
        if (!gapsByPosition.has(napPos)) gapsByPosition.set(napPos, []);
        gapsByPosition.get(napPos)!.push(gapMin);
        allGaps.push(gapMin);
      }
      napPos++;
    }
  }

  const globalSD = allGaps.length >= 3 ? sd(allGaps) : fallbackSD;

  const positionalSDs: number[] = [];
  for (const [pos, gaps] of gapsByPosition) {
    positionalSDs[pos] = gaps.length >= 3 ? sd(gaps) : globalSD;
  }

  return { globalSD, positionalSDs, dataPoints: byDay.size };
}

function getBedtimeWakeWindowStats(
  recentSleeps: SleepEntry[] | undefined,
  ageMonths: number,
): { sd: number } {
  const ageRange = findByAge(WAKE_WINDOWS, ageMonths);
  const fallbackSD = (ageRange.maxMinutes - ageRange.minMinutes) / 3;

  if (!recentSleeps || recentSleeps.length < 4) {
    return { sd: fallbackSD };
  }

  const sorted = [...recentSleeps]
    .filter((s) => s.end_time)
    .toSorted((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].type !== "night" || sorted[i - 1].type !== "nap") continue;
    const gapMin = (new Date(sorted[i].start_time).getTime() - new Date(sorted[i - 1].end_time!).getTime()) / 60_000;
    if (gapMin >= 60 && gapMin <= 600) {
      gaps.push(gapMin);
    }
  }

  return { sd: gaps.length >= 3 ? sd(gaps) : fallbackSD };
}

function getNapDurationStats(
  recentSleeps: SleepEntry[] | undefined,
  ageMonths: number,
): { sd: number } {
  if (!recentSleeps || recentSleeps.length < 3) {
    return { sd: ageMonths < 6 ? 20 : 15 };
  }

  // Compute self-wake median to drop obvious cut-shorts before measuring SD.
  // A 41-min "door opened" wake doesn't reflect natural variability — it's
  // noise that inflates the confidence band and makes the UI look more
  // uncertain than the engine actually is.
  const naps = recentSleeps.filter((s) => s.type === "nap" && s.end_time);
  const selfDurs = naps
    .filter((s) => s.woke_by === "self")
    .map((s) => (new Date(s.end_time!).getTime() - new Date(s.start_time).getTime()) / 60_000)
    .filter((d) => d >= 10 && d <= 180);

  let median: number | null = null;
  if (selfDurs.length >= 3) {
    const sorted = selfDurs.toSorted((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  const durations = naps
    .filter((s) => {
      if (median === null || s.woke_by !== "woken") return true;
      const dur = (new Date(s.end_time!).getTime() - new Date(s.start_time).getTime()) / 60_000;
      return dur >= median;
    })
    .map((s) => (new Date(s.end_time!).getTime() - new Date(s.start_time).getTime()) / 60_000)
    .filter((d) => d >= 10 && d <= 180);

  if (durations.length < 3) return { sd: ageMonths < 6 ? 20 : 15 };
  // Floor the SD so a perfectly consistent baby doesn't get an absurdly tight
  // confidence interval (the model still has its own irreducible error).
  return { sd: Math.max(MIN_SD_MINUTES, sd(durations)) };
}

function getNightDurationStats(
  recentSleeps: SleepEntry[] | undefined,
  ageMonths: number,
): { sd: number } {
  // Night sleep is the longest single sleep, so its variance dwarfs naps —
  // ~45m SD for young infants, settling to ~30m once a rhythm forms.
  const fallback = ageMonths < 6 ? 45 : 30;
  if (!recentSleeps || recentSleeps.length < 3) return { sd: fallback };

  // Match the 360–900 min plausibility window used by getLearnedNightDuration
  // in schedule.ts so the variance samples align with the point estimate.
  const durations = recentSleeps
    .filter((s) => s.type === "night" && s.end_time)
    .map((s) => (new Date(s.end_time!).getTime() - new Date(s.start_time).getTime()) / 60_000)
    .filter((d) => d >= 360 && d <= 900);

  if (durations.length < 3) return { sd: fallback };
  return { sd: Math.max(MIN_SD_MINUTES, sd(durations)) };
}

// ─── Math ────────────────────────────────────────────────────────────────────

function sd(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}
