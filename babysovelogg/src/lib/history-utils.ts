import type { SleepLogRow, DiaperLogRow, NightWakingRow } from '$lib/types.js';
import { toLocal, toLocalDate, formatTime, formatDuration } from '$lib/utils.js';
import { MOOD_EMOJI, METHOD_EMOJI, FALL_ASLEEP_LABELS, WAKE_MOOD_EMOJI } from '$lib/constants.js';

// ── Constants ────────────────────────────────────────────────────

export const DIAPER_ICONS: Record<string, string> = {
	wet: '💧',
	dirty: '💩',
	both: '💧💩',
	dry: '✨',
	potty_wet: '🚽',
	potty_dirty: '🚽',
	potty_both: '🚽',
	potty_nothing: '🚽',
	diaper_only: '🧷',
};

export const DIAPER_LABELS: Record<string, string> = {
	wet: 'Våt',
	dirty: 'Skitten',
	both: 'Våt + skitten',
	dry: 'Tørr',
	potty_wet: 'Tiss på do',
	potty_dirty: 'Bæsj på do',
	potty_both: 'Tiss + bæsj på do',
	potty_nothing: 'Ingenting på do',
	diaper_only: 'Berre bleie',
};

export const DIAPER_STATUS_LABELS: Record<string, string> = {
	dry: 'Tørr bleie',
	damp: 'Litt våt bleie',
	wet: 'Våt bleie',
	full: 'Full bleie',
	dirty: 'Skitten bleie',
};

export const SLEEP_TYPES = [
	{ value: 'nap', label: '😴 Lur' },
	{ value: 'night', label: '🌙 Natt' },
] as const;

export const DIAPER_EDIT_TYPES = [
	{ value: 'wet', label: '💧 Våt' },
	{ value: 'dirty', label: '💩 Skitten' },
	{ value: 'both', label: '💧💩 Begge' },
	{ value: 'dry', label: '✨ Tørr' },
] as const;

export const DIAPER_EDIT_AMOUNTS = [
	{ value: 'lite', label: 'Lite' },
	{ value: 'middels', label: 'Middels' },
	{ value: 'mykje', label: 'Mykje' },
] as const;

export const POTTY_EDIT_RESULTS = [
	{ value: 'potty_wet', label: '💧 Tiss' },
	{ value: 'potty_dirty', label: '💩 Bæsj' },
	{ value: 'potty_both', label: '💧💩 Båe' },
	{ value: 'potty_nothing', label: '∅ Ingenting' },
	{ value: 'diaper_only', label: '🧷 Berre bleie' },
] as const;

// Re-exported from diaper-form-actions so the new-entry form and the edit
// modal share a single source of truth — the missing "Skitten" option in
// the new-entry form was a drift bug here.
export { POTTY_DIAPER_STATUSES as POTTY_EDIT_STATUSES } from './diaper-form-actions.js';

// ── Unified timeline types ───────────────────────────────────────

export type HistoryEntry =
	| (SleepLogRow & { _kind: 'sleep'; _sortTime: string })
	| (DiaperLogRow & { _kind: 'diaper'; _sortTime: string })
	| (NightWakingRow & { _kind: 'night_waking'; _sortTime: string });

// ── Data fetching ────────────────────────────────────────────────

export async function fetchHistory(
	limit = 50,
	baby?: 'all' | number,
): Promise<{
	sleeps: SleepLogRow[];
	diapers: DiaperLogRow[];
	nightWakings: NightWakingRow[];
}> {
	const q = baby != null ? `&baby=${baby}` : '';
	const [sleeps, diapers, nightWakings] = await Promise.all([
		fetch(`/api/sleeps?limit=${limit}${q}`).then((r) => r.json()) as Promise<SleepLogRow[]>,
		fetch(`/api/diapers?limit=${limit}${q}`).then((r) => r.json()) as Promise<DiaperLogRow[]>,
		fetch(`/api/night-wakings?limit=${limit}${q}`).then((r) => r.json()) as Promise<NightWakingRow[]>,
	]);
	return { sleeps, diapers, nightWakings };
}

