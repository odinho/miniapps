import type { SleepLogRow } from '$lib/types.js';
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
	napsAllDone?: boolean,
): StartSleepResult {
	const type = classifySleepType(todaySleeps, ageMonths, customNapCount, undefined, napsAllDone);
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

/**
 * Build the events needed to end an active sleep.
 *
 * When `capWake` is set, the parent is ending the nap on the engine's
 * recommendation (a napBudget or rescue cap was showing), so we also tag
 * `woke_by = 'woken'`. The continuation-suppression logic
 * (`shouldSuppressContinuation`) was written assuming a cap-respect wake is
 * tagged 'woken', but nothing in the UI ever set it — so "Forleng luren"
 * fired right on top of the cap the parent just followed (2026-06-01 report).
 * The parent can still correct it to 'self' in the wake-up sheet.
 */
export function buildEndSleep(activeSleep: SleepLogRow, capWake = false): EndSleepResult {
	const endTime = new Date().toISOString();
	const events: Array<{ type: string; payload: Record<string, unknown> }> = [
		{
			type: 'sleep.ended',
			payload: { sleepDomainId: activeSleep.domain_id, endTime },
		},
	];
	if (capWake) {
		events.push({
			type: 'sleep.updated',
			payload: { sleepDomainId: activeSleep.domain_id, wokeBy: 'woken' },
		});
	}

	// Stamp end_time onto the snapshot so downstream consumers
	// (WakeUpSheet's undo-end gating in particular) see post-end state.
	return {
		events,
		endTime,
		sleepSnapshot: { ...activeSleep, end_time: endTime, woke_by: capWake ? 'woken' : activeSleep.woke_by },
	};
}

