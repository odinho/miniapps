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
import { RESCUE_NAP, NAP_FLOOR_BY_AGE, findByAge } from "./constants.js";
import { getTodayStats, getSleepDayTotals } from "./stats.js";
import { computeConfidence, computeWakeRange } from "./confidence.js";
import { computeNapBudget, isDayOnTrend } from "./nap-budget.js";
import { computeTrendTargets, computeTrendTotalMin } from "./trend.js";
import type { TrendTargetState } from "./trend.js";
import { calibrate } from "./calibration.js";
import { computeStrategySignals } from "./features.js";
import { selectStrategy } from "./strategy.js";
import { predictNewborn } from "./newborn.js";
import { predictEmerging } from "./emerging.js";
import type { Baby, SleepLogRow, SleepPauseRow, DayStartRow, SleepEntry, BabyContext } from "$lib/types.js";
import type { PredictedNap } from "./schedule.js";
import type { Strategy, StrategyContext, StrategyOverride } from "./strategy.js";
import type { Prediction, PostSkipPlan } from "$lib/stores/app.svelte.js";

export interface DayData {
  baby: Baby;
  activeSleep: SleepLogRow | undefined;
  todaySleeps: SleepLogRow[];
  /** Recent sleeps (7-day lookback) for the schedule engine. */
  recentSleeps: SleepLogRow[];
  /** Extended sleeps (21-day lookback) for strategy hysteresis. Falls back to recentSleeps. */
  strategySleeps?: SleepLogRow[];
  /** Long-horizon sleeps (30-day lookback) for daily-total trend math in napBudget. Falls back to strategySleeps if absent. */
  trendSleeps?: SleepLogRow[];
  todayWakeUp: DayStartRow | undefined;
  /**
   * The overnight that ended *this* morning (start_time before midnight,
   * end_time today). Carried separately from `todaySleeps` because that
   * list is filtered to `start_time >= midnight` for the engine planner.
   * UI surfaces that want the parent's natural "sleep day" total use this
   * to add the morning night onto today's totals. Undefined when no such
   * overnight exists (still in progress, or none logged).
   */
  priorOvernightSleep?: SleepLogRow | undefined;
  pausesBySleep: Map<number, SleepPauseRow[]>;
  diaperCount: number;
  lastDiaperTime: string | null;
  /**
   * Per-baby opt-in for the napBudget feature (banner + push). Reads from
   * notification_preferences.nap_budget_cap server-side. Defaults to true
   * for tests and historical callers that pre-date the wiring.
   */
  napBudgetOptedIn?: boolean;
  /**
   * Last persisted nap-budget mode (server reads from nap_budget_state).
   * Drives hysteresis so "established" doesn't self-terminate after ~30
   * days of cap-respect. Null = no prior state.
   */
  priorNapBudgetState?: { mode: "first-contact" | "established"; enteredAt: string } | null;
  /**
   * Last persisted trend-target state (server reads from trend_target_state).
   * Holds the intervention target across calls so cap-following doesn't
   * ratchet it downward — see local/codex-trend-split-design.md. Null when
   * no prior state has been recorded (first evaluation after the feature
   * lands, or after a manual reset).
   */
  priorTrendTargetState?: TrendTargetState | null;
  /**
   * Date keys (YYYY-MM-DD in baby tz) flagged as off-days. Threaded into
   * BabyContext so the trend computation can skip them.
   */
  offDays?: Set<string>;
  /** Optional override for "now", used by tests. Defaults to Date.now(). */
  now?: number;
}

function toSleepEntry(s: SleepLogRow): SleepEntry {
  const wokeBy = s.woke_by === "self" || s.woke_by === "woken" ? s.woke_by : null;
  return {
    start_time: s.start_time,
    end_time: s.end_time,
    type: s.type as SleepEntry["type"],
    woke_by: wokeBy,
  };
}

/**
 * How many of today's naps actually satisfied the day's nap budget.
 *
 * A nap shorter than `shortNapThresholdMin` (~learned duration minus half a
 * sleep cycle) doesn't fulfill the day's sleep need — the baby still has the
 * deficit and the engine should plan another. Without this, a 28-min car nap
 * counts the same as a 120-min full nap and the engine jumps straight to
 * bedtime. Active naps count optimistically; their length isn't known yet,
 * and downstream rescue-nap logic will recommend cutting short if needed.
 */
function countSufficientNaps(
  completedNaps: SleepLogRow[],
  shortNapThresholdMin: number,
  hasActiveNap: boolean,
): number {
  const sufficient = completedNaps.filter((s) => {
    if (!s.end_time) return false;
    const durMin = (new Date(s.end_time).getTime() - new Date(s.start_time).getTime()) / 60_000;
    return durMin >= shortNapThresholdMin;
  });
  return sufficient.length + (hasActiveNap ? 1 : 0);
}

export interface CutShortInfo {
  startMs: number;
  endMs: number;
  durMin: number;
  /** Captured wake reason — 'woken' = parent ended it, 'self' = baby spontaneous, null = untagged. */
  wokeBy: "self" | "woken" | null;
}

/**
 * Find the most recently-ended completed nap that fell short of the threshold.
 * Drives the comeback-nap re-anchor in assembleSchedulePrediction and the
 * continuationWindow gating (which now reads `wokeBy` to respect deliberate
 * parent wakes).
 */
