/**
 * Trend computation shared between `nap-budget.ts` (the cap recommender)
 * and `schedule.ts` (the cut-short censor's "near trend" carve-out).
 *
 * One definition of trend lives here so both modules agree on what
 * "today's expected daily total" means. Splitting the math gives two
 * sources of truth that can drift — `computeNapBudget` could fire a cap
 * because banked > trend, while `censorCutShortNaps` could refuse to keep
 * the resulting woken nap because *its* trend math disagreed.
 *
 * Sleep-science rationale and citations live in
 * docs/sleep-science-research.md §12.
 */

import type { SleepEntry, BabyContext } from "$lib/types.js";
import { NAP_BUDGET, SLEEP_NEEDS, findByAge } from "./constants.js";
import { isoToDateInTz } from "$lib/tz.js";
import { getWeekStats } from "./stats.js";

export interface BlendedTrend {
  blendedTrendMin: number;
  sourceLabel: string;
  mean7: number;
  mean30: number;
}

/**
 * Blended 7d / 30d daily-total trend, age-norm clamped. Returns null when
 * the data is too sparse or noisy to trust (the engine then defers to
 * "no advice" rather than push a confident-but-wrong number).
 *
 * Off-days are dropped from the historical buckets, and so is the
 * calendar-previous date of each off-day — `getWeekStats` anchors a night
 * by `start_time`, so the bad overnight that ended on the off-day morning
 * lives in the prior-date bucket and would otherwise leak through.
 */
export function computeBlendedTrend(
  trendSleeps: SleepEntry[],
  tz: string,
  now: number,
  ageMonths: number,
  offDays?: Set<string>,
): BlendedTrend | null {
  const todayKey = isoToDateInTz(new Date(now).toISOString(), tz);
  const skip = new Set<string>(offDays ?? []);
  for (const k of offDays ?? []) {
    skip.add(prevDateKey(k));
  }

  const cutoff30dMs = now - 30 * 86400_000;
  const cutoff7dMs = now - 7 * 86400_000;
  const within30 = trendSleeps.filter((s) => new Date(s.start_time).getTime() >= cutoff30dMs);
  const within7 = trendSleeps.filter((s) => new Date(s.start_time).getTime() >= cutoff7dMs);

  const stats30 = getWeekStats(within30, tz);
  const stats7 = getWeekStats(within7, tz);

  // Drop today (incomplete) and any day that lacks a night entry (nap-only
  // days bias the trend low; nights orphaned from same-day naps bias high).
  const completedDays30 = stats30.days.filter(
    (d) => d.date !== todayKey && d.stats.totalNightMinutes > 0 && !skip.has(d.date),
  );
  if (completedDays30.length < NAP_BUDGET.MIN_TREND_DAYS) return null;
  const completedDays7 = stats7.days.filter(
    (d) => d.date !== todayKey && d.stats.totalNightMinutes > 0 && !skip.has(d.date),
  );

  const totals30 = completedDays30.map((d) => d.stats.totalNapMinutes + d.stats.totalNightMinutes);
  const totals7 = completedDays7.map((d) => d.stats.totalNapMinutes + d.stats.totalNightMinutes);

  const mean30 = mean(totals30);
  const mean7 = totals7.length > 0 ? mean(totals7) : mean30;

  // Stability gate — recent stdev/mean too high → bad week / sick day /
  // growth spurt is poisoning the target. Defer to "no advice".
  //
  // When totals7 is too sparse (<3 samples), we widen the sample to totals30,
  // and the mean used to center the stdev must match the sample — otherwise a
  // 1-2-day window centered on a 30-day distribution inflates the variance
  // and the gate fires for the wrong reason. Codex pair-review 2026-05-20.
  const stdevSample = totals7.length >= 3 ? totals7 : totals30;
  const stdevMean = totals7.length >= 3 ? mean7 : mean30;
  const sd7 = stdev(stdevSample, stdevMean);
  if (sd7 / stdevMean > NAP_BUDGET.MAX_STDEV_FRACTION) return null;

  // Age-norm clamp.
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
 * The blended 7d / 30d trend total (minutes), age-norm clamped. Exposed
 * so UI surfaces (the stats comparison table's Trendmål row) and consumers
 * like the cut-short censor can compare a day's total against the *actual*
 * daily target — not the conservative age-band floor.
 *
 * Returns null when the data is too sparse or noisy to trust.
 */
export function computeTrendTotalMin(
  trendSleeps: SleepEntry[],
  ctx: BabyContext,
  now: number,
): number | null {
  const trend = computeBlendedTrend(trendSleeps, ctx.tz, now, ctx.ageMonths, ctx.offDays);
  return trend ? Math.round(trend.blendedTrendMin) : null;
}

/**
 * Calendar-previous YYYY-MM-DD given a YYYY-MM-DD key. Used to expand the
 * off-day set so the previous overnight (whose start_time bucket sits on
 * the day before the off-day morning) is also dropped from trend math.
 */
function prevDateKey(key: string): string {
  const ms = new Date(`${key}T00:00:00Z`).getTime() - 86400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[], mu?: number): number {
  if (xs.length < 2) return 0;
  const m = mu ?? mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
