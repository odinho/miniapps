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
 * Backward-compat wrapper over {@link computeTrendTargets}: returns the
 * observed-recent number so existing consumers keep working while the
 * intervention target's split lands incrementally. New code should
 * prefer `computeTrendTargets()` and pick the right field for its
 * question (observed = stats / rescue checks; intervention = cap math).
 *
 * Returns null when the data is too sparse or noisy to trust.
 */
export function computeTrendTotalMin(
  trendSleeps: SleepEntry[],
  ctx: BabyContext,
  now: number,
): number | null {
  return computeTrendTargets(trendSleeps, ctx, now)?.observedRecentMin ?? null;
}

// ─── Trend-target split (Codex design 2026-05-20) ───────────────────────────
//
// The blended 7d/30d average above is fine as a *stat* but wrong as a *cap
// target*: feeding capped-day totals back into tomorrow's average is the
// ratchet the user reported (13.0 → 12.9 → 12.8 over a few days as the
// parent obeyed napBudget). The split below classifies each historical day,
// surfaces both the factual observed mean and a stable intervention target,
// and keeps `computeTrendTotalMin` working as the observed-mean shim.
//
// Stage 1 (this commit): API + classification only. interventionTargetMin
// returns the same number as observedRecentMin so behavior is unchanged.
// Stage 2 will add persisted held baseline + drift; Stage 3 rewires
// nap-budget to consume the intervention target.

export type TrendTargetSource = "observed-initial" | "natural-days" | "manual-reset";
export type TrendTargetConfidence = "low" | "medium" | "high";

/**
 * Persisted state for the held intervention target. Carried across
 * evaluations by the server (`trend_target_state` table) so the cap
 * target doesn't ratchet downward as the parent obeys.
 *
 * The shape is deliberately minimal — no observed totals or derived
 * stats live here, only what the engine needs to decide the next
 * intervention target. Stats remain in `trendSleeps`.
 */
export interface TrendTargetState {
  /** Current held intervention target (minutes). */
  targetMin: number;
  /** Pre-intervention baseline target. Floors how far the target can
   *  drift down from natural-day evidence; only raised explicitly. */
  baselineMin: number;
  source: TrendTargetSource;
  confidence: TrendTargetConfidence;
  /** Consecutive evaluations supporting downward drift; the rule requires
   *  ≥ 2 supporting evaluations before stepping the target down. Resets
   *  to 0 whenever upward/flat support arrives. */
  naturalSupportStreak: number;
  updatedAt: string;
}

export type TrendDayKind =
  | "natural"
  | "policy-affected"
  | "off-day"
  | "incomplete"
  | "noisy";

export interface TrendDay {
  date: string;
  totalMin: number;
  napMin: number;
  nightMin: number;
  napCount: number;
  /** Last completed nap on the day, in start-time order. null if none. */
  lastNap: SleepEntry | null;
  kind: TrendDayKind;
  /** Short reason tag so tests + debug can pin classifications. */
  reason: string;
}

export interface TrendTargetsDiagnostics {
  completedDays30: number;
  completedDays7: number;
  naturalDays30: number;
  policyAffectedDays30: number;
  offDaysDropped: number;
  /** Effective floor (max of age floor and any other lower bounds) in min. */
  floorMin: number;
  /** Per-day classification for the last 30 days (chronological). */
  classifiedDays: TrendDay[];
}

export interface TrendTargets {
  /** Factual observed 7d/30d blend, age-clamped. UI stats. */
  observedRecentMin: number;
  /** Stable cap target for napBudget. Equal to observed when no prior
   *  state exists; otherwise carried from the persisted held baseline. */
  interventionTargetMin: number;
  /** How much to trust the intervention target. */
  interventionConfidence: TrendTargetConfidence;
  /** Existing label, e.g. "7d/30d-blanding". */
  observedSourceLabel: string;
  /** Where the intervention target came from. */
  interventionSourceLabel: string;
  mean7: number;
  mean30: number;
  diagnostics: TrendTargetsDiagnostics;
  /** Next state to persist. Caller (server) writes when this differs
   *  from the prior. Carrying it on the output keeps the engine pure —
   *  no DB calls, just "given prior, here's next state + targets". */
  state: TrendTargetState;
}

