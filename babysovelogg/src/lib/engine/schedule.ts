import { WAKE_WINDOWS, NAP_COUNTS, SLEEP_NEEDS, RESCUE_NAP, NAP_BUDGET, findByAge } from "./constants.js";
export { WAKE_WINDOWS, NAP_COUNTS, SLEEP_NEEDS, RESCUE_NAP, findByAge } from "./constants.js";
export type { SleepEntry } from "$lib/types.js";
import type {
  SleepEntry, BabyContext, PredictionFeatures, SleepCyclePrior, SleepCycleEstimate,
} from "$lib/types.js";
export type { SleepCyclePrior, SleepCycleEstimate } from "$lib/types.js";
import { getHourInTz, setHourInTz, isoToDateInTz, getMinuteOfDayInTz } from "$lib/tz.js";
import { netDurationMin } from "./stats.js";
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
  /** Captured wake reason (or null). Drives right-censoring of cut-short naps. */
  wokeBy: "self" | "woken" | null;
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
      wokeBy: s.woke_by ?? null,
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

export interface PredictDayNapsOptions {
  /**
   * True only for morning-plan calls anchored to today's first wake-up.
   * Required to enable the late-wake re-anchor (which would misfire on
   * post-nap / post-cut-short re-plans where index 0 is "next remaining
   * nap", not "first nap after morning wake"). State assembly's morning
   * `selectBestPlan(todayWakeUp.wake_time, ...)` opts in explicitly; the
   * adjusted-replan calls deliberately don't. Direct callers (backtest
   * harness, scripts) leave it unset and stay inert by default.
   */
  dayStart?: boolean;
}

