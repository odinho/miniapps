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
import { isoToDateInTz } from "$lib/tz.js";

export interface EmergingPrediction {
  strategy: "emerging_rhythm";
  /** Schedule-derived nap predictions (may be softened with ranges) */
  predictedNaps: PredictedNap[] | null;
  /** Next nap as a range if confidence is low, point if high */
  nextNap: string | null;
  /** Bedtime as a point prediction (may be low confidence) */
  bedtime: string | null;
  /** Per-nap confidence: which positions are reliable vs variable */
  napConfidence: ("high" | "medium" | "low")[];
  /** Whether bedtime prediction is trustworthy */
  bedtimeConfidence: "high" | "medium" | "low";
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

  // Always compute context data (useful regardless of schedule confidence)
  const rolling = computeRollingSleepStats(ctx.recentSleeps, ctx.tz, now);
  const trend = computeLongestStretchTrend(ctx.recentSleeps, ctx.tz, now);
  const ageNorms = getAgeNorms(ctx.ageMonths);

  // Compute per-position nap start consistency from recent data
  const napStartSDs = computeNapStartConsistency(ctx.recentSleeps, ctx.tz);
  const bedtimeSD = computeBedtimeConsistency(ctx.recentSleeps, ctx.tz);

  // Try schedule-based predictions
  let predictedNaps: PredictedNap[] | null = null;
  let nextNap: string | null = null;
  let bedtime: string | null = null;
  const napConfidence: ("high" | "medium" | "low")[] = [];
  let bedtimeConfidence: "high" | "medium" | "low" = "low";

  if (wakeUpTime) {
    predictedNaps = predictDayNaps(wakeUpTime, ctx);
    bedtime = recommendBedtime(todaySleeps, ctx, now);

    // Classify confidence per nap position
    for (let i = 0; i < predictedNaps.length; i++) {
      const sd = napStartSDs[i] ?? Infinity;
      if (sd < 20) napConfidence.push("high");
      else if (sd < 40) napConfidence.push("medium");
      else napConfidence.push("low");
    }

    // Bedtime confidence
    if (bedtimeSD < 20) bedtimeConfidence = "high";
    else if (bedtimeSD < 45) bedtimeConfidence = "medium";
    else bedtimeConfidence = "low";

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
    const wws = extractWakeWindows(ctx.recentSleeps);
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
    napConfidence,
    bedtimeConfidence,
    sleepWindow,
    sleepPressure,
    rolling,
    longestStretchTrend: trend,
    ageNorms,
  };
}

// ─── Consistency computation ──────────────────────────────────────────────────

/** Compute per-position nap start time SD (minutes). */
function computeNapStartConsistency(sleeps: SleepEntry[], tz: string): number[] {
  const byDay = new Map<string, SleepEntry[]>();
  for (const s of sleeps) {
    if (!s.end_time || s.type !== "nap") continue;
    const date = isoToDateInTz(s.start_time, tz);
    let day = byDay.get(date);
    if (!day) { day = []; byDay.set(date, day); }
    day.push(s);
  }

  // Sort each day's naps by start time
  for (const naps of byDay.values()) {
    naps.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
  }

  // Collect start-time minutes-of-day per position
  const byPosition = new Map<number, number[]>();
  for (const naps of byDay.values()) {
    for (let i = 0; i < naps.length; i++) {
      const minuteOfDay = getMinuteOfDay(new Date(naps[i].start_time), tz);
      let pos = byPosition.get(i);
      if (!pos) { pos = []; byPosition.set(i, pos); }
      pos.push(minuteOfDay);
    }
  }

  // Compute SD per position
  const result: number[] = [];
  for (const [pos, values] of byPosition) {
    if (values.length < 2) {
      result[pos] = Infinity;
      continue;
    }
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    result[pos] = Math.sqrt(variance);
  }
  return result;
}

/** Compute bedtime start time SD (minutes). */
function computeBedtimeConsistency(sleeps: SleepEntry[], tz: string): number {
  const bedtimeMinutes: number[] = [];
  for (const s of sleeps) {
    if (!s.end_time || s.type !== "night") continue;
    bedtimeMinutes.push(getMinuteOfDay(new Date(s.start_time), tz));
  }
  if (bedtimeMinutes.length < 2) return Infinity;
  const mean = bedtimeMinutes.reduce((a, b) => a + b, 0) / bedtimeMinutes.length;
  const variance = bedtimeMinutes.reduce((sum, v) => sum + (v - mean) ** 2, 0) / bedtimeMinutes.length;
  return Math.sqrt(variance);
}

const minuteFmts = new Map<string, Intl.DateTimeFormat>();
function getMinuteOfDay(date: Date, tz: string): number {
  let fmt = minuteFmts.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
    });
    minuteFmts.set(tz, fmt);
  }
  const parts = fmt.formatToParts(date);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h * 60 + m;
}
