import {
	calculateAgeMonths,
	WAKE_WINDOWS,
	findByAge,
	getExpectedNapCount,
	predictDayNaps,
	recommendBedtime,
	type PredictedNap,
} from './engine/schedule.js';
import type { SleepEntry } from './types.js';
import { formatDuration, formatTime } from './utils.js';

// --- Nap count options for custom override pills ---

export interface NapOption {
	value: number | null;
	label: string;
}

export const NAP_OPTIONS: NapOption[] = [
	{ value: null, label: 'Auto' },
	{ value: 0, label: '0' },
	{ value: 1, label: '1' },
	{ value: 2, label: '2' },
	{ value: 3, label: '3' },
	{ value: 4, label: '4' },
];

// --- Potty mode options ---

export interface PottyOption {
	value: boolean;
	label: string;
}

export const POTTY_OPTIONS: PottyOption[] = [
	{ value: false, label: '🧷 Bleie' },
	{ value: true, label: '🚽 Pottetrening' },
];

// --- Event builders ---

export interface SettingsPayload {
	name: string;
	birthdate: string;
	customNapCount?: number | null;
	pottyMode?: boolean;
}

export function buildBabyEvent(
	payload: SettingsPayload,
	isNew: boolean,
): { type: string; payload: Record<string, unknown> } {
	const tz = typeof Intl !== "undefined"
		? Intl.DateTimeFormat().resolvedOptions().timeZone
		: null;
	const p: Record<string, unknown> = {
		name: payload.name,
		birthdate: payload.birthdate,
	};
	if (isNew) {
		p.timezone = tz;
	} else {
		p.customNapCount = payload.customNapCount ?? null;
		p.pottyMode = payload.pottyMode ?? false;
	}
	return {
		type: isNew ? 'baby.created' : 'baby.updated',
		payload: p,
	};
}

// --- Validation ---

export interface ValidationResult {
	valid: boolean;
	nameError: boolean;
	dateError: boolean;
	message: string | null;
}

export function validateSettings(name: string, birthdate: string): ValidationResult {
	const trimmed = name.trim();
	const nameError = !trimmed;
	const dateError = !birthdate;
	if (nameError || dateError) {
		return {
			valid: false,
			nameError,
			dateError,
			message: nameError ? 'Skriv inn namn' : 'Vel termindato',
		};
	}
	return { valid: true, nameError: false, dateError: false, message: null };
}

// --- Sleep info for age ---

export function getSleepNeedForAge(ageMonths: number): string {
	if (ageMonths < 3) return '14–17 timar';
	if (ageMonths < 6) return '13–16 timar';
	if (ageMonths < 9) return '12–15 timar';
	if (ageMonths < 12) return '12–14 timar';
	if (ageMonths < 18) return '11–14 timar';
	return '11–13 timar';
}

export function getNapCountForAge(ageMonths: number): string {
	if (ageMonths < 3) return '4–5 lurar';
	if (ageMonths < 6) return '3 lurar';
	if (ageMonths < 9) return '2–3 lurar';
	if (ageMonths < 12) return '2 lurar';
	if (ageMonths < 18) return '1–2 lurar';
	return '1 lur';
}

export function getNextSleepMilestone(ageMonths: number): string | null {
	if (ageMonths < 3)
		return 'Rundt 3 mnd: Søvnmønster blir meir føreseieleg. Vakevindu aukar til 75–120 min.';
	if (ageMonths < 4)
		return 'Rundt 4 mnd: Overgang frå 4 til 3 lurar. «4-månaders-regresjon» er vanleg.';
	if (ageMonths < 6) return 'Rundt 6 mnd: Overgang til 2 lurar. Lengre vakevindu (2–2,5 timar).';
	if (ageMonths < 9)
		return 'Rundt 9 mnd: Nokre babyar droppar den tredje luren. Vakevindu aukar til 2,5–3,5 timar.';
	if (ageMonths < 12)
		return 'Rundt 12 mnd: Kan gå frå 2 til 1 lur. Denne overgangen kan ta fleire veker.';
	if (ageMonths < 18)
		return 'Rundt 18 mnd: Dei fleste har no berre 1 lur. Vakevindu er 5–6 timar.';
	return null;
}

export interface SleepInfoRow {
	label: string;
	value: string;
}

export function buildSleepInfoRows(ageMonths: number): SleepInfoRow[] {
	const ww = findByAge(WAKE_WINDOWS, ageMonths);
	const fmtMin = (m: number) => (m >= 60 ? formatDuration(m * 60000) : `${Math.round(m)} min`);
	return [
		{ label: 'Vakevindu', value: `${fmtMin(ww.minMinutes)} – ${fmtMin(ww.maxMinutes)}` },
		{ label: 'Lurar per dag', value: getNapCountForAge(ageMonths) },
		{ label: 'Søvnbehov (24t)', value: getSleepNeedForAge(ageMonths) },
	];
}

// --- Prediction panel ---

export interface PredictionRow {
	label: string;
	value: string;
}

export function buildPredictionRows(opts: {
	ageMonths: number;
	napCount: number | null;
	completedNaps: number;
	wakeTime: string | null;
	recentSleeps: SleepEntry[];
	serverPrediction: { predictedNaps: PredictedNap[] | null; bedtime: string } | null;
	totalSleepMinutes: number;
}): PredictionRow[] {
	const expected = getExpectedNapCount(opts.ageMonths, opts.napCount ?? undefined);
	const rows: PredictionRow[] = [
		{ label: 'Forventa lurar i dag', value: `${opts.completedNaps} av ${expected}` },
	];

	if (opts.wakeTime) {
		const predicted = predictDayNaps(
			opts.wakeTime,
			opts.ageMonths,
			opts.recentSleeps,
			opts.napCount ?? undefined,
		);
		const bedtime = recommendBedtime(opts.recentSleeps, opts.ageMonths, opts.napCount ?? undefined);
		for (let i = 0; i < predicted.length; i++) {
			rows.push({
				label: `Lur ${i + 1}`,
				value: `~${formatTime(predicted[i].startTime)} – ~${formatTime(predicted[i].endTime)}`,
			});
		}
		rows.push({ label: 'Leggetid', value: `~${formatTime(bedtime)}` });
	} else if (opts.serverPrediction) {
		if (opts.serverPrediction.predictedNaps) {
			for (let i = 0; i < opts.serverPrediction.predictedNaps.length; i++) {
				const nap = opts.serverPrediction.predictedNaps[i];
				rows.push({
					label: `Lur ${i + 1}`,
					value: `~${formatTime(nap.startTime)} – ~${formatTime(nap.endTime)}`,
				});
			}
		}
		rows.push({ label: 'Leggetid', value: `~${formatTime(opts.serverPrediction.bedtime)}` });
	}

	if (opts.totalSleepMinutes > 0) {
		rows.push({ label: 'Søvn i dag', value: formatDuration(opts.totalSleepMinutes * 60000) });
	}

	return rows;
}

// --- Age formatting ---

export function formatAge(birthdate: string): string {
	const months = calculateAgeMonths(birthdate);
	if (months < 1) return 'nyfødd';
	if (months === 1) return '1 månad';
	return `${months} månader`;
}
