/**
 * Emerging rhythm prediction engine (Phase B/C: ~6 weeks – 5 months).
 *
 * The transition bridge between newborn guidance and routine schedule.
 * Not a separate giant engine — a constrained adapter that uses schedule-mode
 * outputs where signals are strong and window/range outputs where signals are weak.
 *
 * Key insight: different nap positions mature at different rates. The 1st nap
 * becomes consistent first, later naps are more variable.
 */
import type { SleepEntry, BabyContext } from "$lib/types.js";
import type { PredictedNap } from "./schedule.js";
import {
  predictDayNaps,
  recommendBedtime,
} from "./schedule.js";
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

export interface EmergingPrediction {
  strategy: "emerging_rhythm";
  /** Schedule-derived nap predictions (may be softened with ranges) */
  predictedNaps: PredictedNap[] | null;
  /** Next nap as a range if confidence is low, point if high */
  nextNap: string | null;
  /** Bedtime as a point prediction (may be low confidence) */
  bedtime: string | null;
  /** Sleep window fallback (used when schedule confidence is very low) */
  sleepWindow: { earliest: string; latest: string } | null;
  /** Current sleep pressure level */
  sleepPressure: "low" | "rising" | "high" | null;
  /** Rolling 24h stats (context card) */
  rolling: RollingSleepStats;
  /** Longest stretch trend */
  longestStretchTrend: LongestStretchTrend;
  /** Age norms */
  ageNorms: AgeNorms;
}

export interface EmergingContext {
  ctx: BabyContext;
  todaySleeps: SleepEntry[];
  wakeUpTime: string | null;
  lastSleepEndMs: number | null;
  now?: number;
}

/** Run the emerging rhythm prediction engine. */
export function predictEmerging(input: EmergingContext): EmergingPrediction {
  const { ctx, todaySleeps, wakeUpTime, lastSleepEndMs } = input;
  const now = input.now ?? Date.now();

  // Context-card metrics treat a fragmented night as one logical night (see
  // predictNewborn). Schedule learning below still uses raw rows.
  const coalesced = coalesceNightFragments(ctx.recentSleeps);
  const rolling = computeRollingSleepStats(coalesced, ctx.tz, now);
  const trend = computeLongestStretchTrend(coalesced, ctx.tz, now);
  const ageNorms = getAgeNorms(ctx.ageMonths);

  // Try schedule-based predictions
  let predictedNaps: PredictedNap[] | null = null;
  let nextNap: string | null = null;
  let bedtime: string | null = null;

  if (wakeUpTime) {
    predictedNaps = predictDayNaps(wakeUpTime, ctx);
    bedtime = recommendBedtime(todaySleeps, ctx, now);

    // Derive next nap from predicted naps
    const completedNaps = todaySleeps.filter((s) => s.type === "nap" && s.end_time).length;
    if (predictedNaps.length > completedNaps) {
      nextNap = predictedNaps[completedNaps].startTime;
    }
  }

  // Sleep window fallback for when schedule confidence is very low
  let sleepWindow: { earliest: string; latest: string } | null = null;
  let sleepPressure: "low" | "rising" | "high" | null = null;

  if (lastSleepEndMs !== null) {
    const wws = extractWakeWindows(coalesced);
    const window = computeSleepWindow(lastSleepEndMs, wws, ctx.ageMonths);
    // Same invariant as newborn: earliest ≥ now − 15 min.
    const graceMs = 15 * 60_000;
    const earliestMs = window.earliestMs < now - graceMs ? now - graceMs : window.earliestMs;
    const windowWidthMs = window.latestMs - window.earliestMs;
    sleepWindow = {
      earliest: new Date(earliestMs).toISOString(),
      latest: new Date(earliestMs + windowWidthMs).toISOString(),
    };
    sleepPressure = computeSleepPressure(lastSleepEndMs, ctx.ageMonths, now, wws);
  }

  return {
    strategy: "emerging_rhythm",
    predictedNaps,
    nextNap,
    bedtime,
    sleepWindow,
    sleepPressure,
    rolling,
    longestStretchTrend: trend,
    ageNorms,
  };
}
