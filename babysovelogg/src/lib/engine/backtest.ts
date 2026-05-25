import type { SleepEntry, BabyContext, PredictionFeatures, SleepCycleEstimate } from "$lib/types.js";
import type { PredictedNap } from "./schedule.js";
import {
  predictDayNaps,
  predictNightEndTime,
  recommendBedtime,
  calculateAgeMonths,
  estimateSleepCycleDetails,
  getLearnedNapDuration,
  computeShortNapThreshold,
} from "./schedule.js";
import { computeStrategySignals, computeSleepWindow, extractWakeWindows } from "./features.js";
import { selectStrategy, type Strategy } from "./strategy.js";
import { computeTrendTotalMin } from "./trend.js";

/** A single day's recorded sleep data. */
export interface DayRecord {
  date: string; // YYYY-MM-DD
  wakeTime: string; // ISO — when baby woke up for the day
  sleeps: SleepEntry[]; // actual sleeps this day (naps + night)
  target_bedtime?: string | null; // HH:MM local — family's bedtime target on this day (if tracked)
  /** Parent flagged this day as off (sick / travel / spurt / DST). The engine
   *  excludes off-days from trend computation; the backtest mirrors that. */
  off_day?: 0 | 1;
  off_day_reason?: string | null;
}

/** Per-day comparison result. */
export interface DayResult {
  date: string;
  dayIndex: number; // 0-based index in the input array (how many prior days of data)
  /** Which strategy the selector would have chosen for this day */
  strategy: Strategy;
  predictedNaps: PredictedNap[];
  actualNaps: SleepEntry[];
  predictedBedtime: string;
  actualBedtime: string | null;
  napCountError: number; // predicted - actual (positive = over-predicted)
  napStartErrors: number[]; // minutes, per matched nap (positive = predicted later than actual)
  napEndErrors: number[]; // minutes, per matched nap (positive = predicted later than actual)
  napDurationErrors: number[]; // minutes, matched naps only (positive = predicted longer than actual)
  bedtimeError: number | null; // minutes (positive = predicted later than actual)
  wakeTimeError: number | null; // minutes, predicted morning wake vs actual (positive = predicted later)
  /** Newborn: was the actual sleep start within the predicted window? (null for schedule days) */
  sleepWindowHit: boolean | null;
  /** Sleep-cycle estimate the engine would have read this day — surfaces
   *  source/confidence/minutes so per-period summaries can roll up cycle
   *  confidence distribution. Null on newborn days (cycle is age-default
   *  and the schedule engine doesn't run). */
  sleepCycle: SleepCycleEstimate | null;
  /** Day contained at least one parent-woken nap shorter than the
   *  cycle-aware short threshold (`computeShortNapThreshold(learnedNap,
   *  cycle.minutes)`). Surfaces the cut-short *signal* that drives the
   *  rescue path in production — but this is a context metric only, NOT
   *  a faithful rescue replay: the production rescue trigger
   *  (`mostRecentCutShort` + `derivePostPlanFields`) flags any short
   *  completed nap regardless of `woke_by`, and applies continuation /
   *  bedtime-feasibility / active-nap gates the backtest doesn't
   *  evaluate. Keeping the proxy narrow to woken naps because
   *  Halldis's data labels them — the heuristic intentionally won't
   *  fire on unlabeled or self-woken cut-shorts. */
  rescueLikely: boolean;
}

/** Aggregate metrics across all backtested days. */
export interface BacktestResult {
  days: DayResult[];
  totalDays: number;
  napCountAccuracy: number; // fraction of days where predicted count == actual count
  napStartMAE: number; // mean absolute error in minutes across all matched naps
  bedtimeMAE: number; // mean absolute error in minutes
  napCountBias: number; // mean signed error (positive = over-predicting nap count)
  napStartBias: number; // mean signed error (positive = predicting too late)
  napDurationMAE: number; // mean absolute error on nap duration (matched naps only)
  napEndMAE: number; // mean absolute error on nap end time
  wakeTimeMAE: number; // mean absolute error on predicted morning wake
  /** Strategy distribution: count of days per strategy */
  strategyCounts: Record<Strategy, number>;
  /** Fraction of newborn/emerging days where actual sleep started within predicted window */
  sleepWindowHitRate: number | null;
  /** Average predicted naps per day (decimal). */
  avgPredictedNapsPerDay: number;
  /** Average actual naps per day (decimal). */
  avgActualNapsPerDay: number;
  /** Days where the rescueLikely heuristic fired. */
  rescueLikelyDays: number;
  /** Cycle confidence distribution across schedule/emerging days. */
  cycleConfidence: { low: number; medium: number; high: number };
  /** Fraction of schedule/emerging days where the cycle estimator
   *  returned `source: "learned"` (vs `age-default`). */
  cycleLearnedShare: number;
}

