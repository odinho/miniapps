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
  findByAge,
} from "./constants.js";
import { isoToDateInTz } from "$lib/tz.js";
import { estimateSleepCycleFromData } from "./schedule.js";
import { computeBlendedTrend, computeTrendTargets } from "./trend.js";

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
  /**
   * The baby's learned typical full-nap duration (minutes), used to project
   * how long the active nap would run if uncapped. Passed in from
   * `getLearnedNapDuration(ctx)` at the call site to avoid a circular
   * import. Falls back to a conservative 90 / 75 min by age band when
   * absent. A transitioning baby with learned=60 won't get false caps
   * driven by a stale 90-min projection.
   */
  learnedNapDurationMin?: number;
  /**
   * Last persisted mode for this baby (Codex 2026-05-13 review §"Mode
   * hysteresis isn't real hysteresis"). When omitted (no history) the
   * engine falls back to the pure data-driven check. When provided, the
   * "established" mode is sticky: it stays until the 7d trend climbs back
   * above the 30d (i.e. the parent has stopped capping), instead of
   * self-terminating just because mean30 has caught up to mean7.
   */
  priorState?: { mode: "first-contact" | "established"; enteredAt: string } | null;
  /** Now (epoch ms). */
  now: number;
  /** Baby context — age, tz. */
  ctx: BabyContext;
}

/**
 * "Was today on-trend or above already, without needing more sleep?"
 *
 * Used by the rescue paths (continuationWindow, rescueNap) and by
 * `censorCutShortNaps` to short-circuit cut-short detection when the
 * day's total sleep already meets the trend. Without this, the engine
 * told the parent to cap, then complained the cap was "too short" the
 * moment the parent obliged — exactly the bug Halldis showed on
 * 2026-05-13 (67 min nap flagged as cut-short, even though banked24h
 * was already 13.5 h vs ~13 h trend).
 *
 * Returns false (no suppression) when trend data is too sparse or noisy
 * to trust — the existing rescue behaviour stays in place by default.
 */
export function isDayOnTrend(
  trendSleeps: SleepEntry[],
  todaySleeps: SleepEntry[],
  ctx: BabyContext,
  now: number,
): boolean {
  const trend = computeBlendedTrend(trendSleeps, ctx.tz, now, ctx.ageMonths, ctx.offDays);
  if (!trend) return false;
  const banked = computeBankedToday(trendSleeps, todaySleeps, null, ctx.tz, now);
  return banked >= trend.blendedTrendMin - NAP_BUDGET.TOLERANCE_MIN;
}

