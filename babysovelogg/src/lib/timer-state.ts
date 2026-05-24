import type { SleepLogRow, NightWakingRow } from '$lib/types.js';
import type { Prediction, PostSkipPlan } from '$lib/stores/app.svelte.js';

export interface CyclePhase {
	/** Current cycle number (1-based) */
	cycle: number;
	/** Minutes into current cycle */
	minutesIntoCycle: number;
	/** Minutes until next light phase (cycle boundary) */
	minutesToNextLight: number;
	/** Whether baby is likely in light sleep (near cycle boundary) */
	isLightPhase: boolean;
}

/** Compute sleep cycle phase using the baby's estimated cycle length. */
function computeCyclePhase(elapsedMs: number, cycleMin: number): CyclePhase {
	const LIGHT_WINDOW = 8; // light sleep ±8 min around cycle boundary
	const elapsedMin = elapsedMs / 60_000;
	const cycle = Math.floor(elapsedMin / cycleMin) + 1;
	const minutesIntoCycle = elapsedMin % cycleMin;
	const minutesToNextLight = cycleMin - minutesIntoCycle;
	const isLightPhase = minutesIntoCycle < LIGHT_WINDOW || minutesToNextLight < LIGHT_WINDOW;
	return { cycle, minutesIntoCycle: Math.round(minutesIntoCycle), minutesToNextLight: Math.round(minutesToNextLight), isLightPhase };
}

export type TimerMode =
	| { kind: 'sleeping'; label: string; elapsed: number; startTime: string; expectedWake: string | null; expectedWakeCountdown: number | null; cyclePhase: CyclePhase | null }
	| { kind: 'deep-night'; wakeCountdown: number | null; wakeTime: string | null }
	| { kind: 'next-nap'; countdown: number }
	| { kind: 'overtime'; overtime: number }
	| { kind: 'bedtime'; countdown: number; bedtime: string }
	| {
			kind: 'after-bedtime';
			bedtime: string;
			/**
			 * Next ~50min sleep-cycle-aligned target after the planned bedtime.
			 * Parents who miss the original window often want to wait briefly
			 * and put the baby down at a cycle boundary instead of stewing on
			 * "bedtime was 18:00" — same N1→N2→cycle-boundary easy-onset
			 * mechanic the wake-recommendation logic leans on.
			 */
			nextCycleTarget: string | null;
			/** Cycle length (minutes) used to compute the target. */
			cycleMin: number;
	  }
	| { kind: 'sleep-window'; windowStart: number; windowEnd: number; pressure: 'low' | 'rising' | 'high' }
	| {
			kind: 'skipped-nap';
			plannedAt: string;
			plannedAgoMs: number;
			postSkipPlan: PostSkipPlan | null;
			/** Bedtime as already planned (for parents who want to fall back to "just bedtime"). */
			bedtime: string | null;
			bedtimeCountdown: number | null;
	  }
	| { kind: 'idle' };

export interface TimerInput {
	activeSleep: SleepLogRow | null;
	prediction: Prediction | null;
	todayWakeUp: { wake_time: string | null } | null;
	todaySleeps: SleepLogRow[];
	/** Today's night wakings — used to surface an "open" waking in the timer label. */
	todayNightWakings?: NightWakingRow[];
	now: number;
}

function formatHM(d: Date): string {
	const h = d.getHours().toString().padStart(2, '0');
	const m = d.getMinutes().toString().padStart(2, '0');
	return `${h}:${m}`;
}

