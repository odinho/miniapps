import {
  calculateAgeMonths,
  predictNextNap,
  recommendBedtime,
  predictDayNaps,
  resolveNapCount,
  predictNapEndTime,
  predictNightEndTime,
} from "./schedule.js";
import { getTodayStats } from "./stats.js";
import { computeConfidence } from "./confidence.js";
import { calibrate } from "./calibration.js";
import { computeStrategySignals } from "./features.js";
import { selectStrategy } from "./strategy.js";
import { predictNewborn } from "./newborn.js";
import { predictEmerging } from "./emerging.js";
import type { Baby, SleepLogRow, SleepPauseRow, DayStartRow, SleepEntry, BabyContext } from "$lib/types.js";
import type { PredictedNap } from "./schedule.js";
import type { Strategy, StrategyContext, StrategyOverride } from "./strategy.js";
import type { Prediction } from "$lib/stores/app.svelte.js";

export interface DayData {
  baby: Baby;
  activeSleep: SleepLogRow | undefined;
  todaySleeps: SleepLogRow[];
  recentSleeps: SleepLogRow[];
  todayWakeUp: DayStartRow | undefined;
  pausesBySleep: Map<number, SleepPauseRow[]>;
  diaperCount: number;
  lastDiaperTime: string | null;
  /** Optional override for "now", used by tests. Defaults to Date.now(). */
  now?: number;
}

function toSleepEntry(s: SleepLogRow): SleepEntry {
  return { start_time: s.start_time, end_time: s.end_time, type: s.type as SleepEntry["type"] };
}

/** Build a BabyContext from a Baby record and recent sleep data. */
function buildContext(baby: Baby, recentSleeps: SleepEntry[]): BabyContext {
  return {
    birthdate: baby.birthdate,
    ageMonths: calculateAgeMonths(baby.birthdate),
    tz: baby.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    customNapCount: baby.custom_nap_count ?? null,
    recentSleeps,
  };
}

/** Pure state assembly — takes fetched data, returns the API response shape. */
export function assembleState(data: DayData) {
  const { baby, activeSleep, todaySleeps, recentSleeps, todayWakeUp, pausesBySleep } = data;

  const recentEntries = recentSleeps.map(toSleepEntry);
  const ctx = buildContext(baby, recentEntries);

  const todaySleepsWithPauses = todaySleeps.map((s) => ({
    ...toSleepEntry(s),
    pauses: pausesBySleep.get(s.id) || [],
  }));
  const stats = getTodayStats(todaySleepsWithPauses);

  // Calculate predictions even during active sleep so ghost arcs stay visible
  const now = data.now ?? Date.now();

  // Determine strategy
  const strategy = determineStrategy(recentEntries, baby.birthdate, ctx.tz, now);
  ctx.strategy = strategy;

  let prediction: Prediction | null = null;
  if (strategy === "newborn_guidance") {
    prediction = assembleNewbornPrediction(ctx, recentEntries, todaySleeps, now);
  } else if (strategy === "emerging_rhythm") {
    prediction = assembleEmergingPrediction(ctx, recentEntries, todaySleeps, activeSleep, todayWakeUp, now);
  } else {
    prediction = assembleSchedulePrediction(
      strategy, ctx, todaySleeps, activeSleep, todayWakeUp, now,
    );
  }

  return {
    baby,
    activeSleep,
    todaySleeps,
    stats,
    prediction,
    ageMonths: ctx.ageMonths,
    diaperCount: data.diaperCount,
    lastDiaperTime: data.lastDiaperTime,
    todayWakeUp,
  };
}

/**
 * Determine which strategy to use, with hysteresis derived from recent data.
 *
 * Replays the raw selector over the last 7 days (1 day steps) to build a
 * history, then applies hysteresis rules. This is pure — no persistence needed.
 */
function determineStrategy(
  recentSleeps: SleepEntry[],
  birthdate: string,
  tz: string,
  now: number,
  override?: StrategyOverride,
): Strategy {
  const todaySignals = computeStrategySignals(recentSleeps, birthdate, tz, now);

  // Replay raw selector over recent days to derive hysteresis context
  const DAY_MS = 24 * 60 * 60 * 1000;
  const rawHistory: Strategy[] = [];
  for (let daysAgo = 6; daysAgo >= 1; daysAgo--) {
    const dayMs = now - daysAgo * DAY_MS;
    // Only use sleeps that ended before this day's reference point
    const windowSleeps = recentSleeps.filter((s) =>
      s.end_time && new Date(s.end_time).getTime() < dayMs,
    );
    const daySignals = computeStrategySignals(windowSleeps, birthdate, tz, dayMs);
    rawHistory.push(selectStrategy(daySignals));
  }

  // The "previous" strategy is the most recent historical day's raw selection
  const previous = rawHistory.length > 0 ? rawHistory[rawHistory.length - 1] : null;

  // Today's raw selection
  const todayRaw = selectStrategy(todaySignals);

  // Count consecutive days the raw selector has suggested today's raw strategy
  // (counting backward from yesterday)
  let consecutiveDays = 0;
  for (let i = rawHistory.length - 1; i >= 0; i--) {
    if (rawHistory[i] === todayRaw) consecutiveDays++;
    else break;
  }

  // Apply hysteresis
  const ctx: StrategyContext = {
    previous,
    consecutiveDaysAtCandidate: consecutiveDays,
    override: override ?? null,
  };
  return selectStrategy(todaySignals, ctx);
}