/** Predictor function signature — takes wake time and baby context. */
export type NapPredictor = (wakeUpTime: string, ctx: BabyContext) => PredictedNap[];

/** Bedtime predictor function signature — takes today's sleeps and baby context. */
export type BedtimePredictor = (todaySleeps: SleepEntry[], ctx: BabyContext) => string;

/** Wake time predictor function signature — takes bedtime, context, and today's nap total. */
export type WakeTimePredictor = (bedtime: string, ctx: BabyContext, todayNapMinutes: number) => string;

/**
 * Run a backtest: replay historical sleep data day-by-day, predict each day
 * using only prior data, and compare predictions to actuals.
 *
 * @param days - Chronologically ordered day records
 * @param birthdate - Baby's birthdate (ISO string)
 * @param options - Optional overrides for predictor functions and lookback window
 */
export function backtest(
  days: DayRecord[],
  birthdate: string,
  options?: {
    lookbackDays?: number;
    extendedLookbackDays?: number;
    /** Very-long-horizon window for the sleep-cycle estimator. Mirrors
     *  prod's `cycleSleeps` (180d). Defaults to 180, but the harness
     *  capping at `i` means an early-life baby gets all-prior-history
     *  naturally. */
    cycleLookbackDays?: number;
    predict?: NapPredictor;
    predictBedtime?: BedtimePredictor;
    predictWakeTime?: WakeTimePredictor;
    customNapCount?: number | null;
    tz?: string;
    features?: Partial<PredictionFeatures>;
  },
): BacktestResult {
  const lookback = options?.lookbackDays ?? 7;
  // Mirrors prod: server/state.ts feeds a 21-day window through buildContext as
  // `extendedSleeps` so the cut-short censor's self-wake median has enough
  // signal even when the 7-day window is sparse.
  const extendedLookback = options?.extendedLookbackDays ?? 21;
  const cycleLookback = options?.cycleLookbackDays ?? 180;
  const predict = options?.predict ?? predictDayNaps;
  const bedtimePredict = options?.predictBedtime ?? recommendBedtime;
  const wakePredict = options?.predictWakeTime ?? predictNightEndTime;
  const customNapCount = options?.customNapCount ?? null;
  const tz = options?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const features = options?.features;

  const DAY_MS = 86_400_000;
  const dayMsCache = days.map((d) => new Date(d.date + "T12:00:00Z").getTime());

  const results: DayResult[] = [];

  for (let i = 0; i < days.length; i++) {
    const day = days[i];

    // Calendar-day windows mirror prod (`Date.now() - 21 * 86_400_000`) — array
    // indices over-include when the fixture has date gaps. Strictly prior days
    // only, no leakage from the current day.
    const dayMs = dayMsCache[i];
    const recentCutoff = dayMs - lookback * DAY_MS;
    const extendedCutoff = dayMs - extendedLookback * DAY_MS;
    const cycleCutoff = dayMs - cycleLookback * DAY_MS;
    const recentSleeps: SleepEntry[] = [];
    const extendedSleeps: SleepEntry[] = [];
    const cycleSleeps: SleepEntry[] = [];
    for (let j = 0; j < i; j++) {
      const otherMs = dayMsCache[j];
      const completed = days[j].sleeps.filter((s) => s.end_time);
      if (otherMs >= cycleCutoff) cycleSleeps.push(...completed);
      if (otherMs >= extendedCutoff) extendedSleeps.push(...completed);
      if (otherMs >= recentCutoff) recentSleeps.push(...completed);
    }

    // Need at least 1 prior day to have any learning signal
    if (i < 1) continue;

    // Build context for this day. Compute the same blended trend prod
    // sets in `buildContext` so the cut-short censor's cap-respect
    // carve-out evaluates here the same way it will in production —
    // otherwise backtest MAE numbers would silently diverge from real
    // behavior. Backtest uses the 21d extendedSleeps window in lieu of
    // prod's 30d trend window; the trend gate (MIN_TREND_DAYS) still
    // applies and the source label is "lite data" but the math is the same.
    const ctxAgeMonths = calculateAgeMonths(birthdate, new Date(day.date + "T12:00:00Z"));
    // Carry parent off-day flags forward so trend math + cap-respect carve-out
    // skip sick/travel/spurt/DST days, mirroring prod behaviour.
    const offDays = new Set<string>();
    for (let j = 0; j <= i; j++) {
      if (days[j].off_day === 1) offDays.add(days[j].date);
    }
    const trendTotalMin = computeTrendTotalMin(
      extendedSleeps,
      { birthdate, ageMonths: ctxAgeMonths, tz, customNapCount, recentSleeps, offDays },
      dayMs,
    );
    const ctx: BabyContext = {
      birthdate,
      ageMonths: ctxAgeMonths,
      tz,
      customNapCount,
      targetBedtime: day.target_bedtime ?? null,
      recentSleeps,
      extendedSleeps,
      cycleSleeps,
      offDays,
      trendTotalMin,
      features,
    };

    // Determine which strategy applies to this day
    const strategySignals = computeStrategySignals(recentSleeps, birthdate, tz, dayMs);
    const strategy = selectStrategy(strategySignals);

    const actualNaps = day.sleeps.filter((s) => s.type === "nap" && s.end_time);
    const nightSleep = day.sleeps.find((s) => s.type === "night");
    const actualBedtime = nightSleep?.start_time ?? null;

    // Sleep window hit rate for newborn/emerging days
    let sleepWindowHit: boolean | null = null;
    if (strategy !== "routine_schedule" && day.sleeps.length > 0) {
      const priorDaySleeps = i > 0 ? days[i - 1].sleeps.filter((s) => s.end_time) : [];
      if (priorDaySleeps.length > 0) {
        const lastEnd = priorDaySleeps
          .map((s) => new Date(s.end_time!).getTime())
          .toSorted((a, b) => b - a)[0];
        const wws = extractWakeWindows(recentSleeps);
        const window = computeSleepWindow(lastEnd, wws, ctx.ageMonths);
        const firstSleepStart = new Date(day.sleeps[0].start_time).getTime();
        sleepWindowHit = firstSleepStart >= window.earliestMs && firstSleepStart <= window.latestMs;
      }
    }

    // For newborn days: don't run the schedule engine — nap/bedtime predictions
    // are meaningless. Only score with sleep window hit rate.
    if (strategy === "newborn_guidance") {
      results.push({
        date: day.date,
        dayIndex: i,
        strategy,
        predictedNaps: [],
        actualNaps,
        predictedBedtime: "",
        actualBedtime,
        napCountError: 0,
        napStartErrors: [],
        napEndErrors: [],
        napDurationErrors: [],
        bedtimeError: null,
        wakeTimeError: null,
        sleepWindowHit,
        sleepCycle: null,
        rescueLikely: false,
      });
      continue;
    }

    // For emerging/routine: run the schedule predictor
    const predictedNaps = predict(day.wakeTime, ctx);
    const predictedBedtime = bedtimePredict(actualNaps, ctx);

    // Match predicted naps to actual naps by order
    const napStartErrors: number[] = [];
    const napEndErrors: number[] = [];
    const napDurationErrors: number[] = [];
    const matchCount = Math.min(predictedNaps.length, actualNaps.length);
    for (let k = 0; k < matchCount; k++) {
      const predictedStart = new Date(predictedNaps[k].startTime).getTime();
      const actualStart = new Date(actualNaps[k].start_time).getTime();
      napStartErrors.push((predictedStart - actualStart) / 60000);

      const predictedEnd = new Date(predictedNaps[k].endTime).getTime();
      const actualEnd = new Date(actualNaps[k].end_time!).getTime();
      napEndErrors.push((predictedEnd - actualEnd) / 60000);

      const predictedDur = (predictedEnd - predictedStart) / 60000;
      const actualDur = (actualEnd - actualStart) / 60000;
      napDurationErrors.push(predictedDur - actualDur);
    }

    // Penalize unmatched naps: 60 min per extra/missing nap so count errors
    // are reflected in timing MAE rather than silently dropped
    const unmatchedCount = Math.abs(predictedNaps.length - actualNaps.length);
    for (let k = 0; k < unmatchedCount; k++) {
      napStartErrors.push(60);
      napEndErrors.push(60);
    }

    // Bedtime error — only score when we have both naps and a bedtime.
    let bedtimeError: number | null = null;
    if (actualBedtime && actualNaps.length > 0) {
      bedtimeError =
        (new Date(predictedBedtime).getTime() - new Date(actualBedtime).getTime()) / 60000;
    }

    // Wake time prediction
    let wakeTimeError: number | null = null;
    const nextDayIsAdjacent = i + 1 < days.length
      && (new Date(days[i + 1].date + "T00:00:00Z").getTime() - new Date(day.date + "T00:00:00Z").getTime()) / 86400000 === 1;
    if (actualBedtime && nextDayIsAdjacent) {
      const todayNapMin = actualNaps.reduce((sum, n) => {
        const dur = (new Date(n.end_time!).getTime() - new Date(n.start_time).getTime()) / 60000;
        return sum + dur;
      }, 0);
      const predictedWakeMs = new Date(wakePredict(actualBedtime, ctx, todayNapMin)).getTime();
      const actualWakeMs = new Date(days[i + 1].wakeTime).getTime();
      wakeTimeError = (predictedWakeMs - actualWakeMs) / 60000;
    }

    // Surface the cycle estimate the engine read for this day — drives
    // per-period rollups of confidence and powers the rescueLikely
    // heuristic below. Memoized on ctx; cheap.
    const sleepCycle = estimateSleepCycleDetails(ctx);
    // Cut-short-woken-nap heuristic. Same `computeShortNapThreshold`
    // production uses, retrospectively applied to actual naps. Narrower
    // than production's `mostRecentCutShort` (which flags any short nap
    // regardless of `woke_by`) and ignores continuation/bedtime gates,
    // so this is a *signal* not a replay — see `DayResult.rescueLikely`
    // docstring for the caveats.
    const learnedNap = getLearnedNapDuration(ctx);
    const shortThreshold = computeShortNapThreshold(learnedNap, sleepCycle.minutes);
    const rescueLikely = actualNaps.some((n) => {
      if (n.woke_by !== "woken" || !n.end_time) return false;
      const durMin = (new Date(n.end_time).getTime() - new Date(n.start_time).getTime()) / 60000;
      return durMin < shortThreshold;
    });

    results.push({
      date: day.date,
      dayIndex: i,
      strategy,
      predictedNaps,
      actualNaps,
      predictedBedtime,
      actualBedtime,
      napCountError: predictedNaps.length - actualNaps.length,
      napStartErrors,
      napEndErrors,
      napDurationErrors,
      bedtimeError,
      wakeTimeError,
      sleepWindowHit,
      sleepCycle,
      rescueLikely,
    });
  }

  return summarize(results);
}

