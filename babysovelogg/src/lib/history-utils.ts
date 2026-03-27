import type { SleepLogRow, DiaperLogRow, DayStartRow } from '$lib/types.js';
import { toLocal, toLocalDate, formatTime, formatDuration } from '$lib/utils.js';
import { MOOD_EMOJI, METHOD_EMOJI, FALL_ASLEEP_LABELS } from '$lib/constants.js';

// ── Constants ────────────────────────────────────────────────────

export const DIAPER_ICONS: Record<string, string> = {
	wet: '💧',
	dirty: '💩',
	both: '💧💩',
	dry: '✨',
	potty_wet: '🚽',
	potty_dirty: '🚽',
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
	potty_nothing: 'Ingenting på do',
	diaper_only: 'Berre bleie',
};

export const DIAPER_STATUS_LABELS: Record<string, string> = {
	dry: 'Tørr bleie',
	damp: 'Litt våt bleie',
	wet: 'Våt bleie',
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
	{ value: 'potty_nothing', label: '∅ Ingenting' },
	{ value: 'diaper_only', label: '🧷 Berre bleie' },
] as const;

export const POTTY_EDIT_STATUSES = [
	{ value: 'dry', label: 'Tørr ✨' },
	{ value: 'damp', label: 'Litt våt 💧' },
	{ value: 'wet', label: 'Våt 💧💧' },
	{ value: 'dirty', label: 'Skitten 💩' },
] as const;

// ── Unified timeline types ───────────────────────────────────────

export type HistoryEntry =
	| (SleepLogRow & { _kind: 'sleep'; _sortTime: string })
	| (DiaperLogRow & { _kind: 'diaper'; _sortTime: string })
	| (DayStartRow & { _kind: 'wakeup'; _sortTime: string });

// ── Data fetching ────────────────────────────────────────────────

export async function fetchHistory(limit = 50): Promise<{
	sleeps: SleepLogRow[];
	diapers: DiaperLogRow[];
	wakeups: DayStartRow[];
}> {
	const [sleeps, diapers, wakeups] = await Promise.all([
		fetch(`/api/sleeps?limit=${limit}`).then((r) => r.json()) as Promise<SleepLogRow[]>,
		fetch(`/api/diapers?limit=${limit}`).then((r) => r.json()) as Promise<DiaperLogRow[]>,
		fetch(`/api/wakeups?limit=${limit}`).then((r) => r.json()) as Promise<DayStartRow[]>,
	]);
	return { sleeps, diapers, wakeups };
}

// ── Merge + sort ─────────────────────────────────────────────────

export function mergeEntries(
	sleeps: SleepLogRow[],
	diapers: DiaperLogRow[],
	wakeups: DayStartRow[],
): HistoryEntry[] {
	const entries: HistoryEntry[] = [
		...sleeps.map((s) => ({ ...s, _kind: 'sleep' as const, _sortTime: s.start_time })),
		...diapers.map((d) => ({ ...d, _kind: 'diaper' as const, _sortTime: d.time })),
		...wakeups.map((w) => ({ ...w, _kind: 'wakeup' as const, _sortTime: w.wake_time })),
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

export function calcSleepDurationMs(entry: SleepLogRow): number {
	if (!entry.end_time) return 0;
	let ms = new Date(entry.end_time).getTime() - new Date(entry.start_time).getTime();
	if (entry.pauses?.length) {
		for (const p of entry.pauses) {
			const ps = new Date(p.pause_time).getTime();
			const pe = p.resume_time
				? new Date(p.resume_time).getTime()
				: entry.end_time
					? new Date(entry.end_time).getTime()
					: Date.now();
			ms -= pe - ps;
		}
	}
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

export interface PauseSummary {
	count: number;
	totalMinutes: number;
}

export function getPauseSummary(entry: SleepLogRow): PauseSummary | null {
	const pauses = entry.pauses;
	if (!pauses || pauses.length === 0) return null;
	let totalMs = 0;
	for (const p of pauses) {
		const ps = new Date(p.pause_time).getTime();
		const pe = p.resume_time
			? new Date(p.resume_time).getTime()
			: entry.end_time
				? new Date(entry.end_time).getTime()
				: Date.now();
		totalMs += pe - ps;
	}
	return { count: pauses.length, totalMinutes: Math.floor(totalMs / 60000) };
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
			...(payload.notes ? { notes: payload.notes } : {}),
		},
		domainId: payload.sleepDomainId,
	};
}

export function buildSleepDeleteEvent(sleepDomainId: string) {
	return {
		type: 'sleep.deleted',
		payload: { sleepDomainId },
		domainId: sleepDomainId,
	};
}

export interface DiaperUpdatePayload {
	diaperDomainId: string;
	type: string;
	amount: string;
	note?: string;
}

export function buildDiaperUpdateEvent(payload: DiaperUpdatePayload) {
	return {
		type: 'diaper.updated',
		payload: {
			diaperDomainId: payload.diaperDomainId,
			type: payload.type,
			amount: payload.amount,
			...(payload.note ? { note: payload.note } : {}),
		},
		domainId: payload.diaperDomainId,
	};
}

export function buildDiaperDeleteEvent(diaperDomainId: string) {
	return {
		type: 'diaper.deleted',
		payload: { diaperDomainId },
		domainId: diaperDomainId,
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