/** Predict all naps for the day based on wake-up time and recent sleep patterns. */
export function predictDayNaps(
  wakeUpTime: string,
  ctx: BabyContext,
  options: PredictDayNapsOptions = {},
): PredictedNap[] {
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

  // Late-wake re-anchor inputs. Only the morning day-start call on a
  // routine_schedule baby may lift the prediction by one cycle; everyone
  // else (emerging assembly, mid-day re-plans, off-days) is inert.
  // Codex pair-review 2026-05-20: index 0 inside the per-nap loop is the
  // *next remaining nap* on re-plans, not "first nap after morning wake",
  // so the dayStart gate must be explicit.
  const reAnchorEligible =
    options.dayStart === true
    && useHabitualNapStart
    && ctx.strategy === "routine_schedule"
    && !isOffDayForWake(ctx, wakeUpTime);
  // Late-wake re-anchor deliberately uses the age-default cycle, not
  // the data-learned estimate. Re-anchor logic doesn't need
  // baby-specific precision (it's snapping a wake-window blend onto the
  // nearest cycle boundary), and using the learned value here would
  // expose a confidence-gated decision to a code path that doesn't read
  // `sleepCycle.confidence`. If/when we want this to track learned
  // cycles, replace with `estimatePhaseShiftCycleMin(ctx)` that gates
  // on medium/high confidence. See followups.md.
  const cycleMinForReAnchor = getSleepCycleMinutes(ctx.ageMonths);
  const recentWakeAnchorMin = reAnchorEligible
    ? recentWakeMedianMinute(ctx, wakeUpTime)
    : null;

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
      const candidateMs = i === 0 && reAnchorEligible
        ? applyLateWakeReAnchor({
            blendMs: blendedMs,
            habitualMs,
            pressureMs: pressureStart.getTime(),
            wakeMs: currentWake.getTime(),
            recentWakeAnchorMin,
            cycleMin: cycleMinForReAnchor,
            tz: ctx.tz,
          }).candidateMs
        : blendedMs;
      napStart = new Date(Math.round(candidateMs));
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
 * Decomposed first-nap prediction. All numeric times are epoch ms.
 *
 * Useful for tests and the debug CLI — the production code path hides
 * intermediates inside a blend + (optionally) a re-anchor, and a previous
 * pass missed the fact that the visible "10:53" prediction was coming out
 * of a habit anchor dominating a late-wake outlier. With this shape every
 * component (pressure, habit, weight, blend, recent-wake anchor, offset,
 * cycle, snap) is observable.
 */
export interface FirstNapDecomposition {
  pressureMs: number;
  habitualMs: number | null;
  habitWeight: number;
  blendMs: number;
  /** Recent wake median (minute-of-day, in baby tz). null when too sparse. */
  recentWakeAnchorMin: number | null;
  /** Today wake minute-of-day in baby tz. */
  todayWakeMin: number;
  wakeOffsetMin: number | null;
  cycleMin: number;
  /** How many cycles the habit anchor was lifted by (0 = no re-anchor). */
  cyclesSnapped: number;
  reAnchored: boolean;
  finalMs: number;
}

/**
 * Recompute the first nap prediction with every intermediate value
 * exposed. Takes the same options as {@link predictDayNaps} so the
 * decomposition reports what production actually evaluates — pass
 * `{ dayStart: true }` to mirror the morning-plan path, omit it to see
 * the inert/blend-only result other callers get. Returns null when
 * there's no first nap (e.g. `expectedNaps === 0`). Intended for debug
 * and tests; production code should call `predictDayNaps`.
 */
export function decomposeFirstNapPrediction(
  wakeUpTime: string,
  ctx: BabyContext,
  options: PredictDayNapsOptions = { dayStart: true },
): FirstNapDecomposition | null {
  const expectedNaps = resolveNapCount(ctx);
  if (expectedNaps < 1) return null;

  const defaultWW = getWakeWindow(ctx);
  const { wws: positionalWWs } = getPositionalDataForNapCount(ctx, expectedNaps);

  const useHabitualNapStart = feat(ctx, "habitualNapStart") && ctx.ageMonths >= 5;
  let habitualMs: number | undefined;
  let habitWeight = 0;
  if (useHabitualNapStart) {
    const napData = collectHabitualNapData(ctx, expectedNaps);
    habitualMs = computeHabitualNapStarts(wakeUpTime, ctx, expectedNaps, napData.startSamples)[0];
    habitWeight = computeHabitualNapWeights(expectedNaps, napData.startSamples, napData.wwSamples)[0] ?? 0;
  }

  const wakeDate = new Date(wakeUpTime);
  const wakeMs = wakeDate.getTime();
  const ww = positionalWWs[0] ?? defaultWW;
  const pressureMs = wakeMs + ww * 60_000;

  let blendMs: number;
  if (habitualMs !== undefined && habitWeight > 0 && habitualMs > wakeMs) {
    blendMs = pressureMs * (1 - habitWeight) + habitualMs * habitWeight;
  } else {
    blendMs = pressureMs;
  }

  // Mirror predictDayNaps' gating so the decomposition's `reAnchored` flag
  // reflects production semantics — Codex review 2026-05-20.
  const reAnchorEligible =
    options.dayStart === true
    && useHabitualNapStart
    && ctx.strategy === "routine_schedule"
    && !isOffDayForWake(ctx, wakeUpTime);
  // Age-research default cycle; see the matching note in `predictDayNaps`.
  const cycleMin = getSleepCycleMinutes(ctx.ageMonths);
  const recentWakeAnchorMin = reAnchorEligible ? recentWakeMedianMinute(ctx, wakeUpTime) : null;
  const todayWakeMin = getMinuteOfDayInTz(wakeDate, ctx.tz);
  const reAnchorOutcome = reAnchorEligible
    ? applyLateWakeReAnchor({
        blendMs,
        habitualMs,
        pressureMs,
        wakeMs,
        recentWakeAnchorMin,
        cycleMin,
        tz: ctx.tz,
      })
    : { candidateMs: blendMs, cyclesSnapped: 0, reAnchored: false };

  return {
    pressureMs,
    habitualMs: habitualMs ?? null,
    habitWeight,
    blendMs,
    recentWakeAnchorMin,
    todayWakeMin,
    wakeOffsetMin: recentWakeAnchorMin !== null ? todayWakeMin - recentWakeAnchorMin : null,
    cycleMin,
    cyclesSnapped: reAnchorOutcome.cyclesSnapped,
    reAnchored: reAnchorOutcome.reAnchored,
    finalMs: Math.round(reAnchorOutcome.candidateMs),
  };
}

/**
 * True when the baby's `offDays` set covers the local date of `wakeUpTime`.
 * Used to suppress same-day adaptive behaviour on sick / travel / DST days
 * — Codex review 2026-05-20 flagged that the re-anchor was happy to lift
 * predictions on the exact days the parent already told the engine to back
 * off. Mirrors `computeNapBudget`'s off-day gate (`nap-budget.ts:107`).
 */
function isOffDayForWake(ctx: BabyContext, wakeUpTime: string): boolean {
  if (!ctx.offDays || ctx.offDays.size === 0) return false;
  return ctx.offDays.has(isoToDateInTz(wakeUpTime, ctx.tz));
}

/**
 * Weighted-median wake clock (minute-of-day, in baby tz) across the
 * recent overnight sleeps available in `ctx.recentSleeps` (the same
 * window the rest of the prediction path consumes — 7 days from the
 * server). Excludes any night whose end-time is at or after `wakeUpTime`
 * so today's own wake doesn't drag the median toward itself when this
 * morning is itself a late-wake outlier.
 *
 * Returns null when fewer than 3 prior nights are available — sparser
 * histories don't carry a useful "typical wake" signal.
 */
function recentWakeMedianMinute(ctx: BabyContext, wakeUpTime: string): number | null {
  const cache = getCache(ctx);
  const wakeMs = new Date(wakeUpTime).getTime();
  const past = cache.nights.filter((n) => n.endMs < wakeMs).toSorted((a, b) => b.endMs - a.endMs);
  if (past.length < 3) return null;
  const samples: WeightedSample[] = [];
  for (let i = 0; i < past.length; i++) {
    const minute = getMinuteOfDayInTz(new Date(past[i].endMs), ctx.tz);
    samples.push({ value: minute, weight: Math.pow(0.85, i) });
  }
  return weightedMedian(samples);
}

interface LateWakeReAnchorInput {
  blendMs: number;
  habitualMs: number | undefined;
  pressureMs: number;
  wakeMs: number;
  recentWakeAnchorMin: number | null;
  cycleMin: number;
  tz: string;
}

interface LateWakeReAnchorOutcome {
  candidateMs: number;
  cyclesSnapped: number;
  reAnchored: boolean;
}

/**
 * Bounded late-wake re-anchor. When today's wake clock is at least one
 * full sleep cycle later than the baby's recent typical wake, lift the
 * habit anchor by an integer cycle so a clock-stable habit doesn't drag
 * the predicted first nap earlier than the baby's circadian pressure
 * supports. The lift is capped at one cycle (v1) and at the
 * pressure-only estimate, and only ever fires when:
 *
 *   - the engine has a real habit anchor to begin with,
 *   - the pressure-based estimate is already later than habit
 *     (otherwise the existing blend is fine),
 *   - the recent wake-clock anchor is well-defined,
 *   - today's wake offset is ≥ one cycle (so `floor(offset/cycle) ≥ 1`).
 *
 * The result is `max(blend, min(habit + snap, pressure))`: we never go
 * earlier than the existing blend, and we never go past raw pressure.
 *
 * Codex pair-review 2026-05-20 endorsed this shape over an earlier
 * `max(pressure, blend)` proposal, which would have overshot Halldis's
 * actual nap timing on a +90 min late-wake day (pressure-only ~11:59
 * Oslo vs the parent's observed ~11:15).
 */
function applyLateWakeReAnchor(input: LateWakeReAnchorInput): LateWakeReAnchorOutcome {
  const { blendMs, habitualMs, pressureMs, wakeMs, recentWakeAnchorMin, cycleMin, tz } = input;
  const inert: LateWakeReAnchorOutcome = { candidateMs: blendMs, cyclesSnapped: 0, reAnchored: false };

  if (habitualMs === undefined) return inert;
  if (recentWakeAnchorMin === null) return inert;
  if (pressureMs <= habitualMs) return inert;

  const todayWakeMin = getMinuteOfDayInTz(new Date(wakeMs), tz);
  const offsetMin = todayWakeMin - recentWakeAnchorMin;
  if (offsetMin < cycleMin) return inert;

  const cyclesConsidered = Math.min(Math.floor(offsetMin / cycleMin), 1);
  if (cyclesConsidered <= 0) return inert;

  const shiftedHabitMs = habitualMs + cyclesConsidered * cycleMin * 60_000;
  const cappedShiftedMs = Math.min(shiftedHabitMs, pressureMs);
  const candidateMs = Math.max(blendMs, cappedShiftedMs);
  const reAnchored = candidateMs > blendMs;

  // Only report `cyclesSnapped` when the snap actually moved the
  // candidate past the existing blend; if the blend already lay past the
  // shifted habit then no lift happened and the diagnostic must say so.
  return { candidateMs, cyclesSnapped: reAnchored ? cyclesConsidered : 0, reAnchored };
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
export function recommendBedtime(todaySleeps: SleepEntry[], ctx: BabyContext, now?: number): string {
  const nowMs = now ?? Date.now();
  const targetNaps = resolveNapCount(ctx);

  const lastSleep = [...todaySleeps]
    .filter((s) => s.end_time)
    .toSorted((a, b) => new Date(b.end_time!).getTime() - new Date(a.end_time!).getTime())[0];

  if (!lastSleep?.end_time) {
    return setHourInTz(new Date(nowMs), 19, 0, ctx.tz).toISOString();
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
    const allSynthetic = todaySleeps.every((s) => !s.end_time || new Date(s.end_time).getTime() > nowMs);
    const syntheticPenalty = allSynthetic ? 0.5 : 1.0;
    const weight = (hasEnoughNaps ? baseWeight : baseWeight * 0.5) * syntheticPenalty;
    const blendedMs = pressureBedtime.getTime() * (1 - weight) + habitualBedtimeMs * weight;
    bedtime = new Date(Math.round(blendedMs));
  } else {
    bedtime = pressureBedtime;
  }

  // Target soft-anchor: if the family set a target_bedtime, nudge the
  // blended bedtime toward target by the asymmetric daily cap. The shift
  // is bounded per-day; convergence is multi-day (as the family acts on
  // each day's suggestion, history shifts and tomorrow's blended bedtime
  // anchors closer to target). See DAILY_SHIFT_CAP_*_MS rationale.
  //
  // This used to live in selectBestPlan as a separate "effective target"
  // calculation that produced an extra plan candidate. Moving it here
  // keeps target as a property of natural's bedtime itself, which is
  // architecturally cleaner — selectBestPlan stays focused on day-shape
  // feasibility, not target manipulation.
  if (ctx.targetBedtime) {
    const targetMs = new Date(targetBedtimeToISO(ctx.targetBedtime, nowMs, ctx.tz)).getTime();
    const currentMs = bedtime.getTime();
    const rawShift = targetMs - currentMs;
    const shift = rawShift > 0
      ? Math.min(DAILY_SHIFT_CAP_LATER_MS, rawShift)
      : Math.max(-DAILY_SHIFT_CAP_EARLIER_MS, rawShift);
    bedtime = new Date(currentMs + shift);
  }

  // Wide sanity clamp in the baby's local time. Anchor the clamp on the day
  // implied by the last completed sleep — without that, an overflowed
  // calculation that lands past midnight gets clamped to 16:00 of THE NEXT
  // DAY, which is what produced "bedtime in 22h 17m" pointing to tomorrow.
  const dayAnchor = new Date(lastSleep.end_time);
  const dayAnchorDate = isoToDateInTz(dayAnchor.toISOString(), ctx.tz);
  const bedtimeLocalDate = isoToDateInTz(bedtime.toISOString(), ctx.tz);
  if (bedtimeLocalDate !== dayAnchorDate) {
    // Calculation wrapped to a different day — pin to the anchor day's 23:00.
    return setHourInTz(dayAnchor, 23, 0, ctx.tz).toISOString();
  }
  const hour = getHourInTz(bedtime, ctx.tz);
  // Floor at 17:00 local. The May-7 fix used 16:00, but the May-2026 review
  // surfaced cases where overtired-day pressure math produced 16:15-16:22
  // bedtimes for babies whose target was 19:15-19:45 — clearly too early.
  // 17:00 is the earliest realistic bedtime for the babies this app targets.
  if (hour < 17) return setHourInTz(dayAnchor, 17, 0, ctx.tz).toISOString();
  if (hour > 23) return setHourInTz(dayAnchor, 23, 0, ctx.tz).toISOString();

  return bedtime.toISOString();
}

/**
 * Find the morning-wake anchor for the given day's bucket: end_time of the
 * overnight that started yesterday and ended this morning. The cache buckets
 * by `start_time` local date, so a bedtime-at-18:00 night belongs to the
 * *previous* day's list — looking it up here is what lets position 0 mean
 * "wake → nap1" instead of "nap1.end → nap2.start".
 *
 * Returns null when there's no prior bucket or no night entry in it (true
 * first onboarding day, or yesterday was logging-incomplete). The caller
 * just drops position-0 for that day rather than mis-attributing.
 */
function morningWakeMs(cache: SleepCache, dayKey: string): number | null {
  const idx = cache.sortedDayKeys.indexOf(dayKey);
  if (idx <= 0) return null;
  const prev = cache.byDay.get(cache.sortedDayKeys[idx - 1]);
  if (!prev) return null;
  for (let k = prev.length - 1; k >= 0; k--) {
    if (prev[k].type === "night") return prev[k].endMs;
  }
  return null;
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
    const priorEndMs = morningWakeMs(cache, dayKey);
    let napPosition = 0;
    for (let i = 0; i < daySleeps.length; i++) {
      if (daySleeps[i].type !== "nap") continue; // skip gaps before night sleep
      const prevEndMs = i === 0 ? priorEndMs : daySleeps[i - 1].endMs;
      if (prevEndMs == null) {
        napPosition++;
        continue;
      }
      const gapMin = (daySleeps[i].startMs - prevEndMs) / 60000;
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

  // Build the censored set up front (same rule as getPositionalNapDurations)
  // so this transition-filtered branch doesn't silently learn from cut-shorts.
  const matchingNaps = cache.naps.filter((s) =>
    cache.daysWithNight.has(s.localDate)
    && cache.napCountByDay.get(s.localDate) === targetNapCount,
  );
  const censoredMatching = new Set(censorCutShortNaps(matchingNaps, ctx, getExtendedSelfMedianMin(ctx)));

  for (const dayKey of matchingDayKeys) {
    const daySleeps = cache.byDay.get(dayKey)!;
    const priorEndMs = morningWakeMs(cache, dayKey);

    let napPos = 0;
    for (let i = 0; i < daySleeps.length; i++) {
      if (daySleeps[i].type !== "nap") continue;
      const prevEndMs = i === 0 ? priorEndMs : daySleeps[i - 1].endMs;
      if (prevEndMs == null) {
        napPos++;
        continue;
      }
      const gapMin = (daySleeps[i].startMs - prevEndMs) / 60000;
      if (gapMin >= 10 && gapMin <= 480) {
        if (!gapsByPos.has(napPos)) gapsByPos.set(napPos, []);
        gapsByPos.get(napPos)!.push(gapMin);
      }
      napPos++;
    }

    // Collect durations (skipping censored cut-shorts; position index is
    // preserved across drops to keep 1st-vs-2nd alignment).
    const dayNaps = daySleeps.filter((s) => s.type === "nap");
    for (let i = 0; i < dayNaps.length; i++) {
      if (!censoredMatching.has(dayNaps[i])) continue;
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
  // Cut-shorts pollute positional learning the same way they pollute the
  // global learned mean — a parent-cut 41 min "1st nap" makes the planner
  // schedule a 41 min nap into the future. Drop them here too.
  const censored = new Set(censorCutShortNaps(cache.naps, ctx, getExtendedSelfMedianMin(ctx)));
  const dursByPosition = new Map<number, number[]>();

  for (const [dayKey, daySleeps] of cache.byDay) {
    if (!cache.daysWithNight.has(dayKey)) continue;
    let napIdx = 0;
    for (const s of daySleeps) {
      if (s.type !== "nap") continue;
      if (!censored.has(s)) { napIdx++; continue; }
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

/** Learn average night sleep duration (minutes) from recent completed nights.
 *  Intentionally the GROSS bedtime→wake span (includes night wakings): the
 *  prediction is morning-wake = bedtime + this span, and the baby is in the
 *  crib through the wakings. Netting pauses here would predict wake too early.
 *  (Sleep-amount totals net pauses via netDurationMin; this is a span.) */
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

/** Median of `values` in minutes, or null if fewer than 3 samples. */
function stableMedianMin(values: number[]): number | null {
  if (values.length < 3) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Self-wake median computed over the optional `extendedSleeps` window
 * (typically 21 days), filtered to days that match the current dominant nap
 * count. Returns null if extendedSleeps isn't set or there's still too little
 * matching data — caller should fall back to the per-call self-median.
 *
 * The nap-count filter is the transition guard: a 2→1 nap baby's old-regime
 * days have a different natural duration distribution and would skew the
 * censor threshold. We restrict to days matching the baby's *current*
 * dominant nap count (or napCount when no learned signal yet).
 */
function getExtendedSelfMedianMin(ctx: BabyContext): number | null {
  if (ctx._extendedSelfMedian !== undefined) return ctx._extendedSelfMedian;
  if (!ctx.extendedSleeps || ctx.extendedSleeps.length === 0) {
    ctx._extendedSelfMedian = null;
    return null;
  }

  const targetNapCount = resolveNapCount(ctx);
  const napCountByDay = new Map<string, number>();
  const dayBuckets = new Map<string, { startMs: number; endMs: number; wokeBy: "self" | "woken" | null; type: "nap" | "night" }[]>();

  for (const s of ctx.extendedSleeps) {
    if (!s.end_time) continue;
    const day = isoToDateInTz(s.start_time, ctx.tz);
    let bucket = dayBuckets.get(day);
    if (!bucket) {
      bucket = [];
      dayBuckets.set(day, bucket);
    }
    bucket.push({
      startMs: new Date(s.start_time).getTime(),
      endMs: new Date(s.end_time).getTime(),
      wokeBy: s.woke_by ?? null,
      type: s.type,
    });
    if (s.type === "nap") napCountByDay.set(day, (napCountByDay.get(day) ?? 0) + 1);
  }

  const selfDurs: number[] = [];
  for (const [day, bucket] of dayBuckets) {
    if ((napCountByDay.get(day) ?? 0) !== targetNapCount) continue;
    if (!bucket.some((s) => s.type === "night")) continue; // require complete day
    for (const s of bucket) {
      if (s.type !== "nap" || s.wokeBy !== "self") continue;
      const dur = (s.endMs - s.startMs) / 60_000;
      if (dur >= 10 && dur <= 180) selfDurs.push(dur);
    }
  }

  const median = stableMedianMin(selfDurs);
  ctx._extendedSelfMedian = median;
  return median;
}

/**
 * Drop parent-ended naps that look obviously cut short — i.e. shorter than the
 * baby's own self-wake median. The truth they reveal is "natural duration ≥
 * observed", not a sample of natural duration; treating them as samples shrinks
 * the learned mean. Long parent-ended naps (≥ self-median) are kept: they're
 * naps the baby was probably done with anyway.
 *
 * **Cap-respect carve-out** (Codex 2026-05-13 review). The day's *last* woken
 * nap on a near-trend day is more likely cap-respect than cut-short. Without
 * this carve-out, the engine's own cap recommendations gradually erase the
 * learned natural duration: parent obliges → "woken" nap below the current
 * self-wake median → censored → learned duration stays put → engine keeps
 * recommending cap from the same stale baseline. Halldis could cap 30 naps
 * and still see learnedNapDuration = 120. Two gates: (a) last-nap-of-day
 * position, (b) day's total sleep cleared the age-band minimum. (b) proxies
 * for "day landed near trend" without persisting historical trend math.
 *
 * If there are too few self-wake samples to compute a stable median (< 3), we
 * skip filtering — using noisy real data beats falling back to the prior with
 * no samples at all.
 */
function censorCutShortNaps(
  naps: CachedSleep[],
  ctx: BabyContext,
  explicitMedianMin?: number | null,
): CachedSleep[] {
  const median = explicitMedianMin ?? stableMedianMin(
    naps.filter((s) => s.wokeBy === "self").map((s) => (s.endMs - s.startMs) / 60_000),
  );
  if (median === null) return naps;

  const lastNapByDay = new Map<string, CachedSleep>();
  for (const s of naps) {
    const existing = lastNapByDay.get(s.localDate);
    if (!existing || s.startMs > existing.startMs) {
      lastNapByDay.set(s.localDate, s);
    }
  }
  // Day total includes nights — naps[] only has naps, so reach into the
  // raw recentSleeps for the night entries. Start-anchored localDate keeps
  // the bookkeeping consistent with the rest of the engine.
  const totalMinByDay = new Map<string, number>();
  for (const cs of naps) {
    totalMinByDay.set(
      cs.localDate,
      (totalMinByDay.get(cs.localDate) ?? 0) + (cs.endMs - cs.startMs) / 60_000,
    );
  }
  for (const s of ctx.recentSleeps) {
    if (s.type !== "night" || !s.end_time) continue;
    // Net night wakings out: this total is compared against `dayTargetMin`,
    // which derives from the net trend reference. A gross night would inflate
    // the total on a wakeful night and wrongly qualify the last nap for the
    // cap-respect carve-out.
    const dur = netDurationMin(s);
    const dayKey = localDate(s.start_time, ctx.tz);
    totalMinByDay.set(dayKey, (totalMinByDay.get(dayKey) ?? 0) + dur);
  }
  // Cap-respect carve-out target. The carve-out is meant to capture "the
  // day landed near trend, so the parent ending the nap was a deliberate
  // cap, not a deficit". Compare against the blended 7d/30d trend (set
  // once in assembleState's buildContext so the censor and the napBudget
  // engine see the same number) — that's the *actual* daily target the
  // napBudget engine recommends to. Fall back to the conservative age-
  // band floor when trend math returned null (sparse data, noisy week,
  // sick spurt) or the caller didn't compute one. Without this, a day at
  // 12 h (age-band-min for 9-12mo) but 1 h below a 13 h trend would
  // still qualify, slightly under-stating learnedNapDuration on real
  // cap-respect days.
  // Cap-respect day-target uses the *intervention* number — that's what
  // napBudget recommends to, so "was this day plausibly cap-respecting?"
  // must compare against the same target. Falls back to observed (trend
  // total) when intervention isn't set yet (older ctx, tests), and to
  // the age-band floor when neither is available. Codex 2026-05-20
  // design at `local/codex-trend-split-design.md` §"Which target should
  // each consumer use?".
  const ageBandMinTotalMin = findByAge(SLEEP_NEEDS, ctx.ageMonths).range[0] * 60;
  const referenceTotalMin = ctx.interventionTrendTargetMin
    ?? ctx.trendTotalMin
    ?? null;
  const dayTargetMin = referenceTotalMin != null
    ? referenceTotalMin - NAP_BUDGET.TOLERANCE_MIN
    : ageBandMinTotalMin;
  // Anything below 30 min is a micro-nap regardless of position — never
  // qualifies for the cap-respect carve-out.
  const CAP_RESPECT_FLOOR_MIN = 30;

  return naps.filter((s) => {
    if (s.wokeBy !== "woken") return true;
    const dur = (s.endMs - s.startMs) / 60_000;
    if (dur >= median) return true;
    if (
      lastNapByDay.get(s.localDate) === s
      && dur >= CAP_RESPECT_FLOOR_MIN
      && (totalMinByDay.get(s.localDate) ?? 0) >= dayTargetMin
    ) {
      return true;
    }
    return false;
  });
}

/** Learn average nap duration from recent completed naps, fallback to age-based defaults. */
export function getLearnedNapDuration(ctx: BabyContext): number {
  const defaultDuration = defaultNapDurationPrior(ctx);
  if (ctx.recentSleeps.length === 0) return defaultDuration;

  const cache = getCache(ctx);

  // Only learn from naps on complete days (have a night entry).
  // Naps from incomplete days may include misclassified overnight fragments.
  // Then drop obvious cut-shorts (parent-ended below self-wake median).
  const completeNaps = cache.naps.filter((s) => cache.daysWithNight.has(s.localDate));
  const learnable = censorCutShortNaps(completeNaps, ctx, getExtendedSelfMedianMin(ctx));

  if (feat(ctx, "weightedRecency")) {
    const samples = collectWeightedDurationsFromCache(learnable, 10, 180);
    if (samples.length < 3) return defaultDuration;
    const learned = weightedTrimmedMean(samples);
    return Math.round(blendEstimate(defaultDuration, learned, samples.length, 3, 8));
  }

  // Simple average fallback
  if (learnable.length < 3) return defaultDuration;
  const durations = learnable
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
    predictedDuration = snapToCycleBoundary(targetDuration, cycleMinutes, 10, 180);
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

  // Most recently-ended nap, independent of input order (callers previously
  // relied on the server's start_time DESC ordering passing in completedNaps[0]).
  const lastNap = completedNaps.reduce<(typeof completedNaps)[number] | undefined>(
    (latest, n) =>
      !latest || new Date(n.end_time).getTime() > new Date(latest.end_time).getTime() ? n : latest,
    undefined,
  );
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
    durationMin = snapToCycleBoundary(durationEstimate, cycleMinutes, 360, 900);
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

// Trim `trimFraction` of the total *weight* mass off each value-sorted tail,
// not a fixed sample count. Count-trimming (floor(n·f)) only bit at n≥7 and
// then discarded a whole sample regardless of its recency weight — so a recent
// high-weight extreme was dropped purely for being extreme. Weight-trimming
// caps an outlier's pull while keeping its recency contribution: the boundary
// sample is partially weighted by the overflow rather than removed wholesale.
function weightedTrimmedMean(samples: WeightedSample[], trimFraction = 0.15): number {
  if (samples.length <= 2) return weightedMean(samples);
  const sorted = samples.toSorted((a, b) => a.value - b.value).map((s) => ({ ...s }));
  const totalWeight = sorted.reduce((sum, s) => sum + s.weight, 0);
  if (totalWeight === 0) return 0;

  const trimWeight = totalWeight * trimFraction;
  let lowBudget = trimWeight;
  for (const s of sorted) {
    if (lowBudget <= 0) break;
    const cut = Math.min(s.weight, lowBudget);
    s.weight -= cut;
    lowBudget -= cut;
  }
  let highBudget = trimWeight;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (highBudget <= 0) break;
    const cut = Math.min(sorted[i].weight, highBudget);
    sorted[i].weight -= cut;
    highBudget -= cut;
  }
  return weightedMean(sorted);
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

// ─── Sleep cycle estimator v2 ──────────────────────────────────────────────
//
// Research-backed: age prior gates the search range, multi-cycle fit scores
// candidates, multiplicity discount + prior penalty break aliases, and an
// explicit confidence/source surface tells consumers when to trust the
// learned number vs the age-default. See docs/followups.md →
// "Cycle estimator v2" and the Codex design pair-review 2026-05-24.

// Prior means are anchored to the pre-existing `getSleepCycleMinutes`
// age-default ladder (50 / 50 / 55 / 60 / 60) so that the prior-mean
// path — which `predictNapEndTime`, `predictNightEndTime`, and the
// late-wake re-anchor all read directly — doesn't shift baseline
// behavior. Codex 2026-05-25 final-diff review flagged: extrapolating
// new mid-band priors (52 / 65) for 3-6mo and 24+mo was an unintended
// algorithm change that surfaced in baby_1's 26-27mo wake MAE.
// Ranges are the search/rejection bounds the new estimator uses; SDs
// derive from Lopp/Jenni's ±2.4 at 9mo widened slightly so the data
// can overwhelm the prior at typical sample counts.
const CYCLE_PRIORS: { ageMin: number; prior: SleepCyclePrior }[] = [
  { ageMin: 0,  prior: { meanMin: 50, sdMin: 6, rangeMin: [40, 60] } },
  { ageMin: 3,  prior: { meanMin: 50, sdMin: 5, rangeMin: [45, 60] } },
  { ageMin: 6,  prior: { meanMin: 55, sdMin: 4, rangeMin: [50, 65] } },
  { ageMin: 12, prior: { meanMin: 60, sdMin: 5, rangeMin: [55, 70] } },
  { ageMin: 24, prior: { meanMin: 60, sdMin: 6, rangeMin: [55, 70] } },
];

export function getSleepCyclePrior(ageMonths: number): SleepCyclePrior {
  let chosen = CYCLE_PRIORS[0].prior;
  for (const band of CYCLE_PRIORS) {
    if (ageMonths >= band.ageMin) chosen = band.prior;
  }
  return chosen;
}

interface CycleNapSample {
  durationMin: number;
  weight: number;
}

/**
 * Strict self-wake nap samples from the long-horizon cycleSleeps window.
 *
 * Differences from `censorCutShortNaps`:
 *   - `wokeBy === "self"` only — no cap-respect carve-out (that's a
 *     duration-learning trick that poisons cycle estimation).
 *   - No median floor — even short clean self-wakes are real cycle data.
 *   - Soft regime weights (1.0 / 0.5 / 0.2) instead of a hard nap-count
 *     filter — cycle physiology moves more slowly than nap-count regime.
 *   - Recency weight is gentle (0.5 → 1.0 across the window) so old clean
 *     data still contributes.
 */
function collectCycleNapSamples(ctx: BabyContext): CycleNapSample[] {
  const sleeps =
    ctx.cycleSleeps ?? ctx.trendSleeps ?? ctx.extendedSleeps ?? ctx.recentSleeps;
  if (!sleeps || sleeps.length === 0) return [];

  const targetNapCount = resolveNapCount(ctx);
  const offDays = ctx.offDays;
  type DayBucket = {
    naps: { startMs: number; endMs: number; wokeBy: "self" | "woken" | null }[];
    hasNight: boolean;
  };
  const byDay = new Map<string, DayBucket>();

  for (const s of sleeps) {
    if (!s.end_time) continue;
    const day = isoToDateInTz(s.start_time, ctx.tz);
    if (offDays?.has(day)) continue;
    let bucket = byDay.get(day);
    if (!bucket) {
      bucket = { naps: [], hasNight: false };
      byDay.set(day, bucket);
    }
    if (s.type === "night") {
      bucket.hasNight = true;
    } else {
      bucket.naps.push({
        startMs: new Date(s.start_time).getTime(),
        endMs: new Date(s.end_time).getTime(),
        wokeBy: s.woke_by ?? null,
      });
    }
  }

  // First pass: collect per-day clean self-wake durations + regime weight,
  // keeping only sample-bearing days. Second pass: apply recency weight
  // indexed by *sample-bearing* day position, not by raw day position —
  // otherwise adding cap-respect (woken) days to a baby's history would
  // push the existing self-wakes "into the past", dropping effectiveN even
  // though the cycle evidence is unchanged.
  const dayKeys = [...byDay.keys()].toSorted();
  type DayDraft = { regimeWeight: number; durations: number[] };
  const drafts = new Map<string, DayDraft>();
  for (const day of dayKeys) {
    const bucket = byDay.get(day)!;
    if (!bucket.hasNight) continue;
    const dayNapCount = bucket.naps.length;
    const regimeDelta = Math.abs(dayNapCount - targetNapCount);
    const regimeWeight =
      regimeDelta === 0 ? 1.0 : regimeDelta === 1 ? 0.5 : 0.2;
    const durations: number[] = [];
    for (const n of bucket.naps) {
      if (n.wokeBy !== "self") continue;
      const dur = (n.endMs - n.startMs) / 60_000;
      if (dur < 20 || dur > 180) continue;
      durations.push(dur);
    }
    if (durations.length > 0) drafts.set(day, { regimeWeight, durations });
  }
  if (drafts.size === 0) return [];
  const sampleDayKeys = [...drafts.keys()].toSorted();
  const totalSampleDays = sampleDayKeys.length;
  const samples: CycleNapSample[] = [];
  for (let i = 0; i < totalSampleDays; i++) {
    const draft = drafts.get(sampleDayKeys[i])!;
    // Recency: oldest sample-bearing day 0.5, newest 1.0. Codex review
    // 2026-05-25 pushed back on a 0.7 floor as too weak decay over a
    // 180-day window — stale pre-transition evidence could keep driving
    // learned cycles long after recent behavior stopped confirming it.
    const recencyWeight =
      totalSampleDays <= 1 ? 1.0 : 0.5 + 0.5 * (i / (totalSampleDays - 1));
    const weight = draft.regimeWeight * recencyWeight;
    for (const dur of draft.durations) {
      samples.push({ durationMin: dur, weight });
    }
  }
  return samples;
}

// Scoring constants. SIGMA_DATA is the expected std of (sample - k*cycle)
// residuals for a clean self-wake nap; 4 min is on the tight side, which
// is right because the per-nap censoring is already strict (self-wake
// only, in-range, complete day).
const SIGMA_DATA_MIN = 4;
// Mild multiplicity discount — Codex recommended a "gentle, secondary"
// term so the age prior remains the primary alias defense.
const MULTIPLICITY_ALPHA = 0.2;
// Best vs prior-mean candidate must clear this per-effective-sample
// log-score gain to be reported as "learned". Codex 2026-05-25 pushed
// back on a 0.05 floor — at N=5 that's only 0.25 total log-units,
// below a 2-min residual improvement per sample. 0.10 keeps weak
// evidence hedged to "age-default" instead of overclaiming.
const PER_N_MARGIN_THRESHOLD = 0.10;
// Best vs second-best (≥ NEIGHBOR_GAP_MIN apart) clearance for "learned".
const PER_N_AMBIGUITY_LOW = 0.10;
// Stricter clearance required to reach "high" confidence.
const PER_N_AMBIGUITY_HIGH = 0.15;
const NEIGHBOR_GAP_MIN = 3;
const MIN_LEARNED_EFFECTIVE_N = 5;
const MIN_HIGH_EFFECTIVE_N = 12;
// When the candidate is outside the prior's 1σ window, allow high
// confidence only if residuals are very tight AND the data strongly
// disagrees with the prior — a precision-only override (Codex flagged
// it as too easy: parent logs can look artificially tidy via routine
// + rounding). The margin captures evidence strength.
const PER_N_OUTSIDE_PRIOR_OVERRIDE_MARGIN = 0.30;
const TIGHT_RES_FACTOR = 1.25;
const VERY_TIGHT_RES_FACTOR = 0.5;

function scoreCycleCandidate(
  c: number,
  samples: CycleNapSample[],
  prior: SleepCyclePrior,
): { score: number; alignedSqResWeighted: number; weightUsed: number } {
  let dataScore = 0;
  let alignedSqResWeighted = 0;
  let weightUsed = 0;
  const RESIDUAL_CAP = 4 * SIGMA_DATA_MIN;
  for (const s of samples) {
    let bestK = 1;
    let bestResid = Math.abs(s.durationMin - c);
    for (let k = 2; k <= 3; k++) {
      const r = Math.abs(s.durationMin - k * c);
      if (r < bestResid) {
        bestResid = r;
        bestK = k;
      }
    }
    // Cap residuals rather than rejecting them: a sample that doesn't
    // fit any plausible k·c at this candidate should make the candidate
    // look *bad*, not be silently dropped (which would let the prior
    // penalty alone determine the score and pollute ambiguity detection
    // at the range edges).
    const cappedRes = Math.min(bestResid, RESIDUAL_CAP);
    const dataLogP =
      -(cappedRes * cappedRes) / (2 * SIGMA_DATA_MIN * SIGMA_DATA_MIN)
      - MULTIPLICITY_ALPHA * (bestK - 1);
    dataScore += s.weight * dataLogP;
    alignedSqResWeighted += s.weight * bestResid * bestResid;
    weightUsed += s.weight;
  }
  const priorLogP =
    -((c - prior.meanMin) * (c - prior.meanMin))
    / (2 * prior.sdMin * prior.sdMin);
  return { score: dataScore + priorLogP, alignedSqResWeighted, weightUsed };
}

/**
 * Estimate the baby's sleep cycle length with explicit
 * confidence/source/diagnostics. Memoized on the context — safe to call
 * from multiple call sites in the prediction pipeline.
 *
 * Algorithm:
 *  1. Pick age prior. Search range = `prior.rangeMin`.
 *  2. Build weighted self-wake-only sample list from `cycleSleeps`.
 *  3. Score each integer candidate in the search range using a Gaussian
 *     log-likelihood (residual to nearest k·c, k∈{1,2,3}) with a mild
 *     multiplicity discount and a Gaussian prior penalty.
 *  4. Compare best vs prior-mean (margin) and best vs next-best ≥3 min
 *     away (ambiguity). Both must clear per-effective-sample thresholds.
 *  5. Confidence: low when N<5, residuals are wide, or ambiguity is
 *     tight. High when N≥12, residuals are tight, ambiguity is clear,
 *     and the candidate is within ~1σ of the prior mean (or residuals
 *     are *very* tight, overriding the within-sigma rule for clean
 *     edge-of-range babies).
 */
export function estimateSleepCycleDetails(ctx: BabyContext): SleepCycleEstimate {
  if (ctx._sleepCycleEstimate !== undefined) {
    return ctx._sleepCycleEstimate;
  }
  const prior = getSleepCyclePrior(ctx.ageMonths);
  const samples = collectCycleNapSamples(ctx);
  const effectiveN = samples.reduce((sum, s) => sum + s.weight, 0);

  const fallback = (margin: number): SleepCycleEstimate => ({
    minutes: prior.meanMin,
    source: "age-default",
    confidence: "low",
    sampleCount: effectiveN,
    scoreMargin: margin,
    candidateRange: prior.rangeMin,
  });

  if (samples.length === 0 || effectiveN < MIN_LEARNED_EFFECTIVE_N) {
    const out = fallback(0);
    ctx._sleepCycleEstimate = out;
    return out;
  }

  let bestC = prior.meanMin;
  let bestScore = -Infinity;
  let bestAlignedSqRes = 0;
  let bestWeightUsed = 0;
  const allScores: { c: number; score: number }[] = [];
  for (let c = prior.rangeMin[0]; c <= prior.rangeMin[1]; c++) {
    const r = scoreCycleCandidate(c, samples, prior);
    allScores.push({ c, score: r.score });
    if (r.score > bestScore) {
      bestScore = r.score;
      bestC = c;
      bestAlignedSqRes = r.alignedSqResWeighted;
      bestWeightUsed = r.weightUsed;
    }
  }

  const defaultResult = scoreCycleCandidate(prior.meanMin, samples, prior);
  const margin = bestScore - defaultResult.score;
  const perNMargin = margin / effectiveN;

  let secondBestScore = -Infinity;
  for (const candidate of allScores) {
    if (Math.abs(candidate.c - bestC) < NEIGHBOR_GAP_MIN) continue;
    if (candidate.score > secondBestScore) secondBestScore = candidate.score;
  }
  const ambiguity =
    secondBestScore === -Infinity ? margin : bestScore - secondBestScore;
  const perNAmbiguity = ambiguity / effectiveN;
  const alignedStd =
    bestWeightUsed > 0 ? Math.sqrt(bestAlignedSqRes / bestWeightUsed) : Infinity;
  const tightResiduals = alignedStd <= SIGMA_DATA_MIN * TIGHT_RES_FACTOR;
  const veryTightResiduals = alignedStd <= SIGMA_DATA_MIN * VERY_TIGHT_RES_FACTOR;
  const withinPriorSigma = Math.abs(bestC - prior.meanMin) <= prior.sdMin;

  // Margin gate: a non-default best must clear the per-sample threshold.
  const beatsDefault = bestC === Math.round(prior.meanMin) || perNMargin >= PER_N_MARGIN_THRESHOLD;

  let confidence: "low" | "medium" | "high";
  if (
    !tightResiduals
    || perNAmbiguity < PER_N_AMBIGUITY_LOW
    || !beatsDefault
  ) {
    confidence = "low";
  } else if (
    effectiveN >= MIN_HIGH_EFFECTIVE_N
    && perNAmbiguity >= PER_N_AMBIGUITY_HIGH
    && (
      withinPriorSigma
      || (veryTightResiduals && perNMargin >= PER_N_OUTSIDE_PRIOR_OVERRIDE_MARGIN)
    )
  ) {
    // High requires the candidate to sit within the prior's 1σ window
    // OR the data to overwhelmingly disagree with the prior (very-tight
    // residuals AND a strong margin per effective sample). Codex
    // 2026-05-25 review: combined evidence strength is the right bar,
    // not precision alone.
    confidence = "high";
  } else {
    confidence = "medium";
  }

  const source = confidence === "low" ? "age-default" : "learned";
  const minutes = source === "age-default" ? prior.meanMin : bestC;
  const out: SleepCycleEstimate = {
    minutes,
    source,
    confidence,
    sampleCount: effectiveN,
    scoreMargin: margin,
    candidateRange: prior.rangeMin,
  };
  ctx._sleepCycleEstimate = out;
  return out;
}

/**
 * Legacy scalar API. Returns the estimator's recommended minutes value;
 * downstream consumers that just want a number (computeShortNapThreshold,
 * napBudget cap-cycle math) keep working. New code should call
 * `estimateSleepCycleDetails` and surface source/confidence.
 */
export function estimateSleepCycleFromData(ctx: BabyContext): number {
  return estimateSleepCycleDetails(ctx).minutes;
}

function getSleepCycleMinutes(ageMonths: number): number {
  return getSleepCyclePrior(ageMonths).meanMin;
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
    value: getMinuteOfDayInTz(new Date(s.startMs), ctx.tz),
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
    value: getMinuteOfDayInTz(new Date(s.endMs), ctx.tz),
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
  // The morning wake lands on the NEXT local day for an evening bedtime, but
  // on the SAME local day for a post-midnight start (e.g. a 00:30 night wakes
  // that same morning). Keying off `start`'s local hour instead of blindly
  // adding a UTC day avoids predicting the wake ~24h late (deep-review bug #6).
  const startLocalDate = isoToDateInTz(start.toISOString(), ctx.tz);
  const startHour = getHourInTz(start, ctx.tz);
  const wakeDate = startHour >= 12 ? addLocalDay(startLocalDate) : startLocalDate;
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

/** Advance a YYYY-MM-DD local-date string by one calendar day. Anchored at
 *  UTC noon so the increment can't slip across a date boundary on DST days. */
function addLocalDay(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
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
      const minuteOfDay = getMinuteOfDayInTz(new Date(s.startMs), ctx.tz);
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
  /**
   * Which candidate won the day-shape score:
   * - `natural`: forward-walk plan from learned values. Bedtime
   *   incorporates the target soft-anchor (when target_bedtime is set,
   *   `recommendBedtime` shifts the blended bedtime toward target by the
   *   asymmetric daily cap). This means natural's bedtime drifts toward
   *   target each day as history catches up, even when this candidate
   *   wins.
   * - `target-guided`: backward-walk plan from the SAME bedtime as
   *   natural, just walked through naps in the other direction. Wins
   *   when the backward walk produces a lower-cost day shape (tight
   *   days where forward walking lands naps awkwardly).
   */
  source: "natural" | "target-guided";
  /** Whether the selected plan satisfies all hard constraints. False means
   *  the plan is the best available but violates at least one hard constraint
   *  (e.g. final wake window too long). */
  feasible: boolean;
}

/**
 * Daily caps on how far the family's stated `target_bedtime` can shift
 * today's predicted bedtime away from the natural (habitual /
 * pressure-driven) bedtime. Asymmetric and gradual:
 *
 * - LATER (target > natural): keeping baby up longer is the easier
 *   direction — no fighting reluctance, no needing earlier morning wake
 *   to build pressure first. Cap at 30 min/day. AASM clock-shift
 *   guidance lands around 15-20 min for either direction; 30 here
 *   acknowledges this direction is more feasible while still being
 *   conservative.
 *
 * - EARLIER (target < natural): putting baby down sooner is harder —
 *   the baby isn't tired enough, you'd need to back up morning wake
 *   too, and forcing it produces resistance and crying. Cap at 15
 *   min/day so the family can slide toward the new target gradually
 *   without crashing the day.
 *
 * The intended convergence is multi-day: as the family acts on each
 * day's suggestion, history drifts, and tomorrow's natural should
 * anchor closer to target. **In practice (2026-05) the engine doesn't
 * actually converge** — `selectBestPlan`'s scorer keeps the natural
 * plan winning because target-guided plans pay too much wake-window
 * deviation cost. See `docs/followups.md` "Engine: target_bedtime
 * doesn't actually converge" for the design discussion. Until that
 * lands, the cap defines the *upper bound* of the per-day shift
 * whenever the target plan is selected.
 *
 * Originally a single symmetric 15-min cap (made target essentially
 * cosmetic for any meaningful difference). Tried 60 min symmetric
 * briefly (too aggressive — 1h single-day jumps disrupt the baby's
 * rhythm). Asymmetric gradual is the model.
 */
const DAILY_SHIFT_CAP_LATER_MS = 30 * 60_000;
const DAILY_SHIFT_CAP_EARLIER_MS = 15 * 60_000;

/** Convert a "HH:MM" target bedtime to an ISO timestamp for today in the baby's timezone. */
function targetBedtimeToISO(hhmm: string, now: number, tz: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return setHourInTz(new Date(now), h, m, tz).toISOString();
}

/**
 * Build the sleep list for recommendBedtime: actual completed sleeps + synthetic
 * entries for active nap (predicted end) and remaining predicted naps.
 *
 * Two drops on synthetic naps:
 *
 * 1. Naps whose END is past `getLatestNapEndCutoffMin(ctx, now)` — they
 *    wouldn't actually fit before any sensible bedtime, and including them
 *    pushes pressureBedtime past midnight (e.g. a comeback ending 18:23 + 6h
 *    bedtimeWW = 00:23 overflows past the day boundary).
 * 2. Naps whose START is already in the past at `now` — they were planned
 *    earlier in the day but didn't actually happen (parent skipped). Stale
 *    plans shouldn't drag bedtime later as if they had occurred. This was
 *    the May-8 19:22 bug: 46-min cut-short ended 10:07, parent skipped the
 *    comeback, but the engine still anchored bedtime calc on the synthetic
 *    13:00 nap.
 */
export function buildSleepsForBedtime(
  todaySleeps: SleepEntry[],
  activeSleep: SleepLogRow | undefined,
  remainingPredicted: PredictedNap[],
  ctx: BabyContext,
  now: number,
): SleepEntry[] {
  const sleeps = [...todaySleeps];
  if (activeSleep && activeSleep.type === "nap" && !activeSleep.end_time) {
    sleeps.push({
      start_time: activeSleep.start_time,
      end_time: predictNapEndTime(activeSleep.start_time, ctx),
      type: "nap",
    });
  }
  const cutoffMin = getLatestNapEndCutoffMin(ctx, now);
  const nowDateStr = isoToDateInTz(new Date(now).toISOString(), ctx.tz);
  for (const pn of remainingPredicted) {
    const startMs = new Date(pn.startTime).getTime();
    if (startMs <= now) continue; // skipped: planned start is in the past
    // A nap ending on a later local day is necessarily past the evening cutoff.
    // Minute-of-day alone would let an after-midnight end (e.g. 00:30 → min 30)
    // slip under a 17:00+ cutoff and wrongly anchor pressureBedtime.
    if (isoToDateInTz(pn.endTime, ctx.tz) > nowDateStr) continue;
    const endMin = getMinuteOfDayInTz(new Date(pn.endTime), ctx.tz);
    if (endMin > cutoffMin) continue;
    sleeps.push({ start_time: pn.startTime, end_time: pn.endTime, type: "nap" });
  }
  return sleeps;
}

/**
 * Latest local minute-of-day a synthetic nap may END and still anchor
 * pressureBedtime. Derived from the family's evening anchor (habitual
 * bedtime → target_bedtime → 17:00 fallback) minus `MIN_PRE_BEDTIME_WAKE`.
 *
 * A fixed-17:00 cutoff dropped the legitimate 4th nap of 3.5-mo emerging
 * babies (last nap ends ~17:00, bedtime 19:30), leaving pressureBedtime
 * anchored on the 3rd-from-last nap and driving the suggestion 2.5h earlier
 * than habitual.
 */
function getLatestNapEndCutoffMin(ctx: BabyContext, now: number): number {
  const minPreBedtime = RESCUE_NAP.MIN_PRE_BEDTIME_WAKE;
  const habitualMs = feat(ctx, "habitualBedtime")
    ? getHabitualBedtimePrediction(new Date(now), ctx) : null;
  if (habitualMs !== null) {
    return getMinuteOfDayInTz(new Date(habitualMs), ctx.tz) - minPreBedtime;
  }
  if (ctx.targetBedtime) {
    const targetMs = new Date(targetBedtimeToISO(ctx.targetBedtime, now, ctx.tz)).getTime();
    return getMinuteOfDayInTz(new Date(targetMs), ctx.tz) - minPreBedtime;
  }
  return 17 * 60;
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
    const snapped = snapToCycleBoundary(dur, cycleMin, 10, 180);
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
  options: { dayStart?: boolean } = {},
): SelectedPlan {
  const wakeUpMs = new Date(wakeUpTime).getTime();

  // Natural plan: forward walk + learned bedtime. `dayStart` only flows
  // through here so the late-wake re-anchor inside `predictDayNaps` can
  // distinguish "morning plan from today's first wake" from in-day
  // re-plans (cut-short, completed nap), where index 0 of the resulting
  // naps array means "next remaining nap" rather than "first nap of day".
  const naturalNaps = predictDayNaps(wakeUpTime, ctx, options);
  const sleepsForBedtime = buildSleepsForBedtime(todaySleeps, activeSleep, naturalNaps, ctx, now);
  const naturalBedtime = recommendBedtime(sleepsForBedtime, ctx, now);
  const naturalPlan: PlanCandidate = { naps: naturalNaps, bedtime: naturalBedtime };

  const naturalBedtimeMs = new Date(naturalBedtime).getTime();
  const naturalScore = scorePlan(naturalPlan, ctx, wakeUpMs, naturalBedtimeMs, naturalNaps.length);

  if (!ctx.targetBedtime) {
    return { ...naturalPlan, source: "natural", feasible: naturalScore.feasible };
  }

  // Natural's bedtime ALREADY incorporates the target soft-anchor (added
  // in `recommendBedtime` via the asymmetric daily cap). So the cap math
  // doesn't repeat here — we just check whether the backward-walk plan
  // beats the forward-walk plan on day-shape feasibility, both targeting
  // the same naturalBedtime.

  // Target-guided plan: backward walk from naturalBedtime. Sometimes
  // produces a cleaner nap shape than the forward walk for tight days.
  const targetNaps = planBackwardFromBedtime(wakeUpTime, naturalBedtime, ctx);
  const targetPlan: PlanCandidate = { naps: targetNaps, bedtime: naturalBedtime };

  const targetScore = scorePlan(targetPlan, ctx, wakeUpMs, naturalBedtimeMs, naturalNaps.length);

  if (targetScore.feasible && targetScore.cost < naturalScore.cost) {
    return { ...targetPlan, source: "target-guided", feasible: true };
  }
  // When both are infeasible, return natural with feasible=false so callers can signal it.
  return { ...naturalPlan, source: "natural", feasible: naturalScore.feasible };
}
