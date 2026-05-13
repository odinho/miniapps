/**
 * Trend-anchored nap-budget cap — recommend a wake-by for the day's last
 * nap when today's accumulated sleep is on track to exceed the parent's
 * blended 7d/30d daily-total trend.
 *
 * The goal is to smooth the long-nap → next-day-skip pingpong observed in
 * real data (10-day window: 14.8h ↔ 12.4h ↔ 14.8h, etc.). Evidence base
 * and design rationale: docs/sleep-science-research.md §12. Constants:
 * `NAP_BUDGET` and `NAP_FLOOR_BY_AGE` in constants.ts.
 *
 * What this is NOT:
 *  - Not a "hit the trend exactly" optimizer. The cap floors at the
 *    age-appropriate minimum useful nap, and respects bedtime distance.
 *  - Not a notification — the scheduler reads `napBudget.wakeBy` and
 *    decides whether to schedule a push based on `urgency` + opt-out.
 *  - Not applied to night sleep or non-last naps in v1.
 */

import type { SleepEntry, BabyContext } from "$lib/types.js";
import type { NapBudget } from "$lib/stores/app.svelte.js";
import {
  NAP_BUDGET,
  NAP_FLOOR_BY_AGE,
  RESCUE_NAP,
  SLEEP_NEEDS,
  findByAge,
} from "./constants.js";
import { isoToDateInTz } from "$lib/tz.js";
import { estimateSleepCycleFromData } from "./schedule.js";
import { getWeekStats } from "./stats.js";

interface ComputeNapBudgetInput {
  /** Active nap. Must be type === 'nap'. */
  activeNap: { start_time: string };
  /** Today's completed sleeps (used to compute bankedMin together with active elapsed). */
  todaySleeps: SleepEntry[];
  /** Long-horizon sleeps for trend (30-day lookback ideal; falls back to whatever the caller has). */
  trendSleeps: SleepEntry[];
  /** Predicted bedtime today (ISO). Required: rescue cap honors pre-bedtime wake. */
  bedtime: string;
  /** True only when this active nap is the day's last expected nap (engine knows the schedule). */
  isLastNapOfDay: boolean;
  /** Per-baby opt-out: false suppresses the entire feature. */
  optedIn: boolean;
  /** Now (epoch ms). */
  now: number;
  /** Baby context — age, tz. */
  ctx: BabyContext;
}