// ── Merge + sort ─────────────────────────────────────────────────

export function mergeEntries(
	sleeps: SleepLogRow[],
	diapers: DiaperLogRow[],
	nightWakings: NightWakingRow[] = [],
): HistoryEntry[] {
	const entries: HistoryEntry[] = [
		...sleeps.map((s) => ({ ...s, _kind: 'sleep' as const, _sortTime: s.start_time })),
		...diapers.map((d) => ({ ...d, _kind: 'diaper' as const, _sortTime: d.time })),
		...nightWakings.map((w) => ({ ...w, _kind: 'night_waking' as const, _sortTime: w.start_time })),
	];
	entries.sort((a, b) => new Date(b._sortTime).getTime() - new Date(a._sortTime).getTime());
	return entries;
}

// ── Date grouping ────────────────────────────────────────────────

export function groupByDate(entries: HistoryEntry[]): Map<string, HistoryEntry[]> {
	const grouped = new Map<string, HistoryEntry[]>();
	for (const e of entries) {
		const date = toLocalDate(e._sortTime);
		if (!grouped.has(date)) grouped.set(date, []);
		grouped.get(date)!.push(e);
	}
	return grouped;
}

export function getDateLabel(dateStr: string): string {
	const todayLocal = toLocalDate(new Date().toISOString());
	if (dateStr === todayLocal) return 'I dag';

	const yesterday = new Date();
	yesterday.setDate(yesterday.getDate() - 1);
	const yesterdayLocal = toLocalDate(yesterday.toISOString());
	if (dateStr === yesterdayLocal) return 'I går';

	const d = new Date(dateStr + 'T12:00:00');
	return d.toLocaleDateString('nb-NO', { weekday: 'short', month: 'short', day: 'numeric' });
}

// ── Sleep entry formatting ───────────────────────────────────────

/** True when `endIso` is at or before `startIso` (zero/negative duration). A
 *  null end (ongoing sleep/waking) is never "before". Guards manual edits from
 *  saving an end on the wrong calendar day — the slip that produced a night
 *  ending before it started. */
export function isEndAtOrBeforeStart(startIso: string, endIso: string | null): boolean {
	if (!endIso) return false;
	return new Date(endIso).getTime() <= new Date(startIso).getTime();
}

export function calcSleepDurationMs(entry: SleepLogRow): number {
	if (!entry.end_time) return 0;
	const ms = new Date(entry.end_time).getTime() - new Date(entry.start_time).getTime();
	return Math.max(0, ms);
}

export function formatSleepDuration(entry: SleepLogRow): string {
	if (!entry.end_time) return 'pågår…';
	return formatDuration(calcSleepDurationMs(entry));
}

export function formatSleepTimes(entry: SleepLogRow): string {
	const start = formatTime(entry.start_time);
	const end = entry.end_time ? formatTime(entry.end_time) : 'no';
	return `${start} — ${end}`;
}

export function getSleepIcon(type: string): string {
	return type === 'night' ? '🌙' : '😴';
}

export function getSleepTypeLabel(type: string): string {
	return type === 'night' ? 'Nattesøvn' : 'Lur';
}

export interface TagBadge {
	emoji: string;
	title: string;
}

export function getSleepBadges(entry: SleepLogRow): TagBadge[] {
	const badges: TagBadge[] = [];
	if (entry.mood && MOOD_EMOJI[entry.mood]) {
		badges.push({ emoji: MOOD_EMOJI[entry.mood], title: entry.mood });
	}
	if (entry.method && METHOD_EMOJI[entry.method]) {
		badges.push({ emoji: METHOD_EMOJI[entry.method], title: entry.method });
	}
	return badges;
}

export function getFallAsleepLabel(value: string | null): string | null {
	if (!value) return null;
	return FALL_ASLEEP_LABELS[value] || value;
}

export function getWokeByLabel(value: string | null): string | null {
	if (!value) return null;
	return value === 'self' ? 'Vakna sjølv' : 'Vekt av oss';
}

