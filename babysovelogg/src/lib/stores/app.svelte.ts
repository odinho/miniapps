import type { Baby, SleepLogRow, DayStartRow } from "$lib/types.js";
import type { DayStats } from "$lib/engine/stats.js";
import type { PredictedNap } from "$lib/engine/schedule.js";
import type { ConfidenceResult } from "$lib/engine/confidence.js";
import type { CalibrationReport } from "$lib/engine/calibration.js";
import type { Strategy } from "$lib/engine/strategy.js";
import type { RollingSleepStats, AgeNorms } from "$lib/engine/features.js";

export interface Prediction {
	/** Which prediction strategy produced this result */
	strategy: Strategy;
	// ── Schedule fields (routine_schedule, partially used by emerging_rhythm) ──
	nextNap: string | null;
	bedtime: string | null;
	predictedNaps: PredictedNap[] | null;
	napsAllDone: boolean;
	/** Expected end time for the current active nap (null when not napping) */
	expectedNapEnd: string | null;
	/** Expected end time for the current active night sleep (null when not in night sleep) */
	expectedNightEnd: string | null;
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
	/** Age-appropriate norms for context display */
	ageNorms: AgeNorms | null;
	/** Rolling 24h stats for context card */
	rolling: RollingSleepStats | null;
}

export interface AppState {
	baby: Baby | null;
	activeSleep: SleepLogRow | null;
	todaySleeps: SleepLogRow[];
	stats: DayStats | null;
	prediction: Prediction | null;
	ageMonths: number;
	diaperCount: number;
	lastDiaperTime: string | null;
	todayWakeUp: DayStartRow | null;
}

const emptyState: AppState = {
	baby: null,
	activeSleep: null,
	todaySleeps: [],
	stats: null,
	prediction: null,
	ageMonths: 0,
	diaperCount: 0,
	lastDiaperTime: null,
	todayWakeUp: null,
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