function mostRecentCutShort(
  completedNaps: SleepLogRow[],
  shortNapThresholdMin: number,
): CutShortInfo | null {
  let best: CutShortInfo | null = null;
  for (const s of completedNaps) {
    if (!s.end_time) continue;
    const startMs = new Date(s.start_time).getTime();
    const endMs = new Date(s.end_time).getTime();
    const durMin = (endMs - startMs) / 60_000;
    if (durMin >= shortNapThresholdMin) continue;
    const wokeBy = s.woke_by === "self" || s.woke_by === "woken" ? s.woke_by : null;
    if (!best || endMs > best.endMs) best = { startMs, endMs, durMin, wokeBy };
  }
  return best;
}

/**
 * Decide whether to suppress the "Forleng luren" continuation banner for a
 * cut-short nap.
 *
 * The continuation window is sleep-science-correct for one specific case:
 * a baby self-woke too early from a meaningful nap, residual pressure is
 * high, the parent has ~25 min to settle them back. It's actively wrong
 * for the case we keep landing on:
 *
 *   1. napBudget recommends a cap (projected total > trend).
 *   2. Parent obeys, wakes the baby (woke_by = "woken").
 *   3. The just-ended nap is below `shortNapThreshold` by definition
 *      (the parent cut it short *because the engine asked*).
 *   4. Continuation fires "Forleng luren" — directly contradicting the
 *      cap recommendation the parent just acted on.
 *
 * Gates, in order:
 *
 *   - Below age-band floor → fire (micro-nap, didn't discharge pressure;
 *     parent intent is moot).
 *   - Day already on trend → suppress (the existing 2026-05-13 fix).
 *   - Substantial parent-woken nap (woke_by = "woken", dur ≥ half of
 *     learned typical duration) → suppress. The duration gate keeps
 *     transit-cut shorts (a 28 min car nap on a 100 min-typical baby)
 *     firing continuation as before — those parents *do* want help
 *     extending — while respecting the deliberate engine-cap-respect
 *     wake that triggered this whole fix.
 *   - Otherwise → fire.
 *
 * Exported so tests can pin each gate down independently — the previous
 * version inlined the logic at both call sites and the parent-woken case
 * was missing, which is the bug this commit closes.
 */
export function shouldSuppressContinuation(
  cutShort: CutShortInfo,
  ctx: BabyContext,
  todaySleeps: SleepEntry[],
  trendSleeps: SleepEntry[],
  now: number,
  ageBandFloorMin: number,
  learnedNapDurationMin: number,
): boolean {
  if (cutShort.durMin < ageBandFloorMin) return false;
  if (isDayOnTrend(trendSleeps, todaySleeps, ctx, now)) return true;
  if (
    cutShort.wokeBy === "woken"
    && cutShort.durMin >= learnedNapDurationMin * SUBSTANTIAL_FRACTION
  ) {
    return true;
  }
  return false;
}

/** A parent-ended nap counts as a "substantial" wake (likely a deliberate
 * cap-respect, not an interrupted-by-life cut-short) when it cleared this
 * fraction of the baby's learned typical nap duration. Picked at 0.5 so a
 * ~60 min wake on a ~110-120 min-typical baby reads as cap-respect, while
 * a ~28 min transit cut-short still triggers continuation. */
const SUBSTANTIAL_FRACTION = 0.5;

/**
 * Minutes after a cut-short during which residual sleep pressure is still high
 * enough to re-induce sleep. Pediatric guidance (Mindell, Weissbluth, ChatGPT
 * sleep coach echoing both) consistently lands at 15–25 min — past that,
 * arousal systems have stabilised and re-induction success rate drops sharply.
 *
 * Calibration story: I briefly bumped this to 45 min based on what looked
 * like a real recovery (28-min cut-short → "fell asleep at 09:30, 41 min
 * later"). Turned out to be a false signal — the parent had a chill but
 * awake baby in the stroller, not a sleeping one. Snapping back to 25 min
 * keeps the science honest and tells the parent earlier when to give up
 * and plan the comeback nap.
 */
const CONTINUATION_WINDOW_MIN = 25;

/**
 * Compute the continuation window for the given cut-short, or null if the
 * window has already closed at `now`.
 *
 *   closesAt    = cutShort.endMs + 25 min
 *   capLatestEnd = cutShort.startMs + learnedNapDurationMin
 *
 * `capLatestEnd` keeps the continuation from running so long it disrupts the
 * day's pattern — the implicit assumption is that the cut-short + continuation
 * together should not exceed the baby's normal nap length by much.
 */
function computeContinuationWindow(
  cutShort: { endMs: number },
  cutShortStartMs: number,
  learnedNapDurationMin: number,
  now: number,
): { closesAt: string; capLatestEnd: string } | null {
  const closesAtMs = cutShort.endMs + CONTINUATION_WINDOW_MIN * 60_000;
  if (now > closesAtMs) return null;
  const capLatestEndMs = cutShortStartMs + learnedNapDurationMin * 60_000;
  return {
    closesAt: new Date(closesAtMs).toISOString(),
    capLatestEnd: new Date(capLatestEndMs).toISOString(),
  };
}

