// Builds the full prop set the `Arc` component needs from a single baby's
// state. Extracted from the inline `arc*` deriveds in the single-baby
// dashboard (`routes/+page.svelte`) so the multi-baby family view can render
// the same round graph per child instead of the flat handoff bars.
//
// Pure + per-baby: night/day, cold-start nudge-stripping, and every endpoint
// anchor are derived from the passed `BabyState` alone (the single-baby page
// used a page-global `isNightMode`/`displayPrediction`; here each lane gets its
// own, so two children in different day/night phases each read correctly).
import type { BabyState } from './stores/app.svelte.js';
import { formatTime } from './utils.js';

export interface ArcProps {
	isNightMode: boolean;
	todaySleeps: Array<{ start_time: string; end_time: string | null; type: 'nap' | 'night' }>;
	activeSleep: { start_time: string; type: 'nap' | 'night' } | null;
	prediction: { nextNap: string; bedtime?: string; predictedNaps?: Array<{ startTime: string; endTime: string }> } | null;
	wakeUpTime: string | null;
	bedtime: string | null;
	nightEnd: string | null;
	startTimeLabel: string | null;
	endTimeLabel: string | null;
	napConfidenceBands: Array<{ lo: string; hi: string }>;
	activeWakeAt: string | null;
	activeWakeBand: { lo: string; hi: string } | null;
	skippedNap: { plannedAt: string } | null;
	rescueWindow: { earliest: string; latest: string } | null;
	nightWakings: Array<{ startTime: string; endTime: string | null; domainId: string }>;
}

/** Day/night for one baby. Night while an active night sleep runs (even past
 *  06:00); day once a wake-up is logged today; else fall back to the clock. */
export function computeIsNightMode(b: BabyState, nowMs: number): boolean {
	const { activeSleep, todayWakeUp } = b;
	if (activeSleep && !activeSleep.end_time && activeSleep.type === 'night') return true;
	if (todayWakeUp) return false;
	const h = new Date(nowMs).getHours();
	return h < 6 || h >= 18;
}

