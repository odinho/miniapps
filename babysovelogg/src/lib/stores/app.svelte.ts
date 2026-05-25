import type { Baby, SleepLogRow, DayStartRow, NightWakingRow } from "$lib/types.js";
import type { DayStats, SleepDayTotals } from "$lib/engine/stats.js";
import type { PredictedNap } from "$lib/engine/schedule.js";
import type { ConfidenceResult, PredictionRange } from "$lib/engine/confidence.js";
import type { CalibrationReport } from "$lib/engine/calibration.js";
import type { Strategy } from "$lib/engine/strategy.js";
import type { RollingSleepStats, AgeNorms } from "$lib/engine/features.js";
import type { TrendTargets } from "$lib/engine/trend.js";

export interface Prediction {
	/** Which prediction strategy produced this result */
	strategy: Strategy;
	/** False when the selected plan violates a hard constraint (e.g. target bedtime unreachable today) */
	feasible: boolean;
	// ── Schedule fields (routine_schedule, partially used by emerging_rhythm) ──
	nextNap: string | null;
	bedtime: string | null;
	predictedNaps: PredictedNap[] | null;
	/** Total expected naps for today (from learned data / custom override / age default) */
	expectedNapCount: number;
	napsAllDone: boolean;
	/** Expected end time for the current active nap (null when not napping) */
	expectedNapEnd: string | null;
	/** Expected end time for the current active night sleep (null when not in night sleep) */
	expectedNightEnd: string | null;
	/**
	 * Range around the active sleep's predicted wake time (lo/hi ≈ ±1 SD of the
	 * relevant duration). null when no active sleep or no point estimate.
	 */
	expectedWakeRange: PredictionRange | null;
	/**
	 * A planned nap that was missed: the engine predicted a nap at this time and
	 * the window passed (>60 min overdue, no active sleep). Populated *in
	 * addition to* the existing napsAllDone path so the UI can preserve the
	 * day's narrative ("Hoppa over lur kl. 09:53") instead of silently swapping
	 * to bedtime mode. Null when no nap was skipped today.
	 */
	skippedNap: { plannedAt: string } | null;
	/**
	 * What the engine recommends when a nap is skipped. `rescue` means there's
	 * still room for a power nap before bedtime; `earlier-bedtime` means it's
	 * too late and the sleep deficit should be paid down with an earlier night
	 * sleep. Null when no nap is skipped (or when the day's plan is intact).
	 */
	postSkipPlan: PostSkipPlan | null;
	/** Confidence intervals for nap/bedtime predictions (null when no data) */
	confidence: ConfidenceResult | null;
	/** Calibration report: what's learned vs age-default */
	calibration: CalibrationReport | null;
	// ── Newborn/emerging fields ─────────────────────────────────────────────
	/** Sleep window: when the next sleep is likely to start (newborn/emerging) */
	sleepWindow: { earliest: string; latest: string } | null;
	/** Current sleep pressure level (newborn/emerging) */
	sleepPressure: "low" | "rising" | "high" | null;
	/** Total sleep in last 24h (minutes) */
	totalSleep24h: number | null;
	/** Longest single stretch in recent data (minutes) */
	longestStretch: number | null;
	/** Longest stretch trend (week over week) */
	longestStretchTrend: "growing" | "stable" | "shrinking" | null;
	/** Longest stretch weekly averages for detailed display (minutes) */
	longestStretchDetail: { currentWeekAvg: number; priorWeekAvg: number } | null;
	/** Age-appropriate norms for context display */
	ageNorms: AgeNorms | null;
	/** Rolling 24h stats for context card */
	rolling: RollingSleepStats | null;
	/** Learned schedule parameters (routine_schedule) */
	learnedSchedule: LearnedSchedule | null;
	/** Rescue nap guidance (when active nap is extra or after a short nap) */
	rescueNap: { recommendedWakeTime: string; reason: "extra_nap" | "short_prior_nap" | "both" } | null;
	/**
	 * Continuation-nap window: a short period right after a cut-short during
	 * which residual sleep pressure is still high enough to re-induce sleep.
	 * If null, no continuation attempt is currently recommended (window closed,
	 * baby is napping, or no recent cut-short).
	 */
	continuationWindow: {
		/** ISO — try to put baby back to sleep before this; window closes here. */
		closesAt: string;
		/** ISO — if she falls asleep, wake by this so the day's plan stays workable. */
		capLatestEnd: string;
	} | null;
	/**
	 * Trend-anchored wake-by recommendation for the *active* nap, when today's
	 * accumulated sleep is on track to exceed the parent's blended 7d/30d trend.
	 * Goal: stop the long-nap → next-day-skip pingpong by recommending a
	 * gentle cap. Emitted only when:
	 *   - There is an active nap (not a night sleep)
	 *   - It's the day's last expected nap (1-nap babies always; multi-nap
	 *     babies only on their final nap)
	 *   - The active nap has been running ≥20 min (don't propose for a
	 *     just-fell-asleep nap)
	 *   - Trend data is stable enough (≥7 days complete data; stdev/mean OK)
	 *   - Projected total exceeds trend by more than the tolerance
	 *   - The baby has opt-in (`nap_cap_advice` setting, default on)
	 *
	 * Evidence base: Nakagawa 2016, Akacem 2015 (long nap → night-sleep loss);
	 * Lassonde 2016 (missed nap SWA recouped at night); Brooks & Lack 2006
	 * + Mednick 2003 (N2 alone restores; 20-30 min nap is biologically real).
	 * See docs/sleep-science-research.md §12.
	 */
	napBudget: NapBudget | null;
	/**
	 * Blended 7d/30d daily-total trend (minutes), age-norm clamped. Same
	 * number the napBudget feature uses to decide whether to cap. Surfaced
	 * to UI for the stats comparison table's "Trendmål" row so parents see
	 * the engine's real target alongside age-norm and learned-typical
	 * totals. Null when trend data is too sparse (<7 complete days) or too
	 * noisy (stdev/mean above threshold).
	 */
	dailyTrendTotalMin: number | null;
	/**
	 * Both observed-recent and held-intervention trend numbers, plus
	 * diagnostics, plus the next state to persist. Null when trend data
	 * is too sparse or noisy. New shape for the 2026-05-20 split — see
	 * `local/codex-trend-split-design.md`. UI should prefer reading
	 * `observedRecentMin` for stats and `interventionTargetMin` for any
	 * "target / mål" copy. `dailyTrendTotalMin` is preserved for one
	 * release as a backward-compat alias of `observedRecentMin`.
	 */
	trendTargets: TrendTargets | null;
}