/** Assemble a newborn-style prediction. */
function assembleNewbornPrediction(
  ctx: BabyContext,
  recentEntries: SleepEntry[],
  todaySleeps: SleepLogRow[],
  now: number,
): Prediction {
  // Find last completed sleep end time
  const completedSleeps = todaySleeps
    .filter((s) => s.end_time)
    .map((s) => ({ endMs: new Date(s.end_time!).getTime() }))
    .toSorted((a, b) => b.endMs - a.endMs);

  // Also check recent sleeps for last sleep end
  const recentCompleted = recentEntries
    .filter((s) => s.end_time)
    .map((s) => ({ endMs: new Date(s.end_time!).getTime() }))
    .toSorted((a, b) => b.endMs - a.endMs);

  const lastSleepEndMs = completedSleeps[0]?.endMs ?? recentCompleted[0]?.endMs ?? null;

  const result = predictNewborn({
    ageMonths: ctx.ageMonths,
    tz: ctx.tz,
    recentSleeps: ctx.recentSleeps,
    lastSleepEndMs,
    now,
  });

  return {
    strategy: "newborn_guidance",
    // Schedule fields — null for newborn
    nextNap: null,
    bedtime: null,
    predictedNaps: null,
    napsAllDone: false,
    expectedNapEnd: null,
    expectedNightEnd: null,
    confidence: null,
    calibration: null,
    // Newborn fields
    sleepWindow: result.sleepWindow,
    sleepPressure: result.sleepPressure,
    totalSleep24h: result.rolling.totalSleep24h,
    longestStretch: result.rolling.longestStretch,
    longestStretchTrend: result.longestStretchTrend.direction,
    ageNorms: result.ageNorms,
    rolling: result.rolling,
  };
}

/** Assemble an emerging-rhythm prediction (adapter between newborn and schedule). */
function assembleEmergingPrediction(
  ctx: BabyContext,
  recentEntries: SleepEntry[],
  todaySleeps: SleepLogRow[],
  activeSleep: SleepLogRow | undefined,
  todayWakeUp: DayStartRow | undefined,
  now: number,
): Prediction {
  // Find last completed sleep end time
  const allCompleted = [...todaySleeps, ...recentEntries.map((s) => ({ end_time: s.end_time }))]
    .filter((s) => s.end_time)
    .map((s) => new Date(s.end_time!).getTime());
  const lastSleepEndMs = allCompleted.length > 0 ? Math.max(...allCompleted) : null;

  const lastCompleted = todaySleeps.find((s) => s.end_time);
  const wakeTimeForPrediction = lastCompleted?.end_time || todayWakeUp?.wake_time;

  const result = predictEmerging({
    ctx,
    todaySleeps: todaySleeps.map(toSleepEntry),
    wakeUpTime: wakeTimeForPrediction ?? null,
    lastSleepEndMs,
    now,
  });

  // Compute expected nap/night end for active sleep (reuse schedule functions)
  let expectedNapEnd: string | null = null;
  if (activeSleep && activeSleep.type === "nap" && !activeSleep.end_time) {
    expectedNapEnd = predictNapEndTime(activeSleep.start_time, ctx);
  }
  let expectedNightEnd: string | null = null;
  if (activeSleep && activeSleep.type === "night" && !activeSleep.end_time) {
    const todayNapMin = todaySleeps
      .filter((s) => s.type === "nap" && s.end_time)
      .reduce((sum, s) => sum + (new Date(s.end_time!).getTime() - new Date(s.start_time).getTime()) / 60000, 0);
    expectedNightEnd = predictNightEndTime(activeSleep.start_time, ctx, todayNapMin);
  }

  return {
    strategy: "emerging_rhythm",
    nextNap: result.nextNap,
    bedtime: result.bedtime,
    predictedNaps: result.predictedNaps,
    napsAllDone: false,
    expectedNapEnd,
    expectedNightEnd,
    confidence: null,
    calibration: null,
    sleepWindow: result.sleepWindow,
    sleepPressure: result.sleepPressure,
    totalSleep24h: result.rolling.totalSleep24h,
    longestStretch: result.rolling.longestStretch,
    longestStretchTrend: result.longestStretchTrend.direction,
    ageNorms: result.ageNorms,
    rolling: result.rolling,
  };
}