function summarize(days: DayResult[]): BacktestResult {
  const totalDays = days.length;
  if (totalDays === 0) {
    return {
      days,
      totalDays: 0,
      napCountAccuracy: 0,
      napStartMAE: 0,
      bedtimeMAE: 0,
      napCountBias: 0,
      napStartBias: 0,
      napDurationMAE: 0,
      napEndMAE: 0,
      wakeTimeMAE: 0,
      strategyCounts: { newborn_guidance: 0, emerging_rhythm: 0, routine_schedule: 0 },
      sleepWindowHitRate: null,
      avgPredictedNapsPerDay: 0,
      avgActualNapsPerDay: 0,
      rescueLikelyDays: 0,
      cycleConfidence: { low: 0, medium: 0, high: 0 },
      cycleLearnedShare: 0,
    };
  }

  // Schedule-scored days only (exclude newborn days which have no schedule predictions)
  const scheduleDays = days.filter((d) => d.strategy !== "newborn_guidance");
  const scheduleDayCount = scheduleDays.length;

  // Nap count accuracy (schedule days only)
  const napCountCorrect = scheduleDays.filter((d) => d.napCountError === 0).length;
  const napCountAccuracy = scheduleDayCount > 0 ? napCountCorrect / scheduleDayCount : 0;

  // Nap start errors (across all matched naps, schedule days only)
  const allStartErrors = scheduleDays.flatMap((d) => d.napStartErrors);
  const napStartMAE =
    allStartErrors.length > 0
      ? allStartErrors.reduce((sum, e) => sum + Math.abs(e), 0) / allStartErrors.length
      : 0;
  const napStartBias =
    allStartErrors.length > 0
      ? allStartErrors.reduce((sum, e) => sum + e, 0) / allStartErrors.length
      : 0;

  // Nap end errors (schedule days only)
  const allEndErrors = scheduleDays.flatMap((d) => d.napEndErrors);
  const napEndMAE =
    allEndErrors.length > 0
      ? allEndErrors.reduce((sum, e) => sum + Math.abs(e), 0) / allEndErrors.length
      : 0;

  // Nap duration errors (schedule days only)
  const allDurationErrors = scheduleDays.flatMap((d) => d.napDurationErrors);
  const napDurationMAE =
    allDurationErrors.length > 0
      ? allDurationErrors.reduce((sum, e) => sum + Math.abs(e), 0) / allDurationErrors.length
      : 0;

  // Bedtime errors (schedule days only)
  const bedtimeErrors = scheduleDays.map((d) => d.bedtimeError).filter((e): e is number => e !== null);
  const bedtimeMAE =
    bedtimeErrors.length > 0
      ? bedtimeErrors.reduce((sum, e) => sum + Math.abs(e), 0) / bedtimeErrors.length
      : 0;

  // Wake time errors (schedule days only)
  const wakeTimeErrors = scheduleDays.map((d) => d.wakeTimeError).filter((e): e is number => e !== null);
  const wakeTimeMAE =
    wakeTimeErrors.length > 0
      ? wakeTimeErrors.reduce((sum, e) => sum + Math.abs(e), 0) / wakeTimeErrors.length
      : 0;

  // Nap count bias (schedule days only)
  const napCountBias = scheduleDayCount > 0
    ? scheduleDays.reduce((sum, d) => sum + d.napCountError, 0) / scheduleDayCount
    : 0;

  // Strategy distribution
  const strategyCounts: Record<Strategy, number> = {
    newborn_guidance: 0, emerging_rhythm: 0, routine_schedule: 0,
  };
  for (const d of days) strategyCounts[d.strategy]++;

  // Sleep window hit rate (newborn/emerging days only)
  const windowDays = days.filter((d) => d.sleepWindowHit !== null);
  const sleepWindowHitRate = windowDays.length > 0
    ? Math.round(windowDays.filter((d) => d.sleepWindowHit).length / windowDays.length * 100) / 100
    : null;

  // Per-day-count averages over schedule days (newborn predictions are
  // empty by construction). Rounded to one decimal so a 1.8-vs-2.0 split
  // is visible in snapshots without exposing floating-point noise.
  const avgPredictedNapsPerDay = scheduleDayCount > 0
    ? Math.round(scheduleDays.reduce((sum, d) => sum + d.predictedNaps.length, 0) / scheduleDayCount * 10) / 10
    : 0;
  const avgActualNapsPerDay = scheduleDayCount > 0
    ? Math.round(scheduleDays.reduce((sum, d) => sum + d.actualNaps.length, 0) / scheduleDayCount * 10) / 10
    : 0;

  // Rescue/cycle rollups — schedule/emerging days only.
  const rescueLikelyDays = scheduleDays.filter((d) => d.rescueLikely).length;
  const cycleDays = scheduleDays.filter((d): d is DayResult & { sleepCycle: SleepCycleEstimate } => d.sleepCycle !== null);
  const cycleConfidence = { low: 0, medium: 0, high: 0 };
  let learnedCount = 0;
  for (const d of cycleDays) {
    cycleConfidence[d.sleepCycle.confidence]++;
    if (d.sleepCycle.source === "learned") learnedCount++;
  }
  const cycleLearnedShare = cycleDays.length > 0
    ? Math.round(learnedCount / cycleDays.length * 100) / 100
    : 0;

  return {
    days,
    totalDays,
    napCountAccuracy,
    napStartMAE: Math.round(napStartMAE * 10) / 10,
    bedtimeMAE: Math.round(bedtimeMAE * 10) / 10,
    napCountBias: Math.round(napCountBias * 100) / 100,
    napStartBias: Math.round(napStartBias * 10) / 10,
    napDurationMAE: Math.round(napDurationMAE * 10) / 10,
    napEndMAE: Math.round(napEndMAE * 10) / 10,
    wakeTimeMAE: Math.round(wakeTimeMAE * 10) / 10,
    strategyCounts,
    sleepWindowHitRate,
    avgPredictedNapsPerDay,
    avgActualNapsPerDay,
    rescueLikelyDays,
    cycleConfidence,
    cycleLearnedShare,
  };
}