export interface NapBudget {
	/** Recommended wake time for the active nap (ISO). The cap. */
	wakeBy: string;
	/** Duration in minutes from nap start to wakeBy. */
	recommendedDurationMin: number;
	/** Why the cap fires. v1 only emits over_trend. */
	reason: "over_trend";
	/**
	 * "first-contact" = full cycle cap, gentle introduction (default).
	 * "established"   = sub-cycle cap with lead-time buffer; fires once the
	 *                   7d trend has dropped meaningfully below the 30d trend,
	 *                   indicating the parent has been actively capping naps
	 *                   for ~a week. The cap math is more precise here,
	 *                   may land mid-cycle (parent has practice waking).
	 */
	mode: "first-contact" | "established";
	/**
	 * Urgency. `advisory` = in-app only; `firm` = also schedules a push
	 * notification 5 min before wakeBy. Promotion to `firm` happens when
	 * projected overshoot exceeds `context.toleranceMin`.
	 */
	urgency: "advisory" | "firm";
	/** Context for the UI explainer popover. */
	context: {
		/** The blended 7d/30d daily-total target in minutes, clamped to age-norm. */
		blendedTrendMin: number;
		/** Sleep already banked today (night + completed naps), in minutes. */
		bankedMin: number;
		/** ±tolerance before advisory becomes firm (v1 = 20). */
		toleranceMin: number;
		/** Short label describing the target source ('7d/30d blend', 'age norm', …). */
		sourceLabel: string;
	};
	/**
	 * Set when the engine aligned the cap to a cycle boundary for a softer
	 * wake. `boundaryAtMin` is the final cap (= recommendedDurationMin);
	 * `nudgedFromMin` is the raw `napBudgetMin` before alignment. In
	 * first-contact mode this can extend *past* the raw budget — when even
	 * one cycle wouldn't fit under the budget, the engine still recommends
	 * one cycle (gentle easing trumps strict trend math). Null in
	 * established mode and when the bedtime guard re-tightened the cap.
	 * See sleep-science-research.md §12.
	 */
	cycleNudge: { boundaryAtMin: number; nudgedFromMin: number } | null;
}

