import type { SleepLogRow, SleepPauseRow } from '$lib/types.js';
import { classifySleepType } from '$lib/engine/classification.js';
import { generateSleepId } from '$lib/identity.js';

/** Result of starting a sleep session. */
export interface StartSleepResult {
	events: Array<{ type: string; payload: Record<string, unknown> }>;
	sleepDomainId: string;
	startTime: string;
}

/** Build the events needed to start a new sleep. */
export function buildStartSleep(
	babyId: number,
	todaySleeps: SleepLogRow[],
	ageMonths: number,
	customNapCount: number | null,
): StartSleepResult {
	const type = classifySleepType(todaySleeps, ageMonths, customNapCount);
	const sleepDomainId = generateSleepId();
	const startTime = new Date().toISOString();

	return {
		events: [
			{
				type: 'sleep.started',
				payload: { babyId, startTime, type, sleepDomainId },
			},
		],
		sleepDomainId,
		startTime,
	};
}

/** Result of ending a sleep session. */
export interface EndSleepResult {
	events: Array<{ type: string; payload: Record<string, unknown> }>;
	endTime: string;
	sleepSnapshot: SleepLogRow;
}

/** Build the events needed to end an active sleep. */
export function buildEndSleep(activeSleep: SleepLogRow, babyId: number): EndSleepResult {
	const endTime = new Date().toISOString();
	const events: Array<{ type: string; payload: Record<string, unknown> }> = [
		{
			type: 'sleep.ended',
			payload: { sleepDomainId: activeSleep.domain_id, endTime },
		},
	];

	// Auto-wakeup for night sleep (B18 feature)
	if (activeSleep.type === 'night') {
		events.push({
			type: 'day.started',
			payload: { babyId, wakeTime: endTime },
		});
	}

	return { events, endTime, sleepSnapshot: { ...activeSleep } };
}

/** Build a pause event. */
export function buildPause(domainId: string) {
	return {
		type: 'sleep.paused' as const,
		payload: { sleepDomainId: domainId, pauseTime: new Date().toISOString() },
	};
}

/** Build a resume event. */
export function buildResume(domainId: string) {
	return {
		type: 'sleep.resumed' as const,
		payload: { sleepDomainId: domainId, resumeTime: new Date().toISOString() },
	};
}

/** Check if a sleep's pauses indicate it's currently paused. */
export function isPaused(pauses: SleepPauseRow[] | undefined): boolean {
	if (!pauses || pauses.length === 0) return false;
	return !pauses[pauses.length - 1].resume_time;
}
