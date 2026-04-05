import {
  calculateAgeMonths,
  predictNextNap,
  recommendBedtime,
  predictDayNaps,
  resolveNapCount,
  predictNapEndTime,
  predictNightEndTime,
} from "./schedule.js";
import { setHourInTz } from "$lib/tz.js";
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

  // ── Compute remaining predicted naps + bedtime ──
  let remaining: PredictedNap[] = [];

  if (todayWakeUp) {
    const allPredicted = predictDayNaps(todayWakeUp.wake_time, ctx);
    remaining = allPredicted.slice(consumedNaps);

    if (remaining.length > 0 && wakeTimeForPrediction) {
      const actualWakeMs = new Date(wakeTimeForPrediction).getTime();
      if (actualWakeMs > new Date(remaining[0].startTime).getTime()) {
        remaining = predictDayNaps(
          wakeTimeForPrediction,
          { ...ctx, customNapCount: remaining.length },
        );
      }
    }
  }

  const sleepsForBedtime = buildSleepsForBedtime(todaySleeps.map(toSleepEntry), activeSleep, remaining, ctx);
  let bedtime: string | null = recommendBedtime(sleepsForBedtime, ctx);
  let bedtimeMs = bedtime ? new Date(bedtime).getTime() : Infinity;

  // Blend toward target bedtime when set
  if (ctx.targetBedtime && bedtime) {
    const targetMs = new Date(targetBedtimeToISO(ctx.targetBedtime, now, ctx.tz)).getTime();
    bedtimeMs = Math.round(bedtimeMs * 0.5 + targetMs * 0.5);
    bedtime = new Date(bedtimeMs).toISOString();
  }

  let predictedNaps: PredictedNap[] | null = remaining.filter(
    (n) => new Date(n.startTime).getTime() < bedtimeMs - 60 * 60000,
  );

  if (predictedNaps.length < remaining.length && bedtime) {
    const pass2Sleeps = buildSleepsForBedtime(todaySleeps.map(toSleepEntry), activeSleep, predictedNaps, ctx);
    bedtime = recommendBedtime(pass2Sleeps, ctx);
    bedtimeMs = new Date(bedtime).getTime();
    if (ctx.targetBedtime) {
      const targetMs = new Date(targetBedtimeToISO(ctx.targetBedtime, now, ctx.tz)).getTime();
      bedtimeMs = Math.round(bedtimeMs * 0.5 + targetMs * 0.5);
      bedtime = new Date(bedtimeMs).toISOString();
    }
    predictedNaps = predictedNaps.filter(
      (n) => new Date(n.startTime).getTime() < bedtimeMs - 60 * 60000,
    );
  }

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
    nextNap,
    bedtime,
    predictedNaps,
    expectedNapCount,
    napsAllDone: napsAllDone || activeSleep?.type === "night",
    expectedNapEnd,
    expectedNightEnd,
    confidence: null,
    calibration: null,
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
  };
}

/** Convert a "HH:MM" target bedtime to an ISO timestamp for today in the baby's timezone. */
function targetBedtimeToISO(hhmm: string, now: number, tz: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return setHourInTz(new Date(now), h, m, tz).toISOString();
}

/**
 * Build the sleep list for recommendBedtime: actual completed sleeps + synthetic
 * entries for active nap (predicted end) and remaining predicted naps.
 * This gives recommendBedtime the full coherent day picture so it can compute
 * bedtime from the predicted last-nap end instead of defaulting to 19:00.
 */
function buildSleepsForBedtime(
  todaySleeps: SleepEntry[],
  activeSleep: SleepLogRow | undefined,
  remainingPredicted: PredictedNap[],
  ctx: BabyContext,
): SleepEntry[] {
  const sleeps = [...todaySleeps];

  // Active nap: include synthetic entry with predicted end time
  if (activeSleep && activeSleep.type === "nap" && !activeSleep.end_time) {
    sleeps.push({
      start_time: activeSleep.start_time,
      end_time: predictNapEndTime(activeSleep.start_time, ctx),
      type: "nap",
    });
  }

  // Remaining predicted naps: include as synthetic entries
  for (const pn of remainingPredicted) {
    sleeps.push({ start_time: pn.startTime, end_time: pn.endTime, type: "nap" });
  }

  return sleeps;
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

  // ── Step 1: Predict naps forward (coherent day plan) ──
  const allPredictedFromWakeUp = todayWakeUp
    ? predictDayNaps(todayWakeUp.wake_time, ctx)
    : [];
  let remaining: PredictedNap[] = [];
  if (todayWakeUp) {
    remaining = allPredictedFromWakeUp.slice(consumedNaps);

    if (remaining.length > 0) {
      const actualWakeMs = new Date(wakeTimeForPrediction).getTime();
      if (actualWakeMs > new Date(remaining[0].startTime).getTime()) {
        remaining = predictDayNaps(
          wakeTimeForPrediction,
          { ...ctx, customNapCount: remaining.length },
        );
      }
    }
  }

  // ── Step 2: Compute bedtime from the coherent day plan ──
  const sleepsForBedtime = buildSleepsForBedtime(todaySleeps.map(toSleepEntry), activeSleep, remaining, ctx);
  let bedtime = recommendBedtime(sleepsForBedtime, ctx);
  let bedtimeMs = new Date(bedtime).getTime();

  // ── Step 2b: Blend toward target bedtime when set ──
  // The target is a goal, not a hard override. Blend the learned/pressure-based
  // bedtime with the target so the schedule gradually moves toward it.
  // Naps stay cycle-aware (from predictDayNaps); the B8 filter naturally adjusts
  // them to fit before the blended bedtime.
  if (ctx.targetBedtime) {
    const targetMs = new Date(targetBedtimeToISO(ctx.targetBedtime, now, ctx.tz)).getTime();
    bedtimeMs = Math.round(bedtimeMs * 0.5 + targetMs * 0.5);
    bedtime = new Date(bedtimeMs).toISOString();
  }

  // ── Step 3: B8 filter — remove predicted naps starting within 60 min of bedtime ──
  let predictedNaps: PredictedNap[] | null = remaining.filter(
    (n) => new Date(n.startTime).getTime() < bedtimeMs - 60 * 60000,
  );

  // Pass 2: If B8 removed naps, bedtime anchor changed — recompute
  if (predictedNaps.length < remaining.length) {
    const pass2Sleeps = buildSleepsForBedtime(todaySleeps.map(toSleepEntry), activeSleep, predictedNaps, ctx);
    bedtime = recommendBedtime(pass2Sleeps, ctx);
    bedtimeMs = new Date(bedtime).getTime();
    if (ctx.targetBedtime) {
      const targetMs = new Date(targetBedtimeToISO(ctx.targetBedtime, now, ctx.tz)).getTime();
      bedtimeMs = Math.round(bedtimeMs * 0.5 + targetMs * 0.5);
      bedtime = new Date(bedtimeMs).toISOString();
    }
    predictedNaps = predictedNaps.filter(
      (n) => new Date(n.startTime).getTime() < bedtimeMs - 60 * 60000,
    );
  }

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
    expectedNapCount,
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
    longestStretchDetail: null,
    ageNorms: null,
    rolling: null,
  };
}