export type PostSkipPlan =
	| {
			kind: "rescue";
			/** One concrete action: put baby down around this time (ISO). */
			recommendedStart: string;
			/** Latest acceptable start for parents who need flexibility (ISO). */
			latestStart: string;
			/**
			 * Wake by this time so the rescue stays a *rescue* (≤ RESCUE_NAP cap)
			 * and the pre-bedtime wake window is preserved.
			 */
			wakeBy: string;
	  }
	| {
			kind: "earlier-bedtime";
			/** Suggested bedtime, earlier than the day's planned bedtime (ISO). */
			suggestedBedtime: string;
			/** How many minutes earlier than the planned bedtime. */
			minutesEarlier: number;
	  };

export interface LearnedSchedule {
	/** Learned average nap duration in minutes */
	napDurationMin: number;
	/** Learned average night duration in minutes */
	nightDurationMin: number;
	/** Learned wake window in minutes */
	wakeWindowMin: number;
	/** Learned bedtime wake window in minutes */
	bedtimeWakeWindowMin: number;
	/** Expected nap count */
	expectedNapCount: number;
	/** Estimated sleep cycle length in minutes (from data or age default).
	 *  Legacy scalar — new code should read `sleepCycle.minutes` plus
	 *  `sleepCycle.source`/`confidence` so UI hedging is accurate. */
	sleepCycleMin: number;
	/** Full sleep-cycle estimate: minutes + source + confidence band +
	 *  diagnostics. Drives whether UI labels claim "lærte syklus" vs
	 *  "typisk for alder". See `estimateSleepCycleDetails` in
	 *  `src/lib/engine/schedule.ts`. */
	sleepCycle: import("$lib/types.js").SleepCycleEstimate;
}

export interface AppState {
	baby: Baby | null;
	activeSleep: SleepLogRow | null;
	todaySleeps: SleepLogRow[];
	stats: DayStats | null;
	/**
	 * Wake-to-wake "sleep day" totals: nap + today-night + the morning overnight.
	 * Use this for daily-total UI ("Søvn i dag"). `stats` stays unchanged for
	 * engine and legacy consumers — it omits the morning night.
	 */
	dayTotals: SleepDayTotals | null;
	/**
	 * The completed overnight that ended this morning (start_time before
	 * midnight, end_time today), or null. Surfaced so Heim can show
	 * "Natt (i går → i dag) XtYm" without re-querying.
	 */
	priorOvernightSleep: SleepLogRow | null;
	prediction: Prediction | null;
	ageMonths: number;
	diaperCount: number;
	lastDiaperTime: string | null;
	todayWakeUp: DayStartRow | null;
	/**
	 * Local-date keys (YYYY-MM-DD in baby tz) currently flagged as
	 * off-days. Consumed by WakeUpSheet / TagSheet / history to show
	 * current state next to their per-date toggle.
	 */
	offDays: string[];
	/**
	 * Night wakings within today's sleeps (or the active night sleep).
	 * Rendered as red intervals on the arc and as edit-able sub-rows
	 * in history. Empty when no wakings have been logged. See
	 * docs/pause-redesign-2026-05-22.md.
	 */
	todayNightWakings: NightWakingRow[];
}

const emptyState: AppState = {
	baby: null,
	activeSleep: null,
	todaySleeps: [],
	stats: null,
	dayTotals: null,
	priorOvernightSleep: null,
	prediction: null,
	ageMonths: 0,
	diaperCount: 0,
	lastDiaperTime: null,
	todayWakeUp: null,
	offDays: [],
	todayNightWakings: [],
};

/** Reactive app state — the single source of truth for the UI. */
function createAppState() {
	let state = $state<AppState>({ ...emptyState });
	let loaded = $state(false);
	let error = $state<string | null>(null);

	return {
		/** The current app state. Reactive. */
		get state() {
			return state;
		},
		/** Whether initial state has been loaded from the server. */
		get loaded() {
			return loaded;
		},
		/** Last error message, if any. */
		get error() {
			return error;
		},

		/** Replace the entire state (used on initial load and SSE updates). */
		set(newState: AppState) {
			state = newState;
			loaded = true;
			error = null;
		},

		/** Set an error message. */
		setError(msg: string) {
			error = msg;
		},

		/** Reset to empty state. */
		reset() {
			state = { ...emptyState };
			loaded = false;
			error = null;
		},
	};
}

export const appState = createAppState();
