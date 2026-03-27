import type { DiaperLogRow } from '$lib/types.js';

/** Payload for a sleep.tagged event. */
export type TagPayload = {
	sleepDomainId: string;
	mood: string | null;
	method: string | null;
	fallAsleepTime: string | null;
	notes: string | null;
};

/** Payload for a sleep.updated event (start time adjustment). */
export type TimeAdjustPayload = {
	sleepDomainId: string;
	startTime: string;
};

/** Build a sleep.tagged event from tag sheet selections. Returns null if nothing was selected. */
export function buildTagEvent(
	sleepDomainId: string,
	mood: string | null,
	method: string | null,
	fallAsleepTime: string | null,
	notes: string,
): { type: string; payload: TagPayload } | null {
	const trimmedNotes = notes.trim() || null;
	if (!mood && !method && !fallAsleepTime && !trimmedNotes) return null;
	return {
		type: 'sleep.tagged',
		payload: {
			sleepDomainId,
			mood,
			method,
			fallAsleepTime,
			notes: trimmedNotes,
		},
	};
}

/** Build a sleep.updated event for start time adjustment. Returns null if time didn't change. */
export function buildTimeAdjustEvent(
	sleepDomainId: string,
	originalStartTime: string,
	adjustedStartTime: string,
): { type: string; payload: TimeAdjustPayload } | null {
	if (adjustedStartTime === originalStartTime) return null;
	return {
		type: 'sleep.updated',
		payload: {
			sleepDomainId,
			startTime: adjustedStartTime,
		},
	};
}

/** Nudge a time backward by the given number of minutes. */
export function nudgeTime(isoTime: string, minutes: number): string {
	const d = new Date(isoTime);
	d.setMinutes(d.getMinutes() - minutes);
	return d.toISOString();
}

/** Check if a diaper nudge should be shown. Returns true if no diaper logged in the last `thresholdMs`. */
export function shouldShowDiaperNudge(
	diapers: DiaperLogRow[],
	thresholdMs: number = 2 * 60 * 60 * 1000,
): boolean {
	if (diapers.length === 0) return true;
	const now = Date.now();
	const latest = diapers.reduce((max, d) => {
		const t = new Date(d.time).getTime();
		return t > max ? t : max;
	}, 0);
	return now - latest > thresholdMs;
}

/** Collect all events to send when the tag sheet is dismissed. */
export function collectTagSheetEvents(
	sleepDomainId: string,
	originalStartTime: string,
	adjustedStartTime: string,
	mood: string | null,
	method: string | null,
	fallAsleepTime: string | null,
	notes: string,
): Array<{ type: string; payload: Record<string, unknown> }> {
	const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

	const timeEvt = buildTimeAdjustEvent(sleepDomainId, originalStartTime, adjustedStartTime);
	if (timeEvt) events.push(timeEvt);

	const tagEvt = buildTagEvent(sleepDomainId, mood, method, fallAsleepTime, notes);
	if (tagEvt) events.push(tagEvt);

	return events;
}