export function buildArcProps(b: BabyState, nowMs: number): ArcProps {
	const { baby, activeSleep, todaySleeps, prediction, todayWakeUp, todayNightWakings, priorOvernightSleep } = b;

	const isNightMode = computeIsNightMode(b, nowMs);
	const strategy = prediction?.strategy ?? 'routine_schedule';
	const isNewborn = strategy === 'newborn_guidance';

	// Cold start: no real sleep signal yet. Hide the data-hungry nudges
	// (skip/rescue/budget/continuation) so a fresh baby gets the plain arc +
	// next-nap guess instead of presumptuous corrections.
	const hasAnySleepHistory =
		!!prediction?.calibration ||
		(prediction?.longestStretch ?? 0) > 0 ||
		(prediction?.totalSleep24h ?? 0) > 0 ||
		!!priorOvernightSleep ||
		(todaySleeps?.length ?? 0) > 0;
	const isColdStart = !!baby && !hasAnySleepHistory && !(activeSleep && !activeSleep.end_time);
	const displayPrediction =
		isColdStart && prediction
			? { ...prediction, skippedNap: null, postSkipPlan: null, rescueNap: null, napBudget: null, continuationWindow: null }
			: prediction;

	const arcSleeps = todaySleeps.map((sl) => ({
		start_time: sl.start_time,
		end_time: sl.end_time,
		type: sl.type as 'nap' | 'night',
	}));

	const arcActiveSleep =
		activeSleep && !activeSleep.end_time
			? { start_time: activeSleep.start_time, type: activeSleep.type as 'nap' | 'night' }
			: null;

	const arcPrediction = prediction?.nextNap
		? {
				nextNap: prediction.nextNap,
				bedtime: prediction.bedtime ?? undefined,
				predictedNaps: prediction.predictedNaps ?? undefined,
			}
		: null;

	const napConfidenceBands =
		prediction?.confidence?.napRanges.map((nr) => ({ lo: nr.startRange.lo, hi: nr.startRange.hi })) ?? [];

	const nightWakings = todayNightWakings.map((w) => ({
		startTime: w.start_time,
		endTime: w.end_time,
		domainId: w.domain_id,
	}));

	// Active-sleep progress meter. A cap (napBudget / rescue) overrides the
	// natural expected wake so the arc marker and any banner agree; the ±1 SD
	// band only makes sense around a *predicted* wake, so it's hidden when a
	// cap is in play.
	let activeWakeOverride: string | null = null;
	if (arcActiveSleep && displayPrediction) {
		if (arcActiveSleep.type === 'nap' && displayPrediction.napBudget?.wakeBy) {
			activeWakeOverride = displayPrediction.napBudget.wakeBy;
		} else if (displayPrediction.rescueNap?.recommendedWakeTime) {
			activeWakeOverride = displayPrediction.rescueNap.recommendedWakeTime;
		}
	}

	let activeWakeAt: string | null = null;
	if (arcActiveSleep && prediction) {
		if (activeWakeOverride) activeWakeAt = activeWakeOverride;
		else if (prediction.expectedWakeRange) activeWakeAt = prediction.expectedWakeRange.point;
		else activeWakeAt = arcActiveSleep.type === 'night' ? prediction.expectedNightEnd : prediction.expectedNapEnd;
	}

	const activeWakeBand =
		arcActiveSleep && prediction?.expectedWakeRange && !activeWakeOverride
			? { lo: prediction.expectedWakeRange.lo, hi: prediction.expectedWakeRange.hi }
			: null;

	const skippedNap = displayPrediction?.skippedNap ?? null;
	const rescueWindow =
		displayPrediction?.postSkipPlan?.kind === 'rescue'
			? { earliest: displayPrediction.postSkipPlan.recommendedStart, latest: displayPrediction.postSkipPlan.wakeBy }
			: null;

	// Endpoint ISO anchors double as displayed labels AND the time→fraction
	// window. Day arcs end at predicted bedtime; night arcs start at the logged
	// (or predicted) bedtime and end at expected night-end.
	let bedtime: string | null;
	if (isNightMode) {
		const nightSleep =
			activeSleep?.type === 'night' ? activeSleep : todaySleeps.toReversed().find((sl) => sl.type === 'night');
		bedtime = nightSleep ? nightSleep.start_time : prediction?.bedtime ?? null;
	} else {
		bedtime = isNewborn ? null : prediction?.bedtime ?? null;
	}

	const nightEnd = isNightMode ? prediction?.expectedNightEnd ?? null : null;

	let startTimeLabel: string | null;
	if (isNightMode) {
		// Only label a night start when there's a logged sleep — a predicted
		// bedtime shouldn't impersonate "this is when she went to bed".
		const nightSleep =
			activeSleep?.type === 'night' ? activeSleep : todaySleeps.toReversed().find((sl) => sl.type === 'night');
		startTimeLabel = nightSleep ? formatTime(nightSleep.start_time) : null;
	} else {
		startTimeLabel = todayWakeUp?.wake_time ? formatTime(todayWakeUp.wake_time) : null;
	}

	let endTimeLabel: string | null;
	if (isNightMode) {
		endTimeLabel = prediction?.expectedNightEnd ? formatTime(prediction.expectedNightEnd) : null;
	} else {
		endTimeLabel = isNewborn ? null : prediction?.bedtime ? formatTime(prediction.bedtime) : null;
	}

	return {
		isNightMode,
		todaySleeps: arcSleeps,
		activeSleep: arcActiveSleep,
		prediction: arcPrediction,
		wakeUpTime: todayWakeUp?.wake_time ?? null,
		bedtime,
		nightEnd,
		startTimeLabel,
		endTimeLabel,
		napConfidenceBands,
		activeWakeAt,
		activeWakeBand,
		skippedNap,
		rescueWindow,
		nightWakings,
	};
}