export function computeNapBudget(input: ComputeNapBudgetInput): NapBudget | null {
  const { activeNap, todaySleeps, trendSleeps, bedtime, isLastNapOfDay, optedIn, learnedNapDurationMin, priorState, now, ctx } = input;

  // ── Gate 1: per-baby opt-out and v1 scope (last nap only). ──────────
  if (!optedIn || !isLastNapOfDay) return null;

  // ── Gate 1b: today is flagged off (sick / travel / spurt / DST). The
  //    off-day toggle exists so a parent's bad week doesn't pull the
  //    *trend* sideways, AND so the engine backs off recommendations for
  //    that day. Only filtering history would leave the parent staring at
  //    a cap banner on the very day they told the app to leave them alone.
  if (ctx.offDays && ctx.offDays.has(isoToDateInTz(new Date(now).toISOString(), ctx.tz))) {
    return null;
  }

  // ── Gate 2: nap just started — don't propose for a baby that just
  //    fell asleep. Risk of misfire is high in the first ~20 min.
  const napStartMs = new Date(activeNap.start_time).getTime();
  const elapsedMin = (now - napStartMs) / 60_000;
  if (elapsedMin < NAP_BUDGET.MIN_ELAPSED_BEFORE_CAP_MIN) return null;

  // ── Gate 3: trend targets. Stage 4 of the trend split — Codex
  //    2026-05-20: cap math compares against the held *intervention*
  //    target so cap-following doesn't ratchet the target down (the
  //    rolling observed mean still does, but it stops driving the cap).
  //    Mode-hysteresis math stays on observed mean7/mean30 because the
  //    "has the parent been respecting caps?" signal is observed by
  //    definition.
  const trendTargets = ctx.trendTargets
    ?? computeTrendTargets(trendSleeps, ctx, now, ctx.priorTrendTargetState ?? null);
  if (!trendTargets) return null;
  const trend = {
    blendedTrendMin: trendTargets.interventionTargetMin,
    sourceLabel: trendTargets.interventionSourceLabel,
    mean7: trendTargets.mean7,
    mean30: trendTargets.mean30,
  };

  // ── Gate 4: today's projection. Uses a rolling 24h window so last
  //    night's sleep counts toward today's budget — that matches the
  //    parent's actual reasoning ("she slept 12.44 h last night + 1.5 h
  //    nap = 14 h vs 13 h trend"). Projection vs *intervention* target,
  //    not observed: if today is already projecting at the held target
  //    the cap math has nothing to do.
  const bankedMin = computeBankedToday(trendSleeps, todaySleeps, activeNap, ctx.tz, now);
  const projectedIfRunsFull = bankedMin + estimateRemainingNapMin(activeNap, now, ctx, learnedNapDurationMin);
  if (projectedIfRunsFull <= trend.blendedTrendMin) {
    return null;
  }

  // ── Mode detection with hysteresis.
  //
  //  Enter "established" when the 7d trend has dropped at least
  //  ESTABLISHED_TRACK_DELTA_MIN below the 30d trend (the parent has been
  //  respecting cap advice for ~a week).
  //
  //  *Stay* established as long as 30d ≥ 7d — even by a few minutes. After
  //  ~30 days of cap-respect the two trends converge, and a pure
  //  delta-≥-25 gate self-terminates established mode while the parent is
  //  still capping (Codex 2026-05-13 review). The relaxed stay-gate keeps
  //  the engine in established mode until 7d climbs back above 30d, which
  //  is the actual signal that the parent has stopped capping.
  const delta = trend.mean30 - trend.mean7;
  const wasEstablished = priorState?.mode === "established";
  const establishedMode = wasEstablished
    ? delta >= 0
    : delta >= NAP_BUDGET.ESTABLISHED_TRACK_DELTA_MIN;

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

  // wakeBy can't be in the past. Applied AFTER the bedtime guard so a
  // tightened cap (bedtime - 90 min) doesn't re-introduce a past wake when
  // the parent has napped into the wake window. Urgency stays firm — the
  // engine is essentially saying "wake now".
  cappedDurationMin = Math.max(cappedDurationMin, elapsedMin + 1);

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
 * "Today's frame" sleep total, sleep-day-anchored.
 *
 * Sleep-day anchor = the morning wake (= end_time of the most recent
 * completed night before `now`). Everything sleeping after that wake counts
 * toward today's banked, regardless of calendar-midnight boundaries.
 * Captures three edge cases the previous midnight-anchored frame missed
 * (Codex 2026-05-13 review §"Today's-frame banked"):
 *
 *   - **Split nights**: mid-night feeding logged as a separate entry. The
 *     prior code only counted the first night that ended today and bailed
 *     out with `break`. We now sum every night whose end falls in the same
 *     overnight window (≤ 12h before the wake anchor).
 *   - **Midnight-crossing naps**: a 23:40-00:30 nap starts on yesterday's
 *     local date but obviously belongs to one sleep-day. Anchoring on the
 *     morning wake puts it on the correct side of the boundary.
 *   - **Day-shifted schedules**: families whose baby naps late into the
 *     evening hit a midnight boundary that doesn't correspond to anything
 *     the parent recognises. The morning-wake anchor is the natural
 *     reference point.
 *
 * Fallback: when no completed night precedes `now` (true first day after
 * onboarding), use local midnight as a conservative anchor.
 */
function computeBankedToday(
  trendSleeps: SleepEntry[],
  todaySleeps: SleepEntry[],
  activeNap: { start_time: string } | null,
  tz: string,
  now: number,
): number {
  const allSleeps = [...trendSleeps, ...todaySleeps];

  // Anchor: end_time of the most recent completed night before now.
  let wakeAnchorMs: number | null = null;
  for (const s of allSleeps) {
    if (s.type !== "night" || !s.end_time) continue;
    const endMs = new Date(s.end_time).getTime();
    if (endMs >= now) continue;
    if (wakeAnchorMs === null || endMs > wakeAnchorMs) wakeAnchorMs = endMs;
  }
  if (wakeAnchorMs === null) {
    // No prior night logged — fall back to local midnight in the baby's
    // timezone. Rare path (first day after install). UTC midnight here
    // would land 1-12h before local midnight for positive offsets and
    // misattribute late-evening naps to "today".
    wakeAnchorMs = localMidnightMs(now, tz);
  }

  // Limit night-fragment aggregation to a 12h window ending at the anchor —
  // long enough to catch night-feed entries split out from the main night,
  // short enough to exclude nights from older days.
  const OVERNIGHT_WINDOW_MS = 12 * 3600_000;
  const overnightStartMs = wakeAnchorMs - OVERNIGHT_WINDOW_MS;
  const seen = new Set<string>();
  let banked = 0;

  // (1) Overnight sleep — primary night plus any fragments inside the
  //     12h window. Each contributes its own duration; no double-count
  //     because intervals are disjoint by construction (log invariant).
  for (const s of allSleeps) {
    if (s.type !== "night" || !s.end_time) continue;
    if (seen.has(s.start_time)) continue;
    seen.add(s.start_time);
    const endMs = new Date(s.end_time).getTime();
    if (endMs > wakeAnchorMs || endMs < overnightStartMs) continue;
    const startMs = new Date(s.start_time).getTime();
    banked += (endMs - startMs) / 60_000;
  }

  // (2) Completed naps in the [wakeAnchorMs, now] interval. start_time
  //     gates inclusion — a nap that started before the wake anchor was
  //     part of yesterday's sleep-day.
  for (const s of allSleeps) {
    if (s.type !== "nap" || !s.end_time) continue;
    if (seen.has(s.start_time)) continue;
    seen.add(s.start_time);
    const startMs = new Date(s.start_time).getTime();
    const endMs = new Date(s.end_time).getTime();
    if (startMs < wakeAnchorMs) continue;
    if (endMs > now) continue;
    banked += (endMs - startMs) / 60_000;
  }

  // (3) Active nap elapsed.
  if (activeNap) {
    const napStartMs = new Date(activeNap.start_time).getTime();
    if (napStartMs < now && napStartMs >= wakeAnchorMs) {
      banked += (now - napStartMs) / 60_000;
    }
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
  learnedNapDurationMin?: number,
): number {
  const napStartMs = new Date(activeNap.start_time).getTime();
  const elapsedMin = (now - napStartMs) / 60_000;
  // Prefer the per-baby learned-typical when the caller supplies it — a
  // baby transitioning to shorter naps won't get false caps driven by a
  // stale 90-min projection. Fall back to an age-band-typical upper bound
  // (90 min < 14mo, 75 min beyond) when absent.
  const typicalFullNapMin = learnedNapDurationMin && learnedNapDurationMin > 0
    ? learnedNapDurationMin
    : ctx.ageMonths < 14 ? 90 : 75;
  return Math.max(0, typicalFullNapMin - elapsedMin);
}

/**
 * Local midnight (start of day) in the given IANA tz, as epoch ms. Used by
 * the sleep-day anchor fallback. Mirrors `todayInTz()` from src/lib/tz.ts
 * but takes an explicit `now` so it's deterministic in tests.
 */
function localMidnightMs(now: number, tz: string): number {
  const dateStr = isoToDateInTz(new Date(now).toISOString(), tz);
  const asUtc = new Date(`${dateStr}T00:00:00Z`);
  const utcRef = asUtc.toLocaleString("en-US", { timeZone: "UTC" });
  const localRef = asUtc.toLocaleString("en-US", { timeZone: tz });
  const offsetMs = new Date(localRef).getTime() - new Date(utcRef).getTime();
  return asUtc.getTime() - offsetMs;
}