/**
 * SWA-weighted wake-window compression after a cut-short.
 *
 * Borbély's two-process model treats sleep pressure as exponential dissipation
 * during sleep, with slow-wave activity concentrated in the first NREM cycle.
 * A 28-min nap captures mostly N1/N2 with minimal N3, so it discharges roughly
 * one cycle's worth (~30%) of pressure relief, not the linear 28/120 ≈ 23%.
 *
 *   discharge = min(1, napMin / 60) ^ 0.7        // concave, SWA-weighted
 *   factor    = 0.6 + 0.4 * discharge            // 60% floor, 100% if full nap
 *   nextWW    = max(165 min, baselineWW * factor) // floor: 2h45m
 *
 * Sources: Achermann & Borbély 2003 (SWA dissipation), Galland 2012 meta
 * (10mo WW range), Weissbluth (overtired-WW shortening), Mindell 2nd ed.
 */
function compressComebackNap(
  nap: PredictedNap,
  cutShort: { endMs: number; durMin: number },
): PredictedNap {
  const napStartMs = new Date(nap.startTime).getTime();
  const napEndMs = new Date(nap.endTime).getTime();
  const baselineWWMin = (napStartMs - cutShort.endMs) / 60_000;
  // If the planned nap is at or before the cut-short end (e.g. unmoved
  // morning-anchored plan), there's nothing to compress — caller should have
  // re-anchored already; bail out rather than producing a past-time nap.
  if (baselineWWMin <= 0) return nap;

  const discharge = Math.pow(Math.min(1, cutShort.durMin / 60), 0.7);
  const factor = 0.6 + 0.4 * discharge;
  const targetWWMin = Math.max(165, baselineWWMin * factor);
  if (targetWWMin === baselineWWMin) return nap;

  const newStartMs = cutShort.endMs + targetWWMin * 60_000;
  const napDurMs = napEndMs - napStartMs;
  return {
    startTime: new Date(newStartMs).toISOString(),
    endTime: new Date(newStartMs + napDurMs).toISOString(),
  };
}

/**
 * Decide what to recommend after a nap is skipped: try a rescue nap if there's
 * still room before bedtime, otherwise propose an earlier bedtime to clear the
 * sleep deficit. Rules:
 *
 *  - Rescue requires: room for a ≥30 min nap, starting in ≥30 min from now,
 *    waking ≥90 min before bedtime (preserves the wake window), starting
 *    within 3 h from now (later naps risk overshooting bedtime).
 *  - The rescue duration is capped at RESCUE_NAP.CAP_CEILING_MIN so the
 *    parent gets a power nap, not a real nap. The Timer renders one concrete
 *    start time and a "wake by" cap so 1h 55m start-ranges don't read as
 *    1h 55m nap-durations to the parent.
 *  - When rescue isn't feasible, suggest 30 min earlier (45 min for <6 mo,
 *    whose deficits are higher-stakes). Capped at 30 min before "now" so we
 *    don't recommend a bedtime that's already passed.
 *
 * Doesn't mutate `nextNap` / `predictedNaps` — those still flip to bedtime
 * via the existing napsAllDone path. This is additional surface for the UI.
 */
function computePostSkipPlan(
  now: number,
  bedtime: string,
  ageMonths: number,
): { kind: "rescue"; recommendedStart: string; latestStart: string; wakeBy: string }
  | { kind: "earlier-bedtime"; suggestedBedtime: string; minutesEarlier: number } {
  const bedtimeMs = new Date(bedtime).getTime();
  const RESCUE_MIN_DURATION_MS = 30 * 60_000;
  const RESCUE_CAP_MS = RESCUE_NAP.CAP_CEILING_MIN * 60_000; // ≤60 min
  const PRE_BEDTIME_BUFFER_MS = RESCUE_NAP.MIN_PRE_BEDTIME_WAKE * 60_000; // ≥90 min
  const MIN_START_DELAY_MS = 30 * 60_000;
  const MAX_START_DELAY_MS = 3 * 60 * 60_000;

  // Earliest start: 30 min from now (give parent time to wind down).
  // Latest start: bedtime - 90 min (wake gap) - 30 min (nap duration).
  const earliestStart = now + MIN_START_DELAY_MS;
  const latestStart = Math.min(
    now + MAX_START_DELAY_MS,
    bedtimeMs - PRE_BEDTIME_BUFFER_MS - RESCUE_MIN_DURATION_MS,
  );

  if (latestStart > earliestStart) {
    // Recommend the earliest sensible start — earlier rescues protect bedtime
    // better than later ones. Wake-by is start + rescue cap, but never later
    // than bedtime - 90 min so the wake window holds.
    const recommendedMs = earliestStart;
    const wakeByMs = Math.min(
      recommendedMs + RESCUE_CAP_MS,
      bedtimeMs - PRE_BEDTIME_BUFFER_MS,
    );
    return {
      kind: "rescue",
      recommendedStart: new Date(recommendedMs).toISOString(),
      latestStart: new Date(latestStart).toISOString(),
      wakeBy: new Date(wakeByMs).toISOString(),
    };
  }

  const shiftMin = ageMonths < 6 ? 45 : 30;
  // Don't suggest a bedtime that's already past, and don't suggest one *later*
  // than the day's planned bedtime — if the action floor (now+30m) is already
  // past planned bedtime, the parent should just go to bedtime now. We still
  // emit earlier-bedtime so the Timer can label the skip; minutesEarlier=0
  // means "no shift, the planned time is the action."
  const floorMs = Math.min(bedtimeMs, now + 30 * 60_000);
  const suggestedMs = Math.max(bedtimeMs - shiftMin * 60_000, floorMs);
  return {
    kind: "earlier-bedtime",
    suggestedBedtime: new Date(suggestedMs).toISOString(),
    minutesEarlier: Math.max(0, Math.round((bedtimeMs - suggestedMs) / 60_000)),
  };
}

