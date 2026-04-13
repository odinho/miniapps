import {
  calculateAgeMonths,
  predictNextNap,
  resolveNapCount,
  predictNapEndTime,
  predictNightEndTime,
  detectRescueNap,
  computeShortNapThreshold,
  computeRescueNapCap,
  selectBestPlan,
  getWakeWindow,
  getLearnedNapDuration,
  getLearnedNightDuration,
  getLearnedBedtimeWakeWindow,
  estimateSleepCycleFromData,
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
  /** Recent sleeps (7-day lookback) for the schedule engine. */
  recentSleeps: SleepLogRow[];
  /** Extended sleeps (21-day lookback) for strategy hysteresis. Falls back to recentSleeps. */
  strategySleeps?: SleepLogRow[];
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
    targetBedtime: baby.target_bedtime ?? null,
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

  // Determine strategy (use extended lookback for hysteresis when available)
  const strategyEntries = (data.strategySleeps ?? recentSleeps).map(toSleepEntry);
  const strategy = determineStrategy(strategyEntries, baby.birthdate, ctx.tz, now);
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
 * Simulates the full hysteresis chain day-by-day over the last 7 days.
 * Each day's *applied* strategy (after hysteresis) feeds into the next day
 * as the "previous" strategy. This ensures transition thresholds (3 forward,
 * 5 regression) are properly enforced.
 *
 * Pure — no persistence needed.
 */
function determineStrategy(
  recentSleeps: SleepEntry[],
  birthdate: string,
  tz: string,
  now: number,
  override?: StrategyOverride,
): Strategy {
  const DAY_MS = 24 * 60 * 60 * 1000;

  // Simulate the hysteresis chain: for each historical day, compute what
  // strategy the app would have applied given the chain so far.
  let appliedStrategy: Strategy | null = null;
  let consecutiveAtCandidate = 0;
  let lastRawCandidate: Strategy | null = null;

  // Days 6..1 ago + today (index 0 = 6 days ago, index 6 = today)
  for (let daysAgo = 6; daysAgo >= 0; daysAgo--) {
    const dayMs = daysAgo === 0 ? now : now - daysAgo * DAY_MS;
    const windowSleeps = recentSleeps.filter((s) =>
      s.end_time && new Date(s.end_time).getTime() < dayMs,
    );
    const daySignals = computeStrategySignals(windowSleeps, birthdate, tz, dayMs);
    const rawSelection = selectStrategy(daySignals);

    // Track consecutive days of the same raw candidate
    if (rawSelection === lastRawCandidate) {
      consecutiveAtCandidate++;
    } else {
      consecutiveAtCandidate = 1;
      lastRawCandidate = rawSelection;
    }

    // Apply hysteresis using the chain's applied strategy as previous
    const ctx: StrategyContext = {
      previous: appliedStrategy,
      consecutiveDaysAtCandidate: consecutiveAtCandidate,
      override: daysAgo === 0 ? (override ?? null) : null, // only apply override on today
    };
    appliedStrategy = selectStrategy(daySignals, ctx);
  }

  return appliedStrategy!;
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
    expectedNapCount: 0,
    napsAllDone: false,
    expectedNapEnd: null,
    expectedNightEnd: null,
    confidence: null,
    calibration: null,
    rescueNap: null,
    // Newborn fields
    sleepWindow: result.sleepWindow,
    sleepPressure: result.sleepPressure,
    totalSleep24h: result.rolling.totalSleep24h,
    longestStretch: result.rolling.longestStretch,
    longestStretchTrend: result.longestStretchTrend.direction,
    longestStretchDetail: {
      currentWeekAvg: result.longestStretchTrend.currentWeekAvg,
      priorWeekAvg: result.longestStretchTrend.priorWeekAvg,
    },
    ageNorms: result.ageNorms,
    rolling: result.rolling,
    learnedSchedule: null,
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

  const completedNaps = todaySleeps.filter((s) => s.type === "nap" && s.end_time);
  const consumedNaps = completedNaps.length + (activeSleep?.type === "nap" ? 1 : 0);
  const expectedNapCount = resolveNapCount(ctx);

  // ── Select best plan (natural vs target-guided, scored) ──
  const selected = todayWakeUp
    ? selectBestPlan(todayWakeUp.wake_time, todaySleeps.map(toSleepEntry), activeSleep, ctx, now)
    : null;

  let remaining = selected ? selected.naps.slice(consumedNaps) : [] as PredictedNap[];

  let bedtime: string | null = selected?.bedtime ?? null;
  if (remaining.length > 0 && wakeTimeForPrediction) {
    const actualWakeMs = new Date(wakeTimeForPrediction).getTime();
    if (actualWakeMs > new Date(remaining[0].startTime).getTime()) {
      const adjusted = selectBestPlan(
        wakeTimeForPrediction, todaySleeps.map(toSleepEntry), activeSleep,
        { ...ctx, customNapCount: remaining.length }, now,
      );
      remaining = adjusted.naps;
      bedtime = adjusted.bedtime;
    }
  }

  let bedtimeMs = bedtime ? new Date(bedtime).getTime() : Infinity;

  // Safety B8 filter
  let predictedNaps: PredictedNap[] | null = remaining.filter(
    (n) => new Date(n.startTime).getTime() < bedtimeMs - 60 * 60000,
  );
  if (predictedNaps.length === 0) predictedNaps = null;

  // Derive nextNap from remaining predictions
  let nextNap = result.nextNap;
  if (predictedNaps && predictedNaps.length > 0) {
    nextNap = predictedNaps[0].startTime;
  }

  // Detect skipped naps and determine if all naps are done
  const nextNapMs = nextNap ? new Date(nextNap).getTime() : 0;
  const overdueMs = nextNapMs ? now - nextNapMs : 0;
  const napSkipped = !activeSleep && overdueMs > 90 * 60000 && overdueMs < 18 * 60 * 60000;
  const napsAllDone = consumedNaps >= expectedNapCount || napSkipped;

  if (nextNapMs > bedtimeMs - 60 * 60000 || napsAllDone) {
    nextNap = bedtime;
  }

  if (napsAllDone) {
    predictedNaps = null;
  }

  if (activeSleep && activeSleep.type === "night") {
    predictedNaps = null;
  }

  // Compute expected nap/night end for active sleep (reuse schedule functions)
  let expectedNapEnd: string | null = null;
  let rescueNap: Prediction["rescueNap"] = null;
  if (activeSleep && activeSleep.type === "nap" && !activeSleep.end_time) {
    expectedNapEnd = predictNapEndTime(activeSleep.start_time, ctx);
    const cycleMin = estimateSleepCycleFromData(ctx);
    const shortThreshold = computeShortNapThreshold(getLearnedNapDuration(ctx), cycleMin);
    const rescueCap = computeRescueNapCap(cycleMin);
    rescueNap = detectRescueNap(
      activeSleep.start_time,
      completedNaps.filter((s) => s.end_time).map((s) => ({ start_time: s.start_time, end_time: s.end_time! })),
      expectedNapCount,
      bedtime,
      shortThreshold,
      rescueCap,
    );
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
    nextNap,
    bedtime,
    predictedNaps,
    expectedNapCount,
    napsAllDone: napsAllDone || activeSleep?.type === "night",
    expectedNapEnd,
    expectedNightEnd,
    confidence: null,
    calibration: null,
    rescueNap,
    sleepWindow: result.sleepWindow,
    sleepPressure: result.sleepPressure,
    totalSleep24h: result.rolling.totalSleep24h,
    longestStretch: result.rolling.longestStretch,
    longestStretchTrend: result.longestStretchTrend.direction,
    longestStretchDetail: {
      currentWeekAvg: result.longestStretchTrend.currentWeekAvg,
      priorWeekAvg: result.longestStretchTrend.priorWeekAvg,
    },
    ageNorms: result.ageNorms,
    rolling: result.rolling,
    learnedSchedule: null,
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

  const completedNaps = todaySleeps.filter((s) => s.type === "nap" && s.end_time);
  // During active nap, count it toward consumed slots
  const consumedNaps = completedNaps.length + (activeSleep?.type === "nap" ? 1 : 0);
  const expectedNapCount = resolveNapCount(ctx);

  // ── Select best plan (natural vs target-guided, scored) ──
  const selected = todayWakeUp
    ? selectBestPlan(todayWakeUp.wake_time, todaySleeps.map(toSleepEntry), activeSleep, ctx, now)
    : null;
  const allPredictedFromWakeUp = selected?.naps ?? [];

  let remaining = allPredictedFromWakeUp.slice(consumedNaps);

  // Stale check: if actual wake time is past the first predicted nap start,
  // re-select with adjusted context (updates both naps AND bedtime)
  let bedtime = selected?.bedtime ?? new Date(now).toISOString();
  if (remaining.length > 0) {
    const actualWakeMs = new Date(wakeTimeForPrediction).getTime();
    if (actualWakeMs > new Date(remaining[0].startTime).getTime()) {
      const adjusted = selectBestPlan(
        wakeTimeForPrediction, todaySleeps.map(toSleepEntry), activeSleep,
        { ...ctx, customNapCount: remaining.length }, now,
      );
      remaining = adjusted.naps;
      bedtime = adjusted.bedtime;
    }
  }

  let bedtimeMs = new Date(bedtime).getTime();

  // Safety B8 filter
  let predictedNaps: PredictedNap[] | null = remaining.filter(
    (n) => new Date(n.startTime).getTime() < bedtimeMs - 60 * 60000,
  );
  if (predictedNaps.length === 0) predictedNaps = null;

  // ── Step 4: Derive nextNap, napsAllDone, and final cleanup ──
  let nextNap: string;
  if (predictedNaps && predictedNaps.length > 0) {
    nextNap = predictedNaps[0].startTime;
  } else {
    nextNap = predictNextNap(wakeTimeForPrediction, ctx);
  }

  const nextNapMs = new Date(nextNap).getTime();
  const overdueMs = now - nextNapMs;
  const napSkipped = !activeSleep && overdueMs > 90 * 60000 && overdueMs < 18 * 60 * 60000;
  const napsAllDone = consumedNaps >= expectedNapCount || napSkipped;

  if (nextNapMs > bedtimeMs - 60 * 60000 || napsAllDone) {
    nextNap = bedtime;
  }

  if (napsAllDone) {
    predictedNaps = null;
  }

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
  let rescueNap: Prediction["rescueNap"] = null;
  if (activeSleep && activeSleep.type === "nap" && !activeSleep.end_time) {
    expectedNapEnd = predictNapEndTime(activeSleep.start_time, ctx);
    const cycleMin = estimateSleepCycleFromData(ctx);
    const shortThreshold = computeShortNapThreshold(getLearnedNapDuration(ctx), cycleMin);
    const rescueCap = computeRescueNapCap(cycleMin);
    rescueNap = detectRescueNap(
      activeSleep.start_time,
      completedNaps.filter((s) => s.end_time).map((s) => ({ start_time: s.start_time, end_time: s.end_time! })),
      expectedNapCount,
      bedtime,
      shortThreshold,
      rescueCap,
    );
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
    expectedNapCount,
    napsAllDone: napsAllDone || activeSleep?.type === "night",
    expectedNapEnd,
    expectedNightEnd,
    confidence,
    calibration,
    rescueNap,
    // Newborn fields — null for schedule-based strategies
    sleepWindow: null,
    sleepPressure: null,
    totalSleep24h: null,
    longestStretch: null,
    longestStretchTrend: null,
    longestStretchDetail: null,
    ageNorms: null,
    rolling: null,
    // Learned schedule parameters for insight display
    learnedSchedule: {
      napDurationMin: getLearnedNapDuration(ctx),
      nightDurationMin: getLearnedNightDuration(ctx),
      wakeWindowMin: getWakeWindow(ctx),
      bedtimeWakeWindowMin: getLearnedBedtimeWakeWindow(ctx),
      expectedNapCount,
      sleepCycleMin: estimateSleepCycleFromData(ctx),
    },
  };
}
