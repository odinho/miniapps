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
import { getWeekStats, netDurationMin } from "./stats.js";

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
  /**
   * Fingerprint of the evidence (classified completed days + observed
   * recent mean) used by the last drift evaluation. The drift function
   * no-ops when this matches the current evidence — repeat state-fetches
   * within the same evidence frame don't ratchet target/streak even if a
   * backfill keeps the UTC date the same. `undefined` on legacy rows; the
   * next call freely evaluates and persists the marker.
   * Codex 2026-05-25 review.
   */
  evidenceFingerprint?: string;
}

/**
 * Per-day classification for the trend-target split.
 *
 * Two flavours of "natural" — `natural-self-woke` is the strong signal
 * (last nap ended `woke_by === "self"`) that the drift logic trusts for
 * *downward* moves; `natural-untagged` is a complete non-off day with
 * no last-nap wake reason recorded, which is still useful for the
 * observed mean and for upward drift but isn't strong enough on its
 * own to lower the held target. Codex 2026-05-20 review of stage 3
 * flagged that lumping these together let untagged days yank the
 * baseline down without explicit self-wake evidence.
 */
export type TrendDayKind =
  | "natural-self-woke"
  | "natural-untagged"
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
  const napMin = naps.reduce((sum, s) => sum + netDurationMin(s), 0);
  const nightMin = nights.reduce((sum, s) => sum + netDurationMin(s), 0);
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

  // Off-days propagate to the calendar-previous date too: `getWeekStats`
  // buckets nights by `start_time`, so an off-day's overnight (which
  // ended on the off-day morning) lives in yesterday's bucket and must
  // be skipped to keep classification consistent with the off-day
  // expansion in `computeBlendedTrend`. Codex stage-3 review §"off-day
  // filtering differs between observed trend and drift evidence".
  if (offDays?.has(date) || (offDays && isPrevDateOfOffDay(date, offDays))) {
    return { ...base, kind: "off-day", reason: "off-day (expanded)" };
  }
  if (nights.length === 0) return { ...base, kind: "incomplete", reason: "no night bucket" };

  const nearTarget = totalMin >= reference - toleranceMin;
  const lastNapDurMin = lastNap ? netDurationMin(lastNap) : 0;
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
    return { ...base, kind: "natural-self-woke", reason: "last nap self-woke" };
  }
  // Untagged complete day — useful for the observed mean and for upward
  // drift, but the downward-drift gate ignores these unless they're
  // also self-woke. Codex 2026-05-20 §"Downward drift not gated to
  // explicit natural support".
  return { ...base, kind: "natural-untagged", reason: "untagged complete" };
}

function isNaturalKind(d: TrendDay): boolean {
  return d.kind === "natural-self-woke" || d.kind === "natural-untagged";
}

function isCompletedKind(d: TrendDay): boolean {
  return isNaturalKind(d) || d.kind === "policy-affected";
}

/** True when `date` immediately precedes any off-day in the set — see
 *  the off-day expansion rationale in `computeBlendedTrend`. */
function isPrevDateOfOffDay(date: string, offDays: Set<string>): boolean {
  const nextMs = new Date(`${date}T00:00:00Z`).getTime() + 86400_000;
  const next = new Date(nextMs).toISOString().slice(0, 10);
  return offDays.has(next);
}

interface DriftInputs {
  prior: TrendTargetState;
  observedRecentMin: number;
  classifiedDays: TrendDay[];
  ageFloorMin: number;
  now: number;
}

/**
 * Anti-ratchet drift logic for the held intervention target.
 *
 * Symmetry deliberately broken: upward moves are fast and don't require a
 * streak (under-capping a baby that actually wants more sleep is more
 * urgent than over-capping one that wants less); downward moves require
 * sustained natural-day evidence over at least 2 consecutive evaluations
 * with enough natural samples. Codex 2026-05-20 (see
 * `local/codex-trend-split-design.md`) frames this as a closed-loop
 * control problem: the cap loop forces today's total to (target − lead),
 * so feeding that back into a symmetric mean-tracker would let any tiny
 * obedient nudge ratchet the target down forever.
 *
 * Constants:
 *   - 7d natural threshold: ≥ 3 natural days in the last 7
 *   - 30d natural threshold: ≥ 5 natural days in the last 30
 *   - downward delta floor: 20 min (natural candidate must be ≥ 20 min
 *     below current target before a step is even considered)
 *   - upward delta floor: 20 min above target
 *   - downward step: min(10, 0.15 × (target − natural))
 *   - upward step:   min(20, 0.35 × (max(natural, observed) − target))
 *   - required downward streak: 2 consecutive supporting evaluations
 *
 * Tunables are inlined for v1 readability; once Codex flags churn (or a
 * second consumer needs them) they move to `constants.ts`.
 */
