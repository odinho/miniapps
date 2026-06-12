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
  coalesceNightFragments,
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
  // A polyphasic night logged as several `night` rows reads as one logical
  // night with derived wakings, so fragmented and "one long night + waking"
  // logging converge on the same stats.
  const sleeps = coalesceNightFragments(ctx.recentSleeps);
  const recentWakeWindows = extractWakeWindows(sleeps);
  const rolling = computeRollingSleepStats(sleeps, ctx.tz, now);
  const trend = computeLongestStretchTrend(sleeps, ctx.tz, now);
  const ageNorms = getAgeNorms(ctx.ageMonths);

  // Sleep window and pressure — need a last sleep end time
  let sleepWindow: { earliest: string; latest: string };
  let sleepPressure: "low" | "rising" | "high";

  if (ctx.lastSleepEndMs !== null) {
    const window = computeSleepWindow(ctx.lastSleepEndMs, recentWakeWindows, ctx.ageMonths);
    // Invariant: sleepWindow.earliest ≥ now − 15 min.
    // computeSleepWindow anchors on lastSleepEndMs which can be hours in the past
    // (e.g. overnight sleep ending 03:00, now 07:00 → window 03:50–04:50).
    // Shift the window forward if it has already passed so the display stays meaningful.
    const graceMs = 15 * 60_000;
    const earliestMs = window.earliestMs < now - graceMs ? now - graceMs : window.earliestMs;
    const windowWidthMs = window.latestMs - window.earliestMs;
    sleepWindow = {
      earliest: new Date(earliestMs).toISOString(),
      latest: new Date(earliestMs + windowWidthMs).toISOString(),
    };
    sleepPressure = computeSleepPressure(ctx.lastSleepEndMs, ctx.ageMonths, now, recentWakeWindows);
  } else {
    // No data — show wide window and neutral pressure
    sleepWindow = {
      earliest: new Date(now + 15 * 60_000).toISOString(),
      latest: new Date(now + 60 * 60_000).toISOString(),
    };
    sleepPressure = "rising";
  }

  // Expected duration range from recent episodes
  const expectedDuration = computeExpectedDuration(sleeps, ctx.ageMonths);

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

/**
 * Compute expected next sleep duration range from recent episodes.
 *
 * Blends age-based fallback ranges with observed data gradually as sample
 * count grows (3→8 samples), avoiding abrupt jumps from population norms
 * to sparse baby data.
 */
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

  // Age-based fallback ranges
  const ageMin = 30;
  const ageMax = ageMonths < 1 ? 240 : ageMonths < 2 ? 210 : ageMonths < 3 ? 180 : 150;

  if (durations.length < 3) {
    return { min: ageMin, max: ageMax };
  }

  const sorted = durations.toSorted((a, b) => a - b);
  const babyMin = Math.max(10, sorted[Math.floor(sorted.length * 0.15)] - 10);
  const babyMax = sorted[Math.floor(sorted.length * 0.85)] + 15;

  // Ramp blend: 0 at 3 samples, 1 at 8+ samples
  const blend = Math.min(1, (durations.length - 3) / 5);
  return {
    min: Math.round(ageMin * (1 - blend) + babyMin * blend),
    max: Math.round(ageMax * (1 - blend) + babyMax * blend),
  };
}
