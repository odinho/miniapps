import {
	calculateAgeMonths,
	WAKE_WINDOWS,
	NAP_COUNTS,
	SLEEP_NEEDS,
	findByAge,
	getExpectedNapCount,
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
	targetBedtime?: string | null;
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
		p.targetBedtime = payload.targetBedtime ?? null;
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
	/** If true, this row is a collapsible detail row */
	detail?: boolean;
}

export function buildSleepInfoRows(ageMonths: number): SleepInfoRow[] {
	const ww = findByAge(WAKE_WINDOWS, ageMonths);
	const naps = findByAge(NAP_COUNTS, ageMonths);
	const sleepNeed = findByAge(SLEEP_NEEDS, ageMonths);
	const fmtMin = (m: number) => (m >= 60 ? formatDuration(m * 60000) : `${Math.round(m)} min`);
	const napCount = naps.naps;

	// 24h budget: sleep + awake = 24h
	const totalSleepH = sleepNeed.totalHours;
	const totalAwakeH = 24 - totalSleepH;
	const napDurMin = ageMonths < 6 ? 60 : ageMonths < 12 ? 45 : 30;
	const totalNapH = Math.round(napCount * napDurMin / 60 * 10) / 10;
	const nightH = Math.round((totalSleepH - totalNapH) * 10) / 10;
	const numWindows = napCount + 1;
	const avgWindowH = Math.round(totalAwakeH / numWindows * 10) / 10;

	// Positional wake windows: first is shorter, last (bedtime) is longer
	const midMin = (ww.minMinutes + ww.maxMinutes) / 2;
	const firstMin = Math.round(ww.minMinutes + (midMin - ww.minMinutes) * 0.3);
	const bedtimeMin = Math.round(midMin * 1.2);

	const rows: SleepInfoRow[] = [
		{ label: 'Søvn totalt', value: `~${totalSleepH}t av 24t` },
		{ label: 'Nattesøvn', value: `~${nightH}t` },
		{ label: 'Lurar', value: `${napCount} × ~${fmtMin(napDurMin)}` },
		{ label: 'Vaken totalt', value: `~${totalAwakeH}t (${numWindows} vindauge à ~${avgWindowH}t)` },
	];

	// Detail rows: positional wake window ranges
	const windowNames = napCount >= 3
		? ['Morgon', 'Middag 1', 'Middag 2', 'Kveld']
		: napCount === 2
			? ['Morgon', 'Middag', 'Kveld']
			: napCount === 1
				? ['Morgon', 'Kveld']
				: ['Vakevindu'];

	if (napCount >= 1) {
		rows.push({ label: windowNames[0], value: `~${fmtMin(firstMin)} (${fmtMin(ww.minMinutes)}–${fmtMin(midMin)})`, detail: true });
		for (let i = 1; i < windowNames.length - 1; i++) {
			rows.push({ label: windowNames[i], value: `~${fmtMin(midMin)} (${fmtMin(midMin * 0.9)}–${fmtMin(midMin * 1.1)})`, detail: true });
		}
		rows.push({ label: windowNames[windowNames.length - 1], value: `~${fmtMin(bedtimeMin)} (${fmtMin(midMin)}–${fmtMin(ww.maxMinutes)})`, detail: true });
	}

	return rows;
}

// --- Prediction panel ---

export interface PredictionRow {
	label: string;
	value: string;
}

function napDurationStr(startIso: string, endIso: string): string {
	const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
	return formatDuration(ms);
}

export function buildPredictionRows(opts: {
	ageMonths: number;
	napCount: number | null;
	completedNaps: number;
	wakeTime: string | null;
	recentSleeps: SleepEntry[];
	serverPrediction: { predictedNaps: PredictedNap[] | null; expectedNapCount?: number; bedtime: string } | null;
	totalSleepMinutes: number;
}): PredictionRow[] {
	// Use the engine's resolved nap count when available (reflects learned data + custom override),
	// otherwise fall back to age-based default.
	const expected = opts.serverPrediction?.expectedNapCount
		?? getExpectedNapCount(opts.ageMonths, opts.napCount ?? undefined);
	const rows: PredictionRow[] = [
		{ label: 'Forventa lurar i dag', value: `${opts.completedNaps} av ${expected}` },
	];

	if (opts.wakeTime && opts.serverPrediction?.predictedNaps) {
		const predicted = opts.serverPrediction.predictedNaps;
		const bedtime = opts.serverPrediction.bedtime;
		for (let i = 0; i < predicted.length; i++) {
			const actual = opts.recentSleeps.filter(s => s.type === 'nap' && s.end_time)[i];
			const predDur = napDurationStr(predicted[i].startTime, predicted[i].endTime);
			const predictedStr = `~${formatTime(predicted[i].startTime)}–${formatTime(predicted[i].endTime)}`;
			if (actual) {
				const actDur = napDurationStr(actual.start_time, actual.end_time!);
				rows.push({
					label: `Lur ${i + 1}`,
					value: `${predictedStr} (${predDur}), var ${formatTime(actual.start_time)}–${formatTime(actual.end_time!)} (${actDur})`,
				});
			} else {
				rows.push({
					label: `Lur ${i + 1}`,
					value: `${predictedStr} (${predDur})`,
				});
			}
		}
		rows.push({ label: 'Leggetid', value: `~${formatTime(bedtime)}` });
	} else if (opts.serverPrediction) {
		if (opts.serverPrediction.predictedNaps) {
			for (let i = 0; i < opts.serverPrediction.predictedNaps.length; i++) {
				const nap = opts.serverPrediction.predictedNaps[i];
				const dur = napDurationStr(nap.startTime, nap.endTime);
				rows.push({
					label: `Lur ${i + 1}`,
					value: `~${formatTime(nap.startTime)}–${formatTime(nap.endTime)} (${dur})`,
				});
			}
		}
		rows.push({ label: 'Leggetid', value: `~${formatTime(opts.serverPrediction.bedtime)}` });
	}

	rows.push({ label: 'Søvn i dag', value: opts.totalSleepMinutes > 0 ? formatDuration(opts.totalSleepMinutes * 60000) : '0m' });

	return rows;
}

// --- Age formatting ---

export function formatAge(birthdate: string): string {
	const months = calculateAgeMonths(birthdate);
	if (months < 1) return 'nyfødd';
	if (months === 1) return '1 månad';
	return `${months} månader`;
}