/** Assemble a schedule-based prediction (routine_schedule). */
function assembleSchedulePrediction(
  strategy: Strategy,
  ctx: BabyContext,
  todaySleeps: SleepLogRow[],
  activeSleep: SleepLogRow | undefined,
  todayWakeUp: DayStartRow | undefined,
  now: number,
): Prediction | null {
  const lastCompleted = todaySleeps.find((s) => s.end_time);
  const wakeTimeForPrediction = lastCompleted?.end_time || todayWakeUp?.wake_time;

  if (!wakeTimeForPrediction) return null;

  const bedtime = recommendBedtime(todaySleeps.map(toSleepEntry), ctx);
  const bedtimeMs = new Date(bedtime).getTime();
  const completedNaps = todaySleeps.filter((s) => s.type === "nap" && s.end_time);
  // During active nap, count it toward consumed slots
  const consumedNaps = completedNaps.length + (activeSleep?.type === "nap" ? 1 : 0);
  const expectedNapCount = resolveNapCount(ctx);

  // Build predicted naps from day schedule (accounts for custom nap count)
  // Compute once — reused for predictions and confidence intervals below
  const allPredictedFromWakeUp = todayWakeUp
    ? predictDayNaps(todayWakeUp.wake_time, ctx)
    : [];
  let predictedNaps: PredictedNap[] | null = null;
  if (todayWakeUp) {
    const allPredicted = allPredictedFromWakeUp;
    let remaining = allPredicted.slice(consumedNaps);

    // If remaining predictions are stale (actual last wake is past the predicted
    // nap start), the schedule drifted — recalculate from the actual wake time
    if (remaining.length > 0) {
      const actualWakeMs = new Date(wakeTimeForPrediction).getTime();
      const predictedStartMs = new Date(remaining[0].startTime).getTime();
      if (actualWakeMs > predictedStartMs) {
        remaining = predictDayNaps(
          wakeTimeForPrediction,
          { ...ctx, customNapCount: remaining.length },
        );
      }
    }

    // B8: Filter out predicted naps starting within 60 min of bedtime
    predictedNaps = remaining.filter(
      (n) => new Date(n.startTime).getTime() < bedtimeMs - 60 * 60000,
    );
  }

  // B2: Derive nextNap from the day schedule when available (respects custom nap count)
  let nextNap: string;
  if (predictedNaps && predictedNaps.length > 0) {
    nextNap = predictedNaps[0].startTime;
  } else {
    nextNap = predictNextNap(wakeTimeForPrediction, ctx);
  }

  // Detect skipped naps: if the predicted next nap is >90 min overdue (same day), it was skipped
  const nextNapMs = new Date(nextNap).getTime();
  const overdueMs = now - nextNapMs;
  const napSkipped = !activeSleep && overdueMs > 90 * 60000 && overdueMs < 18 * 60 * 60000;
  const napsAllDone = consumedNaps >= expectedNapCount || napSkipped;

  // B8: Don't suggest a nap that starts within 60 min of bedtime
  if (nextNapMs > bedtimeMs - 60 * 60000 || napsAllDone) {
    // All naps done or too close to bedtime — show bedtime instead of next nap
    nextNap = bedtime;
  }

  // Clear predicted nap bubbles if all naps are done (by count or skipped)
  if (napsAllDone) {
    predictedNaps = null;
  }

  // During active night sleep, don't show stale daytime nap predictions
  if (activeSleep && activeSleep.type === "night") {
    predictedNaps = null;
  }

  // Compute confidence intervals and calibration
  const allPredictedForConf = allPredictedFromWakeUp;
  const confidence = allPredictedForConf.length > 0
    ? computeConfidence(allPredictedForConf, bedtime, ctx.ageMonths, ctx.recentSleeps, ctx.tz)
    : null;
  const calibration = calibrate(ctx.ageMonths, ctx.recentSleeps, ctx.customNapCount, ctx.tz);

  // Compute expected nap end for active naps
  let expectedNapEnd: string | null = null;
  if (activeSleep && activeSleep.type === "nap" && !activeSleep.end_time) {
    expectedNapEnd = predictNapEndTime(activeSleep.start_time, ctx);
  }

  // Compute expected night end for active night sleep
  let expectedNightEnd: string | null = null;
  if (activeSleep && activeSleep.type === "night" && !activeSleep.end_time) {
    const todayNapMin = todaySleeps
      .filter((s) => s.type === "nap" && s.end_time)
      .reduce((sum, s) => sum + (new Date(s.end_time!).getTime() - new Date(s.start_time).getTime()) / 60000, 0);
    expectedNightEnd = predictNightEndTime(activeSleep.start_time, ctx, todayNapMin);
  }

  return {
    strategy,
    nextNap,
    bedtime,
    predictedNaps,
    napsAllDone: napsAllDone || activeSleep?.type === "night",
    expectedNapEnd,
    expectedNightEnd,
    confidence,
    calibration,
    // Newborn fields — null for schedule-based strategies
    sleepWindow: null,
    sleepPressure: null,
    totalSleep24h: null,
    longestStretch: null,
    longestStretchTrend: null,
    ageNorms: null,
    rolling: null,
  };
}
