import { generateDiaperId } from '$lib/identity.js';

/** Diaper type options for normal mode. */
export const DIAPER_TYPES = [
	{ value: 'wet', label: '💧 Våt' },
	{ value: 'dirty', label: '💩 Skitten' },
	{ value: 'both', label: '💧💩 Begge' },
	{ value: 'dry', label: '✨ Tørr' },
] as const;

/** Amount options for normal mode diapers. */
export const DIAPER_AMOUNTS = [
	{ value: 'lite', label: 'Lite' },
	{ value: 'middels', label: 'Middels' },
	{ value: 'mykje', label: 'Mykje' },
] as const;

/** Result options for potty mode. */
export const POTTY_RESULTS = [
	{ value: 'potty_wet', label: '💧 Tiss' },
	{ value: 'potty_dirty', label: '💩 Bæsj' },
	{ value: 'potty_nothing', label: '∅ Ingenting' },
	{ value: 'diaper_only', label: '🧷 Ingen do' },
] as const;

/** Diaper status options for potty mode (how wet was the diaper). */
export const POTTY_DIAPER_STATUSES = [
	{ value: 'dry', label: 'Tørr ✨' },
	{ value: 'damp', label: 'Litt 💧' },
	{ value: 'wet', label: 'Våt 💧💧' },
] as const;

/** Payload for a diaper.logged event. */
export type DiaperLoggedPayload = {
	babyId: number;
	time: string;
	type: string;
	diaperDomainId: string;
	amount: string | null;
	note: string | null;
};

/** Check whether a potty result type hides the diaper status selector. */
export function shouldHideDiaperStatus(pottyResult: string): boolean {
	return pottyResult === 'diaper_only';
}

/** Build a diaper.logged event for normal diaper mode. */
export function buildDiaperEvent(
	babyId: number,
	time: string,
	type: string,
	amount: string,
	note: string,
	idFn: () => string = generateDiaperId,
): { type: string; payload: DiaperLoggedPayload } {
	return {
		type: 'diaper.logged',
		payload: {
			babyId,
			time,
			type,
			diaperDomainId: idFn(),
			amount,
			note: note.trim() || null,
		},
	};
}

/** Build a diaper.logged event for potty mode. */
export function buildPottyEvent(
	babyId: number,
	time: string,
	pottyResult: string,
	diaperStatus: string,
	note: string,
	idFn: () => string = generateDiaperId,
): { type: string; payload: DiaperLoggedPayload } {
	return {
		type: 'diaper.logged',
		payload: {
			babyId,
			time,
			type: pottyResult,
			diaperDomainId: idFn(),
			amount: shouldHideDiaperStatus(pottyResult) ? null : diaperStatus,
			note: note.trim() || null,
		},
	};
}

/** Validate that a time string is a valid ISO date. */
export function isValidTime(time: string): boolean {
	return !isNaN(new Date(time).getTime());
}