function evaluateTrendTargetDrift(input: DriftInputs): TrendTargetState {
  const { prior, observedRecentMin, classifiedDays, ageFloorMin, now } = input;
  const updatedAt = new Date(now).toISOString();

  // Evidence-frame gate (Codex 2026-05-25 review, replacing the original
  // UTC-date gate). `assembleState` runs on every state fetch, so without
  // a per-evidence gate the streak/step would accumulate across multiple
  // same-frame evaluations — and the upward path mutates targetMin in
  // place, so even a single re-fire ratchets up. A fingerprint over
  // evidence-bearing classified days + the observed mean catches both:
  //   - repeated calls within the same evaluation frame (hold),
  //   - same-UTC-date calls where a parent backfilled yesterday's data
  //     (advance — the old date-based gate would have missed this).
  // Legacy rows with `evidenceFingerprint === undefined` (pre-migration)
  // skip the gate and evaluate once; the new marker persists on the
  // returned state.
  const fingerprint = computeEvidenceFingerprint(classifiedDays, observedRecentMin);
  if (prior.evidenceFingerprint !== undefined && prior.evidenceFingerprint === fingerprint) {
    return { ...prior, updatedAt };
  }
  // Legacy migration safety: pre-deploy rows have no fingerprint. If
  // the prior was updated today (UTC), the old date-based gate would
  // have held — keep that behavior so a first post-deploy fetch on the
  // same day can't advance a streak the old code already saw. Stamp
  // the fingerprint so subsequent calls use the data-based gate. Codex
  // 2026-05-25 review noted this as a non-blocking transition risk.
  if (prior.evidenceFingerprint === undefined) {
    const priorDate = prior.updatedAt.slice(0, 10);
    const nowDate = new Date(now).toISOString().slice(0, 10);
    if (priorDate === nowDate) {
      return { ...prior, updatedAt, evidenceFingerprint: fingerprint };
    }
  }

  // Downward-drift evidence is *self-woke only*. Untagged-complete days
  // are useful for observed averaging and for upward drift but they
  // aren't strong enough to lower the held target by themselves.
  const selfWokeDays = classifiedDays.filter((d) => d.kind === "natural-self-woke");
  const selfWokeDays7 = selfWokeDays.filter(
    (d) => new Date(`${d.date}T00:00:00Z`).getTime() >= now - 7 * 86400_000,
  ).length;
  const selfWokeTotals = selfWokeDays.map((d) => d.totalMin);
  const selfWokeMean = selfWokeTotals.length >= 3
    ? selfWokeTotals.reduce((a, b) => a + b, 0) / selfWokeTotals.length
    : null;

  // Upward-drift evidence accepts any natural day (self-woke OR
  // untagged-complete) plus observed mean — under-capping is the more
  // urgent direction and a quietly-logged day still tells us the baby
  // wanted more sleep than we'd been targeting.
  const naturalDaysAny = classifiedDays.filter(
    (d) => d.kind === "natural-self-woke" || d.kind === "natural-untagged",
  );
  const naturalAnyTotals = naturalDaysAny.map((d) => d.totalMin);
  const naturalAnyMean = naturalAnyTotals.length >= 3
    ? naturalAnyTotals.reduce((a, b) => a + b, 0) / naturalAnyTotals.length
    : null;

  const observedDelta = observedRecentMin - prior.targetMin;
  const upwardDelta =
    naturalAnyMean !== null ? naturalAnyMean - prior.targetMin : 0;
  const selfWokeDelta = selfWokeMean !== null ? selfWokeMean - prior.targetMin : 0;

  // Upward drift: fast, no streak. Also raises the held baseline so a
  // legitimate "she needs more sleep now" signal isn't erased by a
  // later downward swing.
  if (upwardDelta >= 20 || observedDelta >= 20) {
    const delta = Math.max(upwardDelta, observedDelta);
    const step = Math.min(20, 0.35 * delta);
    const nextTarget = prior.targetMin + step;
    return {
      ...prior,
      targetMin: nextTarget,
      baselineMin: Math.max(prior.baselineMin, nextTarget),
      naturalSupportStreak: 0,
      confidence: naturalAnyMean !== null ? "medium" : "low",
      source: prior.source,
      updatedAt,
      evidenceFingerprint: fingerprint,
    };
  }

  // Downward drift: needs sustained *self-woke* evidence well below
  // target, plus the 2-consecutive-evaluation streak.
  const enoughSelfWoke = selfWokeDays7 >= 3 || selfWokeTotals.length >= 5;
  if (enoughSelfWoke && selfWokeMean !== null && selfWokeDelta <= -20) {
    const newStreak = prior.naturalSupportStreak + 1;
    if (newStreak >= 2) {
      const step = Math.min(10, 0.15 * (prior.targetMin - selfWokeMean));
      const nextTarget = Math.max(ageFloorMin, prior.targetMin - step);
      return {
        ...prior,
        targetMin: nextTarget,
        naturalSupportStreak: 0,
        confidence: "medium",
        source: "natural-days",
        updatedAt,
        evidenceFingerprint: fingerprint,
      };
    }
    return {
      ...prior,
      naturalSupportStreak: newStreak,
      updatedAt,
      evidenceFingerprint: fingerprint,
    };
  }

  // No actionable signal — reset streak.
  return {
    ...prior,
    naturalSupportStreak: 0,
    confidence: prior.confidence === "low" && selfWokeMean !== null
      ? "medium"
      : prior.confidence,
    updatedAt,
    evidenceFingerprint: fingerprint,
  };
}