/**
 * Bundle the skipped-nap fields emitted on `Prediction`. Used by both the
 * routine-schedule and emerging-rhythm branches so they stay in sync — the
 * fields are coupled (postSkipPlan only makes sense alongside skippedNap)
 * and we don't want the two strategies drifting on the contract.
 */
function buildSkippedNapFields(
  napSkipped: boolean,
  nextNap: string | null,
  bedtime: string | null,
  now: number,
  ageMonths: number,
): { skippedNap: { plannedAt: string } | null; postSkipPlan: PostSkipPlan | null } {
  if (!napSkipped || !nextNap) return { skippedNap: null, postSkipPlan: null };
  return {
    skippedNap: { plannedAt: nextNap },
    postSkipPlan: bedtime ? computePostSkipPlan(now, bedtime, ageMonths) : null,
  };
}

/** Build a BabyContext from a Baby record and recent sleep data. */
/**
 * Wake-recommendation priority: when napBudget is present it owns the
 * decision. Suppressing rescueNap here means the same active nap can't
 * render two banners with conflicting wake-by times — UI and the push
 * scheduler both consume the post-arbitration value. Codex 2026-05-13
 * review §"No priority arbitration between wake recommendations".
 *
 * `expectedWakeRange` is intentionally untouched — it's uncertainty
 * around a prediction, not advice, and stays orthogonal.
 *
 * Exported so the rule has its own unit test.
 */
export function arbitrateRescueAgainstNapBudget(
  rescueNap: Prediction["rescueNap"],
  napBudget: Prediction["napBudget"],
): Prediction["rescueNap"] {
  if (napBudget) return null;
  return rescueNap;
}

interface PostPlanInput {
  ctx: BabyContext;
  todaySleeps: SleepLogRow[];
  todaySleepEntries: SleepEntry[];
  completedNaps: SleepLogRow[];
  activeSleep: SleepLogRow | undefined;
  cycleMin: number;
  shortThreshold: number;
  consumedNaps: number;
  expectedNapCount: number;
  lastCutShort: CutShortInfo | null;
  remaining: PredictedNap[];
  bedtime: string;
  /**
   * Fallback `nextNap` when the filtered predictedNaps is empty.
   *
   * Schedule path: `predictNextNap(wakeTime, ctx)` — always a string,
   * computed from wakeTime + WW.
   *
   * Emerging path: `predictEmerging(...).nextNap` — may be null when the
   * engine doesn't have enough signal to surface one.
   */
  fallbackNextNap: string | null;
  now: number;
  napBudgetOptedIn: boolean;
  priorNapBudgetState: { mode: "first-contact" | "established"; enteredAt: string } | null;
}

interface PostPlanOutput {
  predictedNaps: PredictedNap[] | null;
  nextNap: string | null;
  napSkipped: boolean;
  napsAllDone: boolean;
  skippedNap: { plannedAt: string } | null;
  postSkipPlan: PostSkipPlan | null;
  expectedNapEnd: string | null;
  expectedNightEnd: string | null;
  rescueNap: Prediction["rescueNap"];
  napBudget: Prediction["napBudget"];
  continuationWindow: Prediction["continuationWindow"];
  expectedWakeRange: Prediction["expectedWakeRange"];
}

/**
 * The shared post-plan derivation chain used by both
 * `assembleEmergingPrediction` and `assembleSchedulePrediction`. Both
 * branches build a "remaining nap" list (from `selectBestPlan` + Borbély
 * compression) and then need to run the same sequence of derivations on
 * top of it: B8 + stale filter, nextNap derivation, skip detection,
 * napsAllDone, expected nap/night end, rescueNap, napBudget,
 * continuationWindow, expectedWakeRange.
 *
 * Splitting this out is the consolidation pass the bug history kept
 * begging for — these two branches have silently drifted apart at least
 * three times (napBudget gate, continuation rule, napsAllDone). With one
 * implementation, a fix in any of those layers lands in both strategies
 * for free.
 */