/**
 * Split a full BacktestResult into per-month age buckets.
 * Runs on the RESULTS, not the input — so each day retains its full lookback.
 */
export function bucketResultsByAge(
  result: BacktestResult,
  birthdate: string,
): { label: string; result: BacktestResult }[] {
  const byMonth = new Map<number, DayResult[]>();

  for (const day of result.days) {
    const age = calculateAgeMonths(birthdate, new Date(day.date + "T12:00:00Z"));
    if (!byMonth.has(age)) byMonth.set(age, []);
    byMonth.get(age)!.push(day);
  }

  return [...byMonth.entries()]
    .toSorted(([a], [b]) => a - b)
    .map(([age, days]) => ({
      label: `${age}mo`,
      result: summarize(days),
    }));
}

/**
 * Split results into ISO-week buckets (Monday-Sunday). Finer-grained
 * than per-month bucketing — useful for timeline tests that need to see
 * how cycle confidence + rescue activity move week-to-week. Each bucket
 * label is the week's start date (YYYY-MM-DD on Monday).
 */
export function bucketResultsByWeek(
  result: BacktestResult,
): { label: string; result: BacktestResult }[] {
  const byWeek = new Map<string, DayResult[]>();
  for (const day of result.days) {
    // Use UTC noon to avoid DST shift on week-start computation. ISO
    // week: Monday = day 1. JS Date.getUTCDay() returns 0 for Sunday.
    const dt = new Date(day.date + "T12:00:00Z");
    const dayOfWeek = (dt.getUTCDay() + 6) % 7; // 0 = Monday
    dt.setUTCDate(dt.getUTCDate() - dayOfWeek);
    const weekStart = dt.toISOString().slice(0, 10);
    if (!byWeek.has(weekStart)) byWeek.set(weekStart, []);
    byWeek.get(weekStart)!.push(day);
  }
  return [...byWeek.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([start, days]) => ({ label: `wk ${start}`, result: summarize(days) }));
}