/** Pure function: determine what the arc center timer should display. */
export function getTimerMode(input: TimerInput): TimerMode {
	const { activeSleep, prediction, todayWakeUp, now } = input;

	const isSleeping = !!activeSleep && !activeSleep.end_time;

	if (isSleeping && activeSleep) {
		const start = new Date(activeSleep.start_time).getTime();

		// Open night-waking on the active night sleep — shown as a distinct
		// label so the parent can see "she's awake right now inside the night
		// sleep" rather than the regular sleeping label. Net the closed
		// wakings (and the ongoing one) out of `elapsed` so the timer reflects
		// actual sleep time, matching the engine's wakingsAsPausesForSleep
		// netting in src/lib/engine/state.ts.
		const todayNightWakings = input.todayNightWakings ?? [];
		const wakingsOnThisSleep = activeSleep.type === 'night'
			? todayNightWakings.filter((w) => new Date(w.start_time).getTime() >= start)
			: [];
		const openNightWaking = wakingsOnThisSleep.find((w) => !w.end_time) ?? null;
		let nightWakingMs = 0;
		for (const w of wakingsOnThisSleep) {
			const ws = new Date(w.start_time).getTime();
			const we = w.end_time ? new Date(w.end_time).getTime() : now;
			nightWakingMs += Math.max(0, we - ws);
		}
		const elapsed = Math.max(0, now - start - nightWakingMs);

		let label: string;
		if (openNightWaking) {
			label = `🌙 Vakning sidan ${formatHM(new Date(openNightWaking.start_time))}`;
		} else if (activeSleep.type === 'night') label = '💤 Søv';
		else label = '😴 Lurar';

		// Expected wake time for naps (negative = overtime)
		const expectedWake = activeSleep.type === 'nap' && prediction?.expectedNapEnd
			? prediction.expectedNapEnd
			: null;
		const expectedWakeCountdown = expectedWake
			? new Date(expectedWake).getTime() - now
			: null;

		// Sleep cycle phase (only for naps — night cycles are different)
		const cycleMin = prediction?.learnedSchedule?.sleepCycleMin ?? 45;
		const cyclePhase = activeSleep.type === 'nap' ? computeCyclePhase(elapsed, cycleMin) : null;

		return { kind: 'sleeping', label, elapsed, startTime: activeSleep.start_time, expectedWake, expectedWakeCountdown, cyclePhase };
	}

	const currentHour = new Date(now).getHours();

	if (currentHour >= 0 && currentHour < 5) {
		const wakeTime = todayWakeUp?.wake_time ?? null;
		const wakeCountdown =
			wakeTime != null ? new Date(wakeTime).getTime() - now : null;
		return {
			kind: 'deep-night',
			wakeCountdown: wakeCountdown != null && wakeCountdown > 0 ? wakeCountdown : null,
			wakeTime,
		};
	}

	const bedtimeMs = prediction?.bedtime ? new Date(prediction.bedtime).getTime() : null;
	// "Close to bedtime" — within 90 min. Once this fires the parent's
	// focus is bedtime, not a wake-window. 90 min is a conservative
	// floor: the typical 11mo wake-window before bed is 3-5 h, but a
	// nap that would START 90 min before bedtime would also END too
	// close, so we treat that whole window as bedtime territory.
	const closeToBedtime = bedtimeMs != null && bedtimeMs - now < 90 * 60_000;
	const cycleMin = prediction?.learnedSchedule?.sleepCycleMin ?? 45;

	// Newborn: always use sleep window mode.
	// Emerging: use sleep window when schedule has no nextNap AND bedtime
	// isn't close — once bedtime is near, the parent's mental model is
	// "wait for bedtime", and showing 'Søvnvindauge no 💤' at 17:44 with
	// bedtime at 18:17 lands somewhere between unhelpful and incorrect.
	const usesSleepWindow = prediction?.sleepWindow && prediction.sleepPressure && (
		prediction.strategy === 'newborn_guidance'
		|| (prediction.strategy === 'emerging_rhythm' && !prediction.nextNap && !closeToBedtime)
	);
	if (usesSleepWindow) {
		const windowStart = new Date(prediction!.sleepWindow!.earliest).getTime() - now;
		const windowEnd = new Date(prediction!.sleepWindow!.latest).getTime() - now;
		return { kind: 'sleep-window', windowStart, windowEnd, pressure: prediction!.sleepPressure! };
	}

	// Skipped-nap state takes precedence over silently flipping to bedtime mode.
	// When the engine flagged a missed nap (no active sleep, >60 min overdue),
	// surface that to the parent with the post-skip recommendation instead of
	// the misleading "Leggetid om 8t" the regular bedtime branch would show.
	if (prediction?.skippedNap) {
		const plannedMs = new Date(prediction.skippedNap.plannedAt).getTime();
		return {
			kind: 'skipped-nap',
			plannedAt: prediction.skippedNap.plannedAt,
			plannedAgoMs: Math.max(0, now - plannedMs),
			postSkipPlan: prediction.postSkipPlan,
			bedtime: prediction.bedtime,
			bedtimeCountdown: bedtimeMs != null ? bedtimeMs - now : null,
		};
	}

	if (prediction?.nextNap) {
		const nextNapMs = new Date(prediction.nextNap).getTime();
		const hoursUntilNap = (nextNapMs - now) / 3600000;
		const isEvening = currentHour >= 20;
		const showBedtime = prediction.napsAllDone || isEvening;

		if (showBedtime && prediction.bedtime && bedtimeMs != null) {
			if (bedtimeMs < now) {
				return makeAfterBedtime(prediction.bedtime, bedtimeMs, now, cycleMin);
			}
			return { kind: 'bedtime', countdown: bedtimeMs - now, bedtime: prediction.bedtime };
		}

		if (hoursUntilNap > 0) {
			return { kind: 'next-nap', countdown: nextNapMs - now };
		}

		return { kind: 'overtime', overtime: now - nextNapMs };
	}

	// Bedtime fallback. The engine left us without a concrete nextNap
	// (emerging-rhythm often hits this when the predicted next nap is
	// inside the bedtime buffer and gets filtered out). If bedtime itself
	// is on the table, surface that — beats falling through to 'idle' and
	// telling the parent nothing.
	if (prediction?.bedtime && bedtimeMs != null) {
		if (bedtimeMs < now) {
			return makeAfterBedtime(prediction.bedtime, bedtimeMs, now, cycleMin);
		}
		return { kind: 'bedtime', countdown: bedtimeMs - now, bedtime: prediction.bedtime };
	}

	return { kind: 'idle' };
}

/**
 * Build the `after-bedtime` mode, including the next cycle-aligned target.
 * A parent who missed the planned bedtime by ~25 min often does better
 * waiting until the next ~50-min cycle boundary than putting the baby
 * down at a random "in-between" point — the boundaries line up with the
 * baby's natural light/easy-onset windows. The target is `bedtime + N *
 * cycleMin` where N is the smallest integer that pushes it past `now`.
 */
function makeAfterBedtime(
	bedtime: string,
	bedtimeMs: number,
	now: number,
	cycleMin: number,
): TimerMode {
	const minutesPastBedtime = (now - bedtimeMs) / 60_000;
	const cyclesPast = Math.max(1, Math.ceil(minutesPastBedtime / cycleMin));
	const nextCycleMs = bedtimeMs + cyclesPast * cycleMin * 60_000;
	return {
		kind: 'after-bedtime',
		bedtime,
		nextCycleTarget: new Date(nextCycleMs).toISOString(),
		cycleMin,
	};
}

/** Awake-since duration in ms, or null if unknown. */
export function getAwakeSince(input: TimerInput): number | null {
	const { todaySleeps, todayWakeUp, now } = input;
	const lastSleep = todaySleeps.find((s) => s.end_time);
	const since = lastSleep?.end_time || todayWakeUp?.wake_time;
	if (!since) return null;
	const ms = now - new Date(since).getTime();
	return ms > 60000 ? ms : null;
}