/**
 * Classify a single historical day for trend-target purposes. The cap
 * loop's worst failure mode is treating a parent-woken last-nap-near-target
 * day as evidence that the baby naturally needs less sleep — so day kind
 * keys off the LAST nap's wake reason and the day's total relative to the
 * current reference (held target if we have one, otherwise observed).
 *
 * Inference-only today; once explicit cap-event persistence lands the
 * `policy-affected` heuristic can be replaced with a precise check.
 */
export function classifyTrendDay(
  date: string,
  daySleeps: SleepEntry[],
  reference: number,
  toleranceMin: number,
  offDays: Set<string> | undefined,
): TrendDay {
  const completed = daySleeps.filter((s) => s.end_time);
  const naps = completed
    .filter((s) => s.type === "nap")
    .toSorted((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
  const nights = completed.filter((s) => s.type === "night");
  const napMin = naps.reduce((sum, s) => sum + durationOf(s), 0);
  const nightMin = nights.reduce((sum, s) => sum + durationOf(s), 0);
  const totalMin = napMin + nightMin;
  const lastNap = naps.at(-1) ?? null;

  const base = {
    date,
    totalMin: Math.round(totalMin),
    napMin: Math.round(napMin),
    nightMin: Math.round(nightMin),
    napCount: naps.length,
    lastNap,
  };

  if (offDays?.has(date)) return { ...base, kind: "off-day", reason: "explicit off-day" };
  if (nights.length === 0) return { ...base, kind: "incomplete", reason: "no night bucket" };

  const nearTarget = totalMin >= reference - toleranceMin;
  const lastNapDurMin = lastNap ? durationOf(lastNap) : 0;
  const lastNapParentEnded = lastNap?.woke_by === "woken";
  const lastNapSubstantial = lastNapDurMin >= 30;

  if (lastNapParentEnded && lastNapSubstantial && nearTarget) {
    return {
      ...base,
      kind: "policy-affected",
      reason: "parent-woken last nap near target",
    };
  }
  if (lastNap?.woke_by === "self") {
    return { ...base, kind: "natural", reason: "last nap self-woke" };
  }
  // Untagged complete days carry weaker evidence — Codex's memo notes
  // they're useful for observed trend / upward drift but should NOT be
  // sole support for moving the intervention target downward. We still
  // tag them "natural" here; stage 3's drift logic will gate strongly on
  // explicit self-wake support before lowering the held baseline.
  return { ...base, kind: "natural", reason: "untagged complete" };
}

function durationOf(s: SleepEntry): number {
  if (!s.end_time) return 0;
  return (new Date(s.end_time).getTime() - new Date(s.start_time).getTime()) / 60_000;
}

/**
 * Compute both observed-recent and intervention targets in one pass.
 *
 * Stage 2 contract:
 *   - If `prior` exists, the intervention target carries the held value
 *     forward (no drift yet — that's stage 3). Confidence rises to
 *     `medium` once a baseline is being held.
 *   - Without `prior`, the target initializes from `observedRecentMin`.
 *   - The returned `state` is what the caller (server) should persist
 *     when it differs from the prior.
 *
 * Drift logic (per Codex design at local/codex-trend-split-design.md)
 * lands in stage 3. Until then, the held target is stable across calls
 * but doesn't yet respond to natural-day evidence.
 *
 * Returns null when the data is too sparse or noisy to trust (matches
 * `computeBlendedTrend`'s gate — null = "no advice").
 */
export function computeTrendTargets(
  trendSleeps: SleepEntry[],
  ctx: BabyContext,
  now: number,
  prior?: TrendTargetState | null,
): TrendTargets | null {
  const observed = computeBlendedTrend(trendSleeps, ctx.tz, now, ctx.ageMonths, ctx.offDays);
  if (!observed) return null;

  // Classify per-day for diagnostics (and stage 3 drift). Use the observed
  // blend as the reference for the policy-affected heuristic — once a held
  // baseline exists, callers will pass that instead via stage 3 plumbing.
  const todayKey = isoToDateInTz(new Date(now).toISOString(), ctx.tz);
  const cutoff30dMs = now - 30 * 86400_000;
  const within30 = trendSleeps.filter((s) => new Date(s.start_time).getTime() >= cutoff30dMs);
  const stats30 = getWeekStats(within30, ctx.tz);
  const classifiedDays = stats30.days
    .filter((d) => d.date !== todayKey)
    .map((d) =>
      classifyTrendDay(
        d.date,
        d.stats.sleeps,
        observed.blendedTrendMin,
        NAP_BUDGET.TOLERANCE_MIN,
        ctx.offDays,
      ),
    );

  const naturalDays30 = classifiedDays.filter((d) => d.kind === "natural").length;
  const policyAffectedDays30 = classifiedDays.filter((d) => d.kind === "policy-affected").length;
  const offDaysDropped = classifiedDays.filter((d) => d.kind === "off-day").length;
  const completedDays30 = classifiedDays.filter(
    (d) => d.kind === "natural" || d.kind === "policy-affected",
  ).length;
  const completedDays7 = classifiedDays.filter(
    (d) =>
      (d.kind === "natural" || d.kind === "policy-affected") &&
      new Date(`${d.date}T00:00:00Z`).getTime() >= now - 7 * 86400_000,
  ).length;
  const ageBand = findByAge(SLEEP_NEEDS, ctx.ageMonths);
  const floorMin = ageBand.range[0] * 60;

  const observedRecentMin = Math.round(observed.blendedTrendMin);
  const updatedAt = new Date(now).toISOString();

  // Held-target shape. Stage 2: carry the prior forward unchanged; stage
  // 3 will add the natural-day drift logic.
  let interventionTargetMin: number;
  let interventionConfidence: TrendTargetConfidence;
  let interventionSourceLabel: string;
  let nextState: TrendTargetState;
  if (prior) {
    interventionTargetMin = Math.round(prior.targetMin);
    interventionConfidence = prior.confidence;
    interventionSourceLabel = `held baseline (${prior.source})`;
    nextState = { ...prior, updatedAt };
  } else {
    // Initialize from observed. Bias the baseline UP toward natural-day
    // mean if natural days dominate the window — capped/low days
    // shouldn't seed the held baseline low. (Stage 3 will tighten this.)
    const naturalTotals = classifiedDays
      .filter((d) => d.kind === "natural")
      .map((d) => d.totalMin);
    const naturalMean = naturalTotals.length >= 3
      ? naturalTotals.reduce((a, b) => a + b, 0) / naturalTotals.length
      : null;
    const seed = naturalMean !== null
      ? Math.max(observedRecentMin, Math.round(naturalMean))
      : observedRecentMin;
    interventionTargetMin = seed;
    interventionConfidence = "low";
    interventionSourceLabel = "observed (initial)";
    nextState = {
      targetMin: seed,
      baselineMin: seed,
      source: "observed-initial",
      confidence: "low",
      naturalSupportStreak: 0,
      updatedAt,
    };
  }

  return {
    observedRecentMin,
    interventionTargetMin,
    interventionConfidence,
    observedSourceLabel: observed.sourceLabel,
    interventionSourceLabel,
    mean7: observed.mean7,
    mean30: observed.mean30,
    diagnostics: {
      completedDays30,
      completedDays7,
      naturalDays30,
      policyAffectedDays30,
      offDaysDropped,
      floorMin,
      classifiedDays,
    },
    state: nextState,
  };
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