export function computeNapBudget(input: ComputeNapBudgetInput): NapBudget | null {
  const { activeNap, todaySleeps, trendSleeps, bedtime, isLastNapOfDay, optedIn, now, ctx } = input;

  // ── Gate 1: per-baby opt-out and v1 scope (last nap only). ──────────
  if (!optedIn || !isLastNapOfDay) return null;

  // ── Gate 2: nap just started — don't propose for a baby that just
  //    fell asleep. Risk of misfire is high in the first ~20 min.
  const napStartMs = new Date(activeNap.start_time).getTime();
  const elapsedMin = (now - napStartMs) / 60_000;
  if (elapsedMin < NAP_BUDGET.MIN_ELAPSED_BEFORE_CAP_MIN) return null;

  // ── Gate 3: trend stability. Need ≥7 days of complete data, and
  //    recent variance must be low enough that the trend is signal.
  const trend = computeBlendedTrend(trendSleeps, ctx.tz, now, ctx.ageMonths);
  if (!trend) return null;

  // ── Gate 4: today's projection. Uses a rolling 24h window so last
  //    night's sleep counts toward today's budget — that matches the
  //    parent's actual reasoning ("she slept 12.44 h last night + 1.5 h
  //    nap = 14 h vs 13 h trend"). The trend target comes from
  //    start-anchored daily averages, which in steady-state equal the
  //    rolling-24h mean, just shifted.
  const bankedMin = computeBanked24h(trendSleeps, todaySleeps, activeNap, now);
  const projectedIfRunsFull = bankedMin + estimateRemainingNapMin(activeNap, now, ctx);
  if (projectedIfRunsFull <= trend.blendedTrendMin) {
    return null;
  }

  // ── Mode detection. "Established" = the 7d trend has dropped at least
  //    ESTABLISHED_TRACK_DELTA_MIN below the 30d trend, which is what you
  //    get when the parent has been respecting cap advice for ~a week.
  //    User wording: "once the parent has done a week or more of such
  //    early wakeups and we still have too many minutes during the day,
  //    this is the time where we don't give a full cycle".
  const establishedMode = trend.mean30 - trend.mean7 >= NAP_BUDGET.ESTABLISHED_TRACK_DELTA_MIN;

  const remainingBudgetMin = Math.max(0, trend.blendedTrendMin - bankedMin);
  const cycleMin = estimateSleepCycleFromData(ctx);
  const floorMin = findByAge(NAP_FLOOR_BY_AGE, ctx.ageMonths).floorMin;

  // ── Cap selection. Two modes:
  //
  //  Mode A — first contact (default): cap at end of last *full* cycle
  //    that fits under the trend budget. When even one cycle exceeds the
  //    budget, still cap at one cycle anyway. Gentle, lands on the
  //    light-phase boundary (Trotti 2017: easy wake). See sleep-science
  //    §12.
  //
  //  Mode B — established: trust the trend math. cap = remainingBudget,
  //    minus a lead-time buffer so the parent has a minute to get to the
  //    baby before the next cycle starts. May land mid-cycle; the parent
  //    has practiced waking and accepts the trade.
  let cappedDurationMin: number;
  let cyclesCompleted: number;
  if (establishedMode) {
    cyclesCompleted = 0;
    cappedDurationMin = remainingBudgetMin - NAP_BUDGET.EARLY_WAKE_LEAD_MIN;
  } else {
    const cyclesUnderBudget = Math.floor(remainingBudgetMin / cycleMin);
    if (cyclesUnderBudget >= 1) {
      cyclesCompleted = cyclesUnderBudget;
      cappedDurationMin = cyclesCompleted * cycleMin;
    } else {
      cyclesCompleted = 1;
      cappedDurationMin = cycleMin;
    }
  }
  // Apply age-band floor so we never recommend below the literature-backed
  // minimum useful nap (Brooks & Lack 2006, Mednick 2003).
  cappedDurationMin = Math.max(cappedDurationMin, floorMin);

  // ── Bedtime guard. The cap must leave room for the pre-bedtime wake
  //    window (90 min). If the cycle-aligned cap pushes past that, tighten
  //    so the wake-by sits at bedtime - 90 min. If even the floor would
  //    overrun bedtime, suppress entirely.
  const bedtimeMs = new Date(bedtime).getTime();
  const latestWakeMs = bedtimeMs - RESCUE_NAP.MIN_PRE_BEDTIME_WAKE * 60_000;
  const napEndIfCappedMs = napStartMs + cappedDurationMin * 60_000;
  if (napEndIfCappedMs > latestWakeMs) {
    const tightenedMin = (latestWakeMs - napStartMs) / 60_000;
    if (tightenedMin < floorMin) {
      // No room for a useful nap before bedtime — postSkipPlan / overtime
      // can handle it.
      return null;
    }
    cappedDurationMin = tightenedMin;
    // No longer cycle-aligned — clear cyclesCompleted bookkeeping.
    cyclesCompleted = 0;
  }

  // ── Urgency. `firm` (push-eligible) when the *uncapped* overshoot is
  //    > TOLERANCE_MIN beyond trend. The cap may bring today close to
  //    target, but the parent needs to act on it; firm reflects the
  //    severity of the would-be miss. Advisory otherwise.
  const overshootIfUncapped = projectedIfRunsFull - trend.blendedTrendMin;
  const urgency: NapBudget["urgency"] =
    overshootIfUncapped > NAP_BUDGET.TOLERANCE_MIN ? "firm" : "advisory";

  const wakeByMs = napStartMs + cappedDurationMin * 60_000;
  return {
    wakeBy: new Date(wakeByMs).toISOString(),
    recommendedDurationMin: Math.round(cappedDurationMin),
    reason: "over_trend",
    mode: establishedMode ? "established" : "first-contact",
    urgency,
    context: {
      blendedTrendMin: Math.round(trend.blendedTrendMin),
      bankedMin: Math.round(bankedMin),
      toleranceMin: NAP_BUDGET.TOLERANCE_MIN,
      sourceLabel: trend.sourceLabel,
    },
    cycleNudge: cyclesCompleted > 0
      ? {
          boundaryAtMin: Math.round(cappedDurationMin),
          // For backwards-compat with the existing field; the conceptual
          // "nudged from" is the raw cap before cycle alignment.
          nudgedFromMin: Math.round(remainingBudgetMin),
        }
      : null,
  };
}

// ── Internal helpers ────────────────────────────────────────────────

/**
 * Compute the blended trend target (7d / 30d) for daily total sleep.
 * Reuses `getWeekStats` so the numbers match what the parent reads on
 * the stats page exactly (start-anchored per-day totals). Returns null
 * when data is too sparse or too noisy to trust.
 */
