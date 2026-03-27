import type { SleepLogRow } from '$lib/types.js';
import { MOOD_EMOJI, METHOD_EMOJI, FALL_ASLEEP_LABELS } from '$lib/constants.js';

/** Options for who/what woke the baby. */
export const WOKE_OPTIONS = [
	{ value: 'self', label: 'Vakna sjølv' },
	{ value: 'woken', label: 'Vekt av oss' },
] as const;

/** Payload for a wake-up sleep.updated event. */
export type WakeUpPayload = {
	sleepDomainId: string;
	wokeBy?: string;
	wakeNotes?: string;
};

/** Build a sleep.updated event with wake-up data. Returns null if nothing was entered. */
export function buildWakeUpEvent(
	sleepDomainId: string,
	wokeBy: string | null,
	wakeNotes: string,
): { type: string; payload: WakeUpPayload } | null {
	const trimmedNotes = wakeNotes.trim() || null;
	if (!wokeBy && !trimmedNotes) return null;
	const payload: WakeUpPayload = { sleepDomainId };
	if (wokeBy) payload.wokeBy = wokeBy;
	if (trimmedNotes) payload.wakeNotes = trimmedNotes;
	return { type: 'sleep.updated', payload };
}

/** A badge item for the bedtime summary display. */
export interface BedtimeBadge {
	emoji: string;
	title: string;
}

/** Extract bedtime summary info from a sleep snapshot. */
export function getBedtimeSummary(sleep: SleepLogRow): {
	hasTags: boolean;
	badges: BedtimeBadge[];
	fallAsleepLabel: string | null;
	notes: string | null;
} {
	const badges: BedtimeBadge[] = [];

	if (sleep.mood && MOOD_EMOJI[sleep.mood]) {
		badges.push({ emoji: MOOD_EMOJI[sleep.mood], title: sleep.mood });
	}
	if (sleep.method && METHOD_EMOJI[sleep.method]) {
		badges.push({ emoji: METHOD_EMOJI[sleep.method], title: sleep.method });
	}

	const fallAsleepLabel = sleep.fall_asleep_time
		? FALL_ASLEEP_LABELS[sleep.fall_asleep_time] || sleep.fall_asleep_time
		: null;

	const hasTags = badges.length > 0 || !!fallAsleepLabel || !!sleep.notes;

	return { hasTags, badges, fallAsleepLabel, notes: sleep.notes };
}
