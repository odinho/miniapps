/**
 * Newborn prediction engine (Phase A/B: ~0–8 weeks).
 *
 * Not a schedule predictor — a "what comes next" advisor.
 * Ignores nap/night labels for learning. Uses all episodes as
 * undifferentiated sleep for wake window and duration calculations.
 *
 * Outputs:
 * - Sleep window (earliest–latest likely next sleep)
 * - Sleep pressure level
 * - Expected sleep duration as a range
 * - 24h rolling sleep total
 * - Longest stretch + trend
 * - Age norms comparison
 */
import type { SleepEntry } from "$lib/types.js";
import {
  computeRollingSleepStats,
  computeLongestStretchTrend,
  computeSleepPressure,
  computeSleepWindow,
  extractWakeWindows,
  getAgeNorms,
  type RollingSleepStats,
  type LongestStretchTrend,
  type AgeNorms,
} from "./features.js";

export interface NewbornPrediction {
  strategy: "newborn_guidance";
  /** Sleep window: when the next sleep is likely to start */
  sleepWindow: { earliest: string; latest: string };
  /** Current sleep pressure level */
  sleepPressure: "low" | "rising" | "high";
  /** Expected duration of next sleep episode (minutes) */
  expectedDuration: { min: number; max: number };
  /** Rolling 24h sleep stats */
  rolling: RollingSleepStats;
  /** Longest stretch trend (week over week) */
  longestStretchTrend: LongestStretchTrend;
  /** Age-appropriate norms */
  ageNorms: AgeNorms;
}

export interface NewbornContext {
  ageMonths: number;
  tz: string;
  /** All recent sleep entries (14-30 days lookback) */
  recentSleeps: SleepEntry[];
  /** When the last sleep ended (epoch ms), or null if no completed sleeps */
  lastSleepEndMs: number | null;
  /** Optional override for "now" (epoch ms) */
  now?: number;
}

/** Run the newborn prediction engine. */
export function predictNewborn(ctx: NewbornContext): NewbornPrediction {
  const now = ctx.now ?? Date.now();
  const recentWakeWindows = extractWakeWindows(ctx.recentSleeps);
  const rolling = computeRollingSleepStats(ctx.recentSleeps, ctx.tz, now);
  const trend = computeLongestStretchTrend(ctx.recentSleeps, ctx.tz, now);
  const ageNorms = getAgeNorms(ctx.ageMonths);

  // Sleep window and pressure — need a last sleep end time
  let sleepWindow: { earliest: string; latest: string };
  let sleepPressure: "low" | "rising" | "high";

  if (ctx.lastSleepEndMs !== null) {
    const window = computeSleepWindow(ctx.lastSleepEndMs, recentWakeWindows, ctx.ageMonths);
    sleepWindow = {
      earliest: new Date(window.earliestMs).toISOString(),
      latest: new Date(window.latestMs).toISOString(),
    };
    sleepPressure = computeSleepPressure(ctx.lastSleepEndMs, ctx.ageMonths, now);
  } else {
    // No data — show wide window and neutral pressure
    sleepWindow = {
      earliest: new Date(now + 15 * 60_000).toISOString(),
      latest: new Date(now + 60 * 60_000).toISOString(),
    };
    sleepPressure = "rising";
  }

  // Expected duration range from recent episodes
  const expectedDuration = computeExpectedDuration(ctx.recentSleeps, ctx.ageMonths);

  return {
    strategy: "newborn_guidance",
    sleepWindow,
    sleepPressure,
    expectedDuration,
    rolling,
    longestStretchTrend: trend,
    ageNorms,
  };
}

/** Compute expected next sleep duration range from recent episodes. */
function computeExpectedDuration(
  sleeps: SleepEntry[],
  ageMonths: number,
): { min: number; max: number } {
  const durations: number[] = [];
  for (const s of sleeps) {
    if (!s.end_time) continue;
    const dur = (new Date(s.end_time).getTime() - new Date(s.start_time).getTime()) / 60_000;
    if (dur >= 10 && dur <= 600) durations.push(dur);
  }

  if (durations.length < 3) {
    // Age-based fallback ranges
    if (ageMonths < 1) return { min: 30, max: 240 };
    if (ageMonths < 2) return { min: 30, max: 210 };
    if (ageMonths < 3) return { min: 30, max: 180 };
    return { min: 30, max: 150 };
  }

  const sorted = durations.toSorted((a, b) => a - b);
  const p15 = sorted[Math.floor(sorted.length * 0.15)];
  const p85 = sorted[Math.floor(sorted.length * 0.85)];
  return {
    min: Math.round(Math.max(10, p15 - 10)),
    max: Math.round(p85 + 15),
  };
}