export function getWakeMoodEmoji(value: string | null): string | null {
	if (!value) return null;
	return WAKE_MOOD_EMOJI[value] || null;
}

// ── Diaper entry formatting ──────────────────────────────────────

export function isPottyEntry(type: string): boolean {
	return type.startsWith('potty_') || type === 'diaper_only';
}

export function getDiaperIcon(type: string): string {
	return DIAPER_ICONS[type] || '💩';
}

export function getDiaperMeta(entry: DiaperLogRow): string {
	const isPotty = isPottyEntry(entry.type);
	const parts = [DIAPER_LABELS[entry.type] || entry.type];
	if (isPotty && entry.amount && DIAPER_STATUS_LABELS[entry.amount]) {
		parts.push(DIAPER_STATUS_LABELS[entry.amount]);
	} else if (!isPotty && entry.amount) {
		parts.push(entry.amount);
	}
	return parts.join(' · ');
}

export function getDiaperCategoryLabel(type: string): string {
	return isPottyEntry(type) ? 'Do' : 'Bleie';
}

// ── Event builders (for edit/delete) ─────────────────────────────

export interface SleepUpdatePayload {
	sleepDomainId: string;
	startTime: string;
	endTime?: string;
	type: string;
	mood: string | null;
	method: string | null;
	fallAsleepTime: string | null;
	onsetNote?: string;
	wakeMood: string | null;
	notes?: string;
}

export function buildSleepUpdateEvent(payload: SleepUpdatePayload) {
	return {
		type: 'sleep.updated',
		payload: {
			sleepDomainId: payload.sleepDomainId,
			startTime: payload.startTime,
			...(payload.endTime ? { endTime: payload.endTime } : {}),
			type: payload.type,
			mood: payload.mood,
			method: payload.method,
			fallAsleepTime: payload.fallAsleepTime,
			onsetNote: payload.onsetNote || null,
			wakeMood: payload.wakeMood,
			notes: payload.notes || null,
		},
	};
}

export function buildSleepDeleteEvent(sleepDomainId: string) {
	return {
		type: 'sleep.deleted',
		payload: { sleepDomainId },
	};
}

export interface DiaperUpdatePayload {
	diaperDomainId: string;
	type: string;
	/** `null` clears the field; `undefined` leaves it untouched. */
	amount: string | null;
	/** `null` clears the field; `undefined` leaves it untouched. */
	note?: string | null;
	time?: string;
}

export function buildDiaperUpdateEvent(payload: DiaperUpdatePayload) {
	return {
		type: 'diaper.updated',
		payload: {
			diaperDomainId: payload.diaperDomainId,
			type: payload.type,
			amount: payload.amount,
			...(payload.note !== undefined ? { note: payload.note } : {}),
			...(payload.time ? { time: payload.time } : {}),
		},
	};
}

export function buildDiaperDeleteEvent(diaperDomainId: string) {
	return {
		type: 'diaper.deleted',
		payload: { diaperDomainId },
	};
}

// ── Datetime helpers for edit forms ──────────────────────────────

export function isoToDateInput(iso: string): string {
	return toLocal(iso).slice(0, 10);
}

export function isoToTimeInput(iso: string): string {
	return toLocal(iso).slice(11, 16);
}

export function dateTimeToIso(dateStr: string, timeStr: string): string {
	return new Date(`${dateStr}T${timeStr}`).toISOString();
}

/**
 * Resolve a wake time entered as HH:MM (no date) into a full ISO instant,
 * choosing the first occurrence of that clock time at or after the sleep
 * start. Without this, a "00:30" wake on a 23:00 night-start would infer
 * today's date from the wall clock and land before the start (B31). Local
 * time, matching `dateTimeToIso`.
 */
export function firstWakeIsoAtOrAfter(startIso: string, hhmm: string): string {
	const start = new Date(startIso);
	const [h, m] = hhmm.split(':').map(Number);
	const end = new Date(start);
	end.setHours(h, m, 0, 0);
	if (end.getTime() < start.getTime()) end.setDate(end.getDate() + 1);
	return end.toISOString();
}