/**
 * Split results by how many prior days of data were available.
 * Shows cold-start penalty and how quickly predictions stabilize.
 */
export function bucketByWarmup(
  result: BacktestResult,
  brackets: [number, number][] = [[1, 3], [4, 7], [8, 14], [15, Infinity]],
): { label: string; result: BacktestResult }[] {
  return brackets
    .map(([lo, hi]) => {
      const days = result.days.filter((d) => d.dayIndex >= lo && d.dayIndex <= hi);
      return {
        label: hi === Infinity ? `day ${lo}+` : `day ${lo}-${hi}`,
        result: summarize(days),
      };
    })
    .filter((b) => b.result.totalDays > 0);
}

/** Compact one-line summary for snapshot assertions. Stays terse so it
 *  fits in inline snapshots across many tests; per-day detail belongs
 *  in separate dedicated timeline tests.
 *
 *  Note: `cycle` and `cut-short` are CONTEXT metrics derived from
 *  actual history, not predictor outputs — they're identical across
 *  baseline strategies in `baseline comparison` tests. Repetition is
 *  intentional: it documents the data shape each strategy operates on.
 */
export function renderSummary(result: BacktestResult, label: string): string {
  const scheduleDays = result.days.filter((d) => d.strategy !== "newborn_guidance");
  const correct = scheduleDays.filter((d) => d.napCountError === 0).length;
  const pct = scheduleDays.length > 0 ? Math.round(correct / scheduleDays.length * 100) : 0;
  const cc = result.cycleConfidence;
  return [
    `${label}:`,
    `${result.totalDays} days,`,
    `count ${pct}% (${correct}/${scheduleDays.length}),`,
    `naps ${result.avgPredictedNapsPerDay.toFixed(1)}p/${result.avgActualNapsPerDay.toFixed(1)}a,`,
    `nap MAE ${result.napStartMAE},`,
    `dur MAE ${result.napDurationMAE},`,
    `bed MAE ${result.bedtimeMAE},`,
    `wake MAE ${result.wakeTimeMAE},`,
    `nap bias ${result.napStartBias > 0 ? "+" : ""}${result.napStartBias},`,
    `count bias ${result.napCountBias > 0 ? "+" : ""}${result.napCountBias},`,
    `cycle ${cc.low}/${cc.medium}/${cc.high} (l/m/h),`,
    // "cut-short" rather than "rescue" — this is the cut-short woken
    // signal, not a faithful rescue-trigger replay. See
    // `DayResult.rescueLikely` docstring.
    `cut-short ${result.rescueLikelyDays}`,
  ].join(" ");
}