function derivePostPlanFields(input: PostPlanInput): PostPlanOutput {
  const {
    ctx, todaySleeps, todaySleepEntries, completedNaps, activeSleep,
    cycleMin, shortThreshold, consumedNaps, expectedNapCount, lastCutShort,
    remaining, bedtime, fallbackNextNap, now, napBudgetOptedIn, priorNapBudgetState,
  } = input;

  const bedtimeMs = new Date(bedtime).getTime();

  // ── B8 + stale filter ──
  // Drop naps that would land within 60 min of bedtime (B8) AND drop
  // naps whose start time is already >60 min in the past (stale —
  // parent didn't act on them, no point rendering them as "next" any
  // longer). Surfaced by the May-2026 review where Oskar's planned
  // comeback at 14:13 was still rendered as nextNap at now=15:43.
  let predictedNaps: PredictedNap[] | null = remaining.filter((n) => {
    const startMs = new Date(n.startTime).getTime();
    const endMs = new Date(n.endTime).getTime();
    return startMs < bedtimeMs - 60 * 60_000
      && endMs < bedtimeMs - 60 * 60_000
      && startMs > now - 60 * 60_000;
  });
  if (predictedNaps.length === 0) predictedNaps = null;

  // ── Derive nextNap ──
  let nextNap: string | null = predictedNaps && predictedNaps.length > 0
    ? predictedNaps[0].startTime
    : fallbackNextNap;

  // ── Skip detection + napsAllDone ──
  // 60-min threshold (was 90) — the laxer setting let predictNextNap
  // produce stale past-time naps that lived past the visibility filter.
  const nextNapMs = nextNap ? new Date(nextNap).getTime() : 0;
  const overdueMs = nextNapMs ? now - nextNapMs : 0;
  const napSkipped = !activeSleep && overdueMs > 60 * 60_000 && overdueMs < 18 * 60 * 60_000;
  // When the next predicted nap lands within 60 min of bedtime, treat
  // the day's naps as effectively done — otherwise the Timer would show
  // "next nap" with bedtime as the target time.
  const collapsedToBedtime = nextNapMs >= bedtimeMs - 60 * 60_000;
  // An active night ends the day's nap budget regardless of count.
  const napsAllDone = consumedNaps >= expectedNapCount
    || napSkipped
    || collapsedToBedtime
    || activeSleep?.type === "night";

  // Capture the missed slot *before* napsAllDone clears nextNap.
  const { skippedNap, postSkipPlan } = buildSkippedNapFields(
    napSkipped, nextNap, bedtime, now, ctx.ageMonths,
  );

  if (napsAllDone) {
    nextNap = bedtime;
    predictedNaps = null;
  }

  // ── Active-sleep derived fields ──
  let expectedNapEnd: string | null = null;
  let rescueNap: Prediction["rescueNap"] = null;
  if (activeSleep && activeSleep.type === "nap" && !activeSleep.end_time) {
    expectedNapEnd = predictNapEndTime(activeSleep.start_time, ctx);
    const rescueCap = computeRescueNapCap(cycleMin);
    // Pass only sufficient-length prior naps to the rescue detector.
    // A comeback nap after a 28-min cut-short shouldn't be treated as
    // an "extra" nap and capped at ~50 min — it's making up for the
    // missed real nap and should run full length.
    const priorSufficient = completedNaps.filter((s) => {
      if (!s.end_time) return false;
      const dur = (new Date(s.end_time).getTime() - new Date(s.start_time).getTime()) / 60_000;
      return dur >= shortThreshold;
    });
    rescueNap = detectRescueNap(
      activeSleep.start_time,
      priorSufficient.map((s) => ({ start_time: s.start_time, end_time: s.end_time! })),
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
      .reduce((sum, s) => sum + (new Date(s.end_time!).getTime() - new Date(s.start_time).getTime()) / 60_000, 0);
    expectedNightEnd = predictNightEndTime(activeSleep.start_time, ctx, todayNapMin);
  }

  // ── continuationWindow gate (shared logic in shouldSuppressContinuation) ──
  const learnedNapDurMin = getLearnedNapDuration(ctx);
  const suppressContinuation = lastCutShort
    ? shouldSuppressContinuation(
        lastCutShort, ctx, todaySleepEntries,
        ctx.trendSleeps ?? ctx.recentSleeps, now,
        findByAge(NAP_FLOOR_BY_AGE, ctx.ageMonths).floorMin,
        learnedNapDurMin,
      )
    : false;
  const continuationWindow = !activeSleep && lastCutShort && !suppressContinuation
    ? computeContinuationWindow(lastCutShort, lastCutShort.startMs, learnedNapDurMin, now)
    : null;

  // ── napBudget + arbitration ──
  const isActiveNap = activeSleep?.type === "nap" && !activeSleep.end_time;
  const isLastNapOfDay = isActiveNap && (!predictedNaps || predictedNaps.length === 0);
  const napBudget = isActiveNap && isLastNapOfDay && bedtime
    ? computeNapBudget({
        activeNap: activeSleep,
        todaySleeps: todaySleepEntries,
        trendSleeps: ctx.trendSleeps ?? ctx.recentSleeps,
        bedtime,
        isLastNapOfDay,
        optedIn: napBudgetOptedIn,
        learnedNapDurationMin: learnedNapDurMin,
        priorState: priorNapBudgetState,
        now,
        ctx,
      })
    : null;
  rescueNap = arbitrateRescueAgainstNapBudget(rescueNap, napBudget);

  // ── expectedWakeRange — uncertainty around the prediction, orthogonal
  //    to napBudget/rescue arbitration (per Codex review §"expectedWakeRange").
  const expectedWakeRange = activeSleep
    ? computeWakeRange(
        activeSleep.type === "night" ? expectedNightEnd : expectedNapEnd,
        activeSleep.type === "night" ? "night" : "nap",
        ctx.ageMonths,
        ctx.recentSleeps,
      )
    : null;

  return {
    predictedNaps, nextNap, napSkipped, napsAllDone, skippedNap, postSkipPlan,
    expectedNapEnd, expectedNightEnd, rescueNap, napBudget, continuationWindow,
    expectedWakeRange,
  };
}

function buildContext(
  baby: Baby,
  recentSleeps: SleepEntry[],
  now: number,
  extendedSleeps?: SleepEntry[],
  trendSleeps?: SleepEntry[],
  offDays?: Set<string>,
  priorTrendTargetState?: TrendTargetState | null,
): BabyContext {
  const tz = baby.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Compute the blended trend once and thread it through ctx — the censor
  // (cap-respect carve-out) and the napBudget engine both consume the
  // same number, so they can't disagree on what "near trend" means.
  const trendTotalMin = computeTrendTotalMin(
    trendSleeps ?? extendedSleeps ?? recentSleeps,
    {
      birthdate: baby.birthdate,
      ageMonths: calculateAgeMonths(baby.birthdate, new Date(now)),
      tz,
      customNapCount: baby.custom_nap_count ?? null,
      recentSleeps,
      offDays,
    },
    now,
  );
  return {
    birthdate: baby.birthdate,
    ageMonths: calculateAgeMonths(baby.birthdate, new Date(now)),
    tz,
    customNapCount: baby.custom_nap_count ?? null,
    targetBedtime: baby.target_bedtime ?? null,
    recentSleeps,
    extendedSleeps,
    trendSleeps,
    offDays,
    trendTotalMin,
    priorTrendTargetState: priorTrendTargetState ?? null,
  };
}

/** Pure state assembly — takes fetched data, returns the API response shape. */
export function assembleState(data: DayData) {
  const { baby, activeSleep, todaySleeps, recentSleeps, todayWakeUp, pausesBySleep } = data;

  // Calculate predictions even during active sleep so ghost arcs stay visible
  const now = data.now ?? Date.now();

  const recentEntries = recentSleeps.map(toSleepEntry);
  // Determine strategy (use extended lookback for hysteresis when available).
  // The same extended window also feeds the cut-short censor's self-wake
  // median so it can fire even when the 7-day window has < 3 self-wakes.
  //
  // strategySleeps is the 30d window now (consolidated with the trend
  // fetch), but `determineStrategy`'s 6-day replay is calibrated on 21d.
  // Slice back to the original 21d window so older history doesn't flip
  // a recently-transitioning baby from emerging_rhythm to routine_schedule.
  const STRATEGY_LOOKBACK_DAYS = 21;
  const strategyCutoffMs = now - STRATEGY_LOOKBACK_DAYS * 86400_000;
  const rawStrategySleeps = data.strategySleeps ?? recentSleeps;
  const strategyEntries = rawStrategySleeps
    .filter((s) => new Date(s.start_time).getTime() >= strategyCutoffMs)
    .map(toSleepEntry);
  // Trend window for napBudget — prefer the 30-day fetch when present, then
  // fall back to whatever wider data we have. The helper itself gates on
  // ≥7 days of complete data.
  const trendEntries = (data.trendSleeps ?? data.strategySleeps ?? recentSleeps).map(toSleepEntry);
  const ctx = buildContext(
    baby, recentEntries, now, strategyEntries, trendEntries, data.offDays,
    data.priorTrendTargetState ?? null,
  );

  const todaySleepsWithPauses = todaySleeps.map((s) => ({
    ...toSleepEntry(s),
    pauses: pausesBySleep.get(s.id) || [],
  }));
  const stats = getTodayStats(todaySleepsWithPauses);

  // Sleep-day totals (wake-to-wake): adds the prior overnight's duration so
  // surfaces that read "Søvn i dag" don't silently drop the morning night.
  // See the 2026-05-20 user report — "ho hadde langt over 10t59min nattesøvn
  // i dag" — caused by the calendar-midnight cutoff in todaySleeps.
  const priorOvernight = data.priorOvernightSleep;
  const priorOvernightEntry: SleepEntry | null = priorOvernight
    ? { ...toSleepEntry(priorOvernight), pauses: pausesBySleep.get(priorOvernight.id) || [] }
    : null;
  const dayTotals = getSleepDayTotals(todaySleepsWithPauses, priorOvernightEntry);

  const strategy = determineStrategy(strategyEntries, baby.birthdate, ctx.tz, now);
  ctx.strategy = strategy;

  let prediction: Prediction | null = null;
  if (strategy === "newborn_guidance") {
    prediction = assembleNewbornPrediction(ctx, recentEntries, todaySleeps, now);
  } else if (strategy === "emerging_rhythm") {
    prediction = assembleEmergingPrediction(
      ctx, recentEntries, todaySleeps, activeSleep, todayWakeUp, now,
      data.napBudgetOptedIn ?? true,
      data.priorNapBudgetState ?? null,
    );
  } else {
    prediction = assembleSchedulePrediction(
      strategy, ctx, todaySleeps, activeSleep, todayWakeUp, now,
      data.napBudgetOptedIn ?? true,
      data.priorNapBudgetState ?? null,
    );
  }

  return {
    baby,
    activeSleep,
    todaySleeps,
    stats,
    /**
     * Wake-to-wake totals. Same nap + today-night numbers as `stats`, plus
     * the previous overnight's duration. Use this for daily-total UI
     * (`Søvn i dag`), not `stats`. `stats` stays unchanged for engine and
     * legacy consumers.
     */
    dayTotals,
    /**
     * The completed overnight that ended this morning (start_time before
     * midnight, end_time today), or null. Surfaces an actual "last night"
     * row on Heim without requiring the UI to re-query.
     */
    priorOvernightSleep: priorOvernight ?? null,
    prediction,
    ageMonths: ctx.ageMonths,
    diaperCount: data.diaperCount,
    lastDiaperTime: data.lastDiaperTime,
    todayWakeUp,
    // Off-day local-date keys so the wakeup / sleep-start / log surfaces
    // can display + toggle the flag for any date they're operating on,
    // not just today. Array (not Set) for JSON serializability.
    offDays: data.offDays ? [...data.offDays] : [],
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
    feasible: true,
    // Schedule fields — null for newborn
    nextNap: null,
    bedtime: null,
    predictedNaps: null,
    expectedNapCount: 0,
    napsAllDone: false,
    expectedNapEnd: null,
    expectedNightEnd: null,
    expectedWakeRange: null,
    skippedNap: null,
    postSkipPlan: null,
    confidence: null,
    calibration: null,
    rescueNap: null,
    continuationWindow: null,
    napBudget: null,
    dailyTrendTotalMin: null,
    trendTargets: null,
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
  napBudgetOptedIn: boolean,
  priorNapBudgetState: { mode: "first-contact" | "established"; enteredAt: string } | null,
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
  // Don't count cut-short naps toward the day's budget — see schedule branch.
  const cycleMin = estimateSleepCycleFromData(ctx);
  const shortThreshold = computeShortNapThreshold(getLearnedNapDuration(ctx), cycleMin);
  const consumedNaps = countSufficientNaps(completedNaps, shortThreshold, activeSleep?.type === "nap");
  const expectedNapCount = resolveNapCount(ctx);
  const lastCutShort = mostRecentCutShort(completedNaps, shortThreshold);

  // ── Select best plan (natural vs target-guided, scored) ──
  // Gate on a real wake_time — a marker-only day_start (off-day flagged
  // before any real wake) carries no wake instant to plan against.
  const selected = todayWakeUp?.wake_time
    ? selectBestPlan(todayWakeUp.wake_time, todaySleeps.map(toSleepEntry), activeSleep, ctx, now, { dayStart: true })
    : null;

  let remaining = selected ? selected.naps.slice(consumedNaps) : [] as PredictedNap[];

  let bedtime: string | null = selected?.bedtime ?? null;
  if (remaining.length > 0 && wakeTimeForPrediction) {
    const actualWakeMs = new Date(wakeTimeForPrediction).getTime();
    if (actualWakeMs > new Date(remaining[0].startTime).getTime() || lastCutShort) {
      const adjusted = selectBestPlan(
        wakeTimeForPrediction, todaySleeps.map(toSleepEntry), activeSleep,
        { ...ctx, customNapCount: remaining.length }, now,
      );
      remaining = adjusted.naps;
      bedtime = adjusted.bedtime;
    }
  }

  // Borbély 2-process compression on the comeback nap — see schedule branch.
  if (lastCutShort && remaining.length > 0) {
    remaining = [compressComebackNap(remaining[0], lastCutShort), ...remaining.slice(1)];
  }

  // Emerging may have no bedtime when selectBestPlan didn't return one;
  // derivePostPlanFields assumes a string. Fall back to `now` as a
  // last-resort anchor — the predictedNaps filter will then drop all
  // naps and napsAllDone will fire via collapsedToBedtime, which is the
  // right behaviour when we have no plan to project against.
  const bedtimeForDerivation: string = bedtime ?? new Date(now).toISOString();
  const todaySleepEntries = todaySleeps.map(toSleepEntry);
  const post = derivePostPlanFields({
    ctx,
    todaySleeps,
    todaySleepEntries,
    completedNaps,
    activeSleep,
    cycleMin,
    shortThreshold,
    consumedNaps,
    expectedNapCount,
    lastCutShort,
    remaining,
    bedtime: bedtimeForDerivation,
    fallbackNextNap: result.nextNap,
    now,
    napBudgetOptedIn,
    priorNapBudgetState,
  });

  const trendTargets = computeTrendTargets(
    ctx.trendSleeps ?? ctx.recentSleeps, ctx, now, ctx.priorTrendTargetState,
  );

  return {
    strategy: "emerging_rhythm",
    feasible: true,
    nextNap: post.nextNap,
    bedtime,
    predictedNaps: post.predictedNaps,
    expectedNapCount,
    napsAllDone: post.napsAllDone,
    expectedNapEnd: post.expectedNapEnd,
    expectedNightEnd: post.expectedNightEnd,
    expectedWakeRange: post.expectedWakeRange,
    skippedNap: post.skippedNap,
    postSkipPlan: post.postSkipPlan,
    confidence: null,
    calibration: null,
    rescueNap: post.rescueNap,
    continuationWindow: post.continuationWindow,
    napBudget: post.napBudget,
    dailyTrendTotalMin: trendTargets?.observedRecentMin ?? null,
    trendTargets,
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
    // Expose learned schedule values even in emerging — the stats page's
    // norm-vs-baby table reads from this and was showing "—" everywhere
    // for emerging babies (and the parent had no way to see the numbers
    // the engine had learned). The same helpers the schedule path uses
    // are pure functions over ctx; they don't require the strategy to
    // be `routine_schedule`.
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

/** Assemble a schedule-based prediction (routine_schedule). */
function assembleSchedulePrediction(
  strategy: Strategy,
  ctx: BabyContext,
  todaySleeps: SleepLogRow[],
  activeSleep: SleepLogRow | undefined,
  todayWakeUp: DayStartRow | undefined,
  now: number,
  napBudgetOptedIn: boolean,
  priorNapBudgetState: { mode: "first-contact" | "established"; enteredAt: string } | null,
): Prediction | null {
  const lastCompleted = todaySleeps.find((s) => s.end_time);
  const wakeTimeForPrediction = lastCompleted?.end_time || todayWakeUp?.wake_time;

  if (!wakeTimeForPrediction) return null;

  const completedNaps = todaySleeps.filter((s) => s.type === "nap" && s.end_time);
  // Cut-short naps don't fulfill the day's nap budget. A 28-min car nap when
  // the learned duration is ~120 min leaves a sleep deficit, so count only
  // naps that crossed the short-nap threshold and let the engine plan another.
  const cycleMin = estimateSleepCycleFromData(ctx);
  const shortThreshold = computeShortNapThreshold(getLearnedNapDuration(ctx), cycleMin);
  const consumedNaps = countSufficientNaps(completedNaps, shortThreshold, activeSleep?.type === "nap");
  const expectedNapCount = resolveNapCount(ctx);
  const lastCutShort = mostRecentCutShort(completedNaps, shortThreshold);

  // ── Select best plan (natural vs target-guided, scored) ──
  // See emerging branch — `wake_time` may be null for marker-only off-day rows.
  const selected = todayWakeUp?.wake_time
    ? selectBestPlan(todayWakeUp.wake_time, todaySleeps.map(toSleepEntry), activeSleep, ctx, now, { dayStart: true })
    : null;
  const allPredictedFromWakeUp = selected?.naps ?? [];

  let remaining = allPredictedFromWakeUp.slice(consumedNaps);

  // Stale check: re-select on the last actual wake when (a) the original
  // plan's first nap is in the past, or (b) we're recovering from a cut-short
  // — its prior wake-time anchor is wrong now that the day's nap budget needs
  // re-planning around the deficit.
  let bedtime = selected?.bedtime ?? new Date(now).toISOString();
  if (remaining.length > 0) {
    const actualWakeMs = new Date(wakeTimeForPrediction).getTime();
    if (actualWakeMs > new Date(remaining[0].startTime).getTime() || lastCutShort) {
      const adjusted = selectBestPlan(
        wakeTimeForPrediction, todaySleeps.map(toSleepEntry), activeSleep,
        { ...ctx, customNapCount: remaining.length }, now,
      );
      remaining = adjusted.naps;
      bedtime = adjusted.bedtime;
    }
  }

  // Borbély 2-process model: a cut-short discharges sleep pressure non-linearly
  // (most slow-wave activity dissipates in the first cycle). Compress the next
  // wake window by an SWA-weighted factor so the comeback nap lands earlier
  // than a normal first-nap-of-the-day would, but not too aggressively.
  if (lastCutShort && remaining.length > 0) {
    remaining = [compressComebackNap(remaining[0], lastCutShort), ...remaining.slice(1)];
  }

  const todaySleepEntries = todaySleeps.map(toSleepEntry);
  const post = derivePostPlanFields({
    ctx,
    todaySleeps,
    todaySleepEntries,
    completedNaps,
    activeSleep,
    cycleMin,
    shortThreshold,
    consumedNaps,
    expectedNapCount,
    lastCutShort,
    remaining,
    bedtime,
    fallbackNextNap: predictNextNap(wakeTimeForPrediction, ctx),
    now,
    napBudgetOptedIn,
    priorNapBudgetState,
  });

  // Confidence aligns with the visible nap list — napRanges[i] corresponds
  // to predictedNaps[i], so the Timer's `napRanges[0]` read is the *next*
  // nap's SD even after some naps are done. Passing [] still returns a
  // bedtime range, which Timer uses for bedtime / after-bedtime modes.
  const confidence = computeConfidence(post.predictedNaps ?? [], bedtime, ctx.ageMonths, ctx.recentSleeps, ctx.tz);
  const calibration = calibrate(ctx.ageMonths, ctx.recentSleeps, ctx.customNapCount, ctx.tz);
  const trendTargets = computeTrendTargets(
    ctx.trendSleeps ?? ctx.recentSleeps, ctx, now, ctx.priorTrendTargetState,
  );

  return {
    strategy,
    feasible: selected?.feasible ?? true,
    nextNap: post.nextNap,
    bedtime,
    predictedNaps: post.predictedNaps,
    expectedNapCount,
    napsAllDone: post.napsAllDone,
    expectedNapEnd: post.expectedNapEnd,
    expectedNightEnd: post.expectedNightEnd,
    expectedWakeRange: post.expectedWakeRange,
    skippedNap: post.skippedNap,
    postSkipPlan: post.postSkipPlan,
    confidence,
    calibration,
    rescueNap: post.rescueNap,
    continuationWindow: post.continuationWindow,
    napBudget: post.napBudget,
    dailyTrendTotalMin: trendTargets?.observedRecentMin ?? null,
    trendTargets,
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
