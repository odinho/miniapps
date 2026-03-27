import type { SleepLogRow, SleepPauseRow } from '$lib/types.js';
import type { Prediction } from '$lib/stores/app.svelte.js';
import { calcPauseMs } from '$lib/engine/classification.js';

export type TimerMode =
	| { kind: 'sleeping'; label: string; elapsed: number; startTime: string }
	| { kind: 'deep-night'; wakeCountdown: number | null; wakeTime: string | null }
	| { kind: 'next-nap'; countdown: number }
	| { kind: 'overtime'; overtime: number }
	| { kind: 'bedtime'; countdown: number; bedtime: string }
	| { kind: 'after-bedtime'; bedtime: string }
	| { kind: 'idle' };

export interface TimerInput {
	activeSleep: SleepLogRow | null;
	prediction: Prediction | null;
	todayWakeUp: { wake_time: string } | null;
	todaySleeps: SleepLogRow[];
	now: number;
}

/** Pure function: determine what the arc center timer should display. */
export function getTimerMode(input: TimerInput): TimerMode {
	const { activeSleep, prediction, todayWakeUp, now } = input;

	const isSleeping = !!activeSleep && !activeSleep.end_time;

	if (isSleeping && activeSleep) {
		const pauses: SleepPauseRow[] = (activeSleep.pauses as SleepPauseRow[]) ?? [];
		const isPaused = pauses.length > 0 && !pauses[pauses.length - 1].resume_time;
		const start = new Date(activeSleep.start_time).getTime();
		const elapsed = Math.max(0, now - start - calcPauseMs(pauses));

		let label: string;
		if (isPaused) label = '⏸️ Pause';
		else if (activeSleep.type === 'night') label = '💤 Søv';
		else label = '😴 Lurar';

		return { kind: 'sleeping', label, elapsed, startTime: activeSleep.start_time };
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

	if (prediction?.nextNap) {
		const nextNapMs = new Date(prediction.nextNap).getTime();
		const hoursUntilNap = (nextNapMs - now) / 3600000;
		const isEvening = currentHour >= 20;
		const showBedtime = prediction.napsAllDone || isEvening;

		if (showBedtime && prediction.bedtime) {
			const bedtimeMs = new Date(prediction.bedtime).getTime();
			if (bedtimeMs < now) {
				return { kind: 'after-bedtime', bedtime: prediction.bedtime };
			}
			return { kind: 'bedtime', countdown: bedtimeMs - now, bedtime: prediction.bedtime };
		}

		if (hoursUntilNap > 0) {
			return { kind: 'next-nap', countdown: nextNapMs - now };
		}

		return { kind: 'overtime', overtime: now - nextNapMs };
	}

	return { kind: 'idle' };
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