/** Format a backtest result as a human-readable report string. */
export function formatReport(result: BacktestResult, label?: string): string {
  const lines: string[] = [];
  const hdr = label ?? "Backtest";
  lines.push(`${hdr} (${result.totalDays} days)`);
  lines.push("═".repeat(50));

  for (const day of result.days) {
    if (day.strategy === "newborn_guidance") {
      const hit = day.sleepWindowHit === true ? "✓" : day.sleepWindowHit === false ? "✗" : "—";
      lines.push(`${day.date}: [newborn] ${day.actualNaps.length} naps, window ${hit}`);
      continue;
    }

    const actual = day.actualNaps.length;
    const predicted = day.predictedNaps.length;
    const countOk = day.napCountError === 0 ? "✓" : "✗";
    lines.push(
      `${day.date}: ${countOk} predicted ${predicted} naps, actual ${actual}`,
    );

    for (let i = 0; i < day.napStartErrors.length; i++) {
      const err = day.napStartErrors[i];
      const pStart = day.predictedNaps[i].startTime.slice(11, 16);
      const aStart = day.actualNaps[i].start_time.slice(11, 16);
      const sign = err >= 0 ? "+" : "";
      lines.push(`  Nap ${i + 1}: predicted ${pStart}, actual ${aStart} → ${sign}${Math.round(err)} min`);
    }

    if (day.bedtimeError !== null) {
      const pBed = day.predictedBedtime.slice(11, 16);
      const aBed = day.actualBedtime!.slice(11, 16);
      const sign = day.bedtimeError >= 0 ? "+" : "";
      lines.push(`  Bedtime: predicted ${pBed}, actual ${aBed} → ${sign}${Math.round(day.bedtimeError)} min`);
    }
  }

  lines.push("═".repeat(50));
  const scheduleDays = result.days.filter((d) => d.strategy !== "newborn_guidance");
  const schedCorrect = scheduleDays.filter((d) => d.napCountError === 0).length;
  lines.push(`Nap count accuracy: ${Math.round(result.napCountAccuracy * 100)}% (${schedCorrect}/${scheduleDays.length})`);
  lines.push(`Nap start MAE: ${result.napStartMAE} min`);
  lines.push(`Nap duration MAE: ${result.napDurationMAE} min`);
  lines.push(`Nap end MAE: ${result.napEndMAE} min`);
  lines.push(`Nap start bias: ${result.napStartBias > 0 ? "+" : ""}${result.napStartBias} min (positive = predicting too late)`);
  lines.push(`Bedtime MAE: ${result.bedtimeMAE} min`);
  lines.push(`Wake time MAE: ${result.wakeTimeMAE} min`);
  lines.push(`Nap count bias: ${result.napCountBias > 0 ? "+" : ""}${result.napCountBias} (positive = over-predicting)`);

  return lines.join("\n");
}