function computeBlendedTrend(
  trendSleeps: SleepEntry[],
  tz: string,
  now: number,
  ageMonths: number,
): { blendedTrendMin: number; sourceLabel: string; mean7: number; mean30: number } | null {
  const todayKey = isoToDateInTz(new Date(now).toISOString(), tz);

  // Slice by start_time within the 30d window. getWeekStats groups by
  // start-anchored local date — same convention as the stats page.
  const cutoff30dMs = now - 30 * 86400_000;
  const cutoff7dMs = now - 7 * 86400_000;
  const within30 = trendSleeps.filter((s) => new Date(s.start_time).getTime() >= cutoff30dMs);
  const within7 = trendSleeps.filter((s) => new Date(s.start_time).getTime() >= cutoff7dMs);

  const stats30 = getWeekStats(within30, tz);
  const stats7 = getWeekStats(within7, tz);

  // Drop today (incomplete) and gather per-day totals (nap + night).
  const completedDays30 = stats30.days.filter((d) => d.date !== todayKey);
  if (completedDays30.length < NAP_BUDGET.MIN_TREND_DAYS) return null;
  const completedDays7 = stats7.days.filter((d) => d.date !== todayKey);

  const totals30 = completedDays30.map((d) => d.stats.totalNapMinutes + d.stats.totalNightMinutes);
  const totals7 = completedDays7.map((d) => d.stats.totalNapMinutes + d.stats.totalNightMinutes);

  const mean30 = mean(totals30);
  const mean7 = totals7.length > 0 ? mean(totals7) : mean30;

  // Stability gate — recent stdev/mean too high means a bad week, sick
  // day, or growth spurt is poisoning the target. Defer to "no advice"
  // rather than push a confident-but-wrong cap.
  const sd7 = stdev(totals7.length >= 3 ? totals7 : totals30, mean7);
  if (sd7 / mean7 > NAP_BUDGET.MAX_STDEV_FRACTION) return null;

  // Age-norm clamp. Never trim below or push above the published age
  // range from SLEEP_NEEDS, so noisy data can't drag the target outside
  // what's healthy on principle.
  const ageBand = findByAge(SLEEP_NEEDS, ageMonths);
  const minNormMin = ageBand.range[0] * 60;
  const maxNormMin = ageBand.range[1] * 60;

  const rawBlend = NAP_BUDGET.BLEND_WEIGHT_7D * mean7 + NAP_BUDGET.BLEND_WEIGHT_30D * mean30;
  const blendedTrendMin = Math.max(minNormMin, Math.min(maxNormMin, rawBlend));

  const sourceLabel =
    totals30.length >= 14 ? "7d/30d-blanding" : "7d-snitt (lite data)";
  return { blendedTrendMin, sourceLabel, mean7, mean30 };
}

/**
 * Sum of sleep in the rolling 24 h window ending at `now`. Includes
 * yesterday's night (which the parent counts toward today's budget),
 * any completed naps today, and the active nap's elapsed time.
 *
 * We pass `trendSleeps` here rather than `todaySleeps` so a night that
 * started yesterday gets included — it would otherwise drop out of a
 * "today only" filter.
 */
function computeBanked24h(
  trendSleeps: SleepEntry[],
  todaySleeps: SleepEntry[],
  activeNap: { start_time: string },
  now: number,
): number {
  const cutoffMs = now - 24 * 3600_000;
  // Deduplicate by start_time — todaySleeps overlaps with the tail of
  // trendSleeps, and we don't want to double-count.
  const seen = new Set<string>();
  let banked = 0;
  const accumulate = (s: SleepEntry) => {
    if (!s.end_time) return;
    if (seen.has(s.start_time)) return;
    seen.add(s.start_time);
    const startMs = new Date(s.start_time).getTime();
    const endMs = new Date(s.end_time).getTime();
    if (endMs <= cutoffMs) return;
    if (startMs >= now) return;
    const effStart = Math.max(startMs, cutoffMs);
    const effEnd = Math.min(endMs, now);
    banked += (effEnd - effStart) / 60_000;
  };
  for (const s of trendSleeps) accumulate(s);
  for (const s of todaySleeps) accumulate(s);
  // Active nap elapsed (clipped to 24h window).
  const napStartMs = new Date(activeNap.start_time).getTime();
  const napEffectiveStart = Math.max(napStartMs, cutoffMs);
  if (napEffectiveStart < now) {
    banked += (now - napEffectiveStart) / 60_000;
  }
  return banked;
}

/**
 * Estimate how much *more* the active nap would add if it ran a typical
 * full length for this baby. Used to project today's total if uncapped.
 * We assume the baby would sleep up to the learned nap duration.
 */
function estimateRemainingNapMin(
  activeNap: { start_time: string },
  now: number,
  ctx: BabyContext,
): number {
  const napStartMs = new Date(activeNap.start_time).getTime();
  const elapsedMin = (now - napStartMs) / 60_000;
  // We don't import getLearnedNapDuration here to avoid a circular dependency
  // risk; an age-band-typical upper estimate is fine for this projection.
  // 90 min for under-14mo, 75 min beyond. Conservative so we don't
  // underproject and miss real overshoots.
  const typicalFullNapMin = ctx.ageMonths < 14 ? 90 : 75;
  return Math.max(0, typicalFullNapMin - elapsedMin);
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[], mu?: number): number {
  if (xs.length < 2) return 0;
  const m = mu ?? mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