/**
 * Fingerprint of the evidence the drift function would consume: evidence-
 * bearing classified days (excluding off-day / incomplete / noisy) plus
 * the observed recent mean. Cheap string comparison gates re-fire of the
 * mutation paths on the same evaluation frame. Codex 2026-05-25 review
 * §"3. Extra test scenarios" — must NOT depend on `incomplete` days so
 * a midnight tick doesn't reset/advance the streak.
 */
function computeEvidenceFingerprint(
  classifiedDays: TrendDay[],
  observedRecentMin: number,
): string {
  const evidence = classifiedDays
    .filter(
      (d) =>
        d.kind === "natural-self-woke"
        || d.kind === "natural-untagged"
        || d.kind === "policy-affected",
    )
    .toSorted((a, b) => a.date.localeCompare(b.date))
    .map((d) => `${d.date}:${d.kind}:${Math.round(d.totalMin)}`)
    .join("|");
  return `${evidence}#obs=${Math.round(observedRecentMin)}`;
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

  const naturalDays30 = classifiedDays.filter(isNaturalKind).length;
  const policyAffectedDays30 = classifiedDays.filter((d) => d.kind === "policy-affected").length;
  const offDaysDropped = classifiedDays.filter((d) => d.kind === "off-day").length;
  const completedDays30 = classifiedDays.filter(isCompletedKind).length;
  const completedDays7 = classifiedDays.filter(
    (d) => isCompletedKind(d) && new Date(`${d.date}T00:00:00Z`).getTime() >= now - 7 * 86400_000,
  ).length;
  const ageBand = findByAge(SLEEP_NEEDS, ctx.ageMonths);
  const floorMin = ageBand.range[0] * 60;

  const observedRecentMin = Math.round(observed.blendedTrendMin);
  const updatedAt = new Date(now).toISOString();

  // Held-target shape: prior carries forward, then drift evaluation
  // decides whether to step it (gated on natural-day evidence).
  let interventionTargetMin: number;
  let interventionConfidence: TrendTargetConfidence;
  let interventionSourceLabel: string;
  let nextState: TrendTargetState;
  if (prior) {
    const drifted = evaluateTrendTargetDrift({
      prior,
      observedRecentMin: observed.blendedTrendMin,
      classifiedDays,
      ageFloorMin: floorMin,
      now,
    });
    interventionTargetMin = Math.round(drifted.targetMin);
    interventionConfidence = drifted.confidence;
    interventionSourceLabel = drifted.source === "natural-days"
      ? "natural-day drift"
      : `held baseline (${drifted.source})`;
    nextState = drifted;
  } else {
    // Initialize from observed. Bias the baseline UP toward natural-day
    // mean if natural days dominate the window — capped/low days
    // shouldn't seed the held baseline low. (Stage 3 will tighten this.)
    const naturalTotals = classifiedDays
      .filter((d) => d.kind === "natural-self-woke" || d.kind === "natural-untagged")
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
      evidenceFingerprint: computeEvidenceFingerprint(classifiedDays, observed.blendedTrendMin),
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
