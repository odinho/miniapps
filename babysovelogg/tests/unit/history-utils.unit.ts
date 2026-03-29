import { describe, test, expect } from 'bun:test';
import {
	DIAPER_ICONS,
	DIAPER_LABELS,
	DIAPER_STATUS_LABELS,
	SLEEP_TYPES,
	DIAPER_EDIT_TYPES,
	DIAPER_EDIT_AMOUNTS,
	POTTY_EDIT_RESULTS,
	POTTY_EDIT_STATUSES,
	mergeEntries,
	groupByDate,
	getDateLabel,
	calcSleepDurationMs,
	formatSleepDuration,
	formatSleepTimes,
	getSleepIcon,
	getSleepTypeLabel,
	getPauseSummary,
	getSleepBadges,
	getFallAsleepLabel,
	getWokeByLabel,
	isPottyEntry,
	getDiaperIcon,
	getDiaperMeta,
	getDiaperCategoryLabel,
	buildSleepUpdateEvent,
	buildSleepDeleteEvent,
	buildDiaperUpdateEvent,
	buildDiaperDeleteEvent,
	isoToDateInput,
	isoToTimeInput,
	dateTimeToIso,
} from '$lib/history-utils.js';
import type { SleepLogRow, DiaperLogRow, DayStartRow } from '$lib/types.js';

// ── Helpers ──────────────────────────────────────────────────────

function makeSleep(overrides: Partial<SleepLogRow> = {}): SleepLogRow {
	return {
		id: 1,
		baby_id: 1,
		start_time: '2026-03-27T08:00:00.000Z',
		end_time: '2026-03-27T09:30:00.000Z',
		type: 'nap',
		notes: null,
		mood: null,
		method: null,
		fall_asleep_time: null,
		woke_by: null,
		wake_notes: null,
		deleted: 0,
		domain_id: 'sleep-001',
		created_by_event_id: null,
		updated_by_event_id: null,
		pauses: [],
		...overrides,
	};
}

function makeDiaper(overrides: Partial<DiaperLogRow> = {}): DiaperLogRow {
	return {
		id: 1,
		baby_id: 1,
		time: '2026-03-27T10:00:00.000Z',
		type: 'wet',
		amount: 'middels',
		note: null,
		deleted: 0,
		domain_id: 'diaper-001',
		created_by_event_id: null,
		updated_by_event_id: null,
		...overrides,
	};
}

function makeWakeup(overrides: Partial<DayStartRow> = {}): DayStartRow {
	return {
		id: 1,
		baby_id: 1,
		date: '2026-03-27',
		wake_time: '2026-03-27T06:30:00.000Z',
		created_at: '2026-03-27T06:30:00.000Z',
		created_by_event_id: null,
		...overrides,
	};
}

// ── Constants ────────────────────────────────────────────────────

describe('constants', () => {
	test('DIAPER_ICONS has all expected types', () => {
		expect(DIAPER_ICONS.wet).toBe('💧');
		expect(DIAPER_ICONS.dirty).toBe('💩');
		expect(DIAPER_ICONS.both).toBe('💧💩');
		expect(DIAPER_ICONS.dry).toBe('✨');
		expect(DIAPER_ICONS.potty_wet).toBe('🚽');
		expect(DIAPER_ICONS.diaper_only).toBe('🧷');
	});

	test('DIAPER_LABELS has all expected labels', () => {
		expect(DIAPER_LABELS.wet).toBe('Våt');
		expect(DIAPER_LABELS.potty_wet).toBe('Tiss på do');
		expect(DIAPER_LABELS.diaper_only).toBe('Berre bleie');
	});

	test('DIAPER_STATUS_LABELS covers potty diaper statuses', () => {
		expect(DIAPER_STATUS_LABELS.dry).toBe('Tørr bleie');
		expect(DIAPER_STATUS_LABELS.damp).toBe('Litt våt bleie');
		expect(DIAPER_STATUS_LABELS.wet).toBe('Våt bleie');
	});

	test('SLEEP_TYPES has nap and night', () => {
		expect(SLEEP_TYPES).toHaveLength(2);
		expect(SLEEP_TYPES[0].value).toBe('nap');
		expect(SLEEP_TYPES[1].value).toBe('night');
	});

	test('DIAPER_EDIT_TYPES has 4 options', () => {
		expect(DIAPER_EDIT_TYPES).toHaveLength(4);
	});

	test('DIAPER_EDIT_AMOUNTS has 3 options', () => {
		expect(DIAPER_EDIT_AMOUNTS).toHaveLength(3);
	});

	test('POTTY_EDIT_RESULTS has 4 options', () => {
		expect(POTTY_EDIT_RESULTS).toHaveLength(4);
	});

	test('POTTY_EDIT_STATUSES has 5 options', () => {
		expect(POTTY_EDIT_STATUSES).toHaveLength(5);
	});
});

// ── mergeEntries ─────────────────────────────────────────────────

describe('mergeEntries', () => {
	test('merges and sorts by time descending', () => {
		const sleeps = [makeSleep({ start_time: '2026-03-27T08:00:00.000Z' })];
		const diapers = [makeDiaper({ time: '2026-03-27T10:00:00.000Z' })];
		const wakeups = [makeWakeup({ wake_time: '2026-03-27T06:30:00.000Z' })];

		const result = mergeEntries(sleeps, diapers, wakeups);

		expect(result).toHaveLength(3);
		expect(result[0]._kind).toBe('diaper'); // 10:00 (most recent)
		expect(result[1]._kind).toBe('sleep'); // 08:00
		expect(result[2]._kind).toBe('wakeup'); // 06:30
	});

	test('handles empty arrays', () => {
		const result = mergeEntries([], [], []);
		expect(result).toHaveLength(0);
	});

	test('sets correct _sortTime for each kind', () => {
		const sleeps = [makeSleep({ start_time: '2026-03-27T08:00:00.000Z' })];
		const diapers = [makeDiaper({ time: '2026-03-27T10:00:00.000Z' })];
		const wakeups = [makeWakeup({ wake_time: '2026-03-27T06:30:00.000Z' })];

		const result = mergeEntries(sleeps, diapers, wakeups);
		const sleep = result.find((e) => e._kind === 'sleep')!;
		const diaper = result.find((e) => e._kind === 'diaper')!;
		const wakeup = result.find((e) => e._kind === 'wakeup')!;

		expect(sleep._sortTime).toBe('2026-03-27T08:00:00.000Z');
		expect(diaper._sortTime).toBe('2026-03-27T10:00:00.000Z');
		expect(wakeup._sortTime).toBe('2026-03-27T06:30:00.000Z');
	});
});

// ── groupByDate ──────────────────────────────────────────────────

describe('groupByDate', () => {
	test('groups entries by local date', () => {
		const entries = mergeEntries(
			[
				makeSleep({ start_time: '2026-03-27T08:00:00.000Z' }),
				makeSleep({ id: 2, start_time: '2026-03-26T14:00:00.000Z', domain_id: 'sleep-002' }),
			],
			[],
			[],
		);
		const grouped = groupByDate(entries);
		expect(grouped.size).toBeGreaterThanOrEqual(1);
	});

	test('entries within same day are grouped together', () => {
		const entries = mergeEntries(
			[
				makeSleep({ start_time: '2026-03-27T08:00:00.000Z' }),
				makeSleep({ id: 2, start_time: '2026-03-27T14:00:00.000Z', domain_id: 'sleep-002' }),
			],
			[],
			[],
		);
		const grouped = groupByDate(entries);
		// Both should be in the same date bucket
		let totalEntries = 0;
		for (const [, dayEntries] of grouped) totalEntries += dayEntries.length;
		expect(totalEntries).toBe(2);
	});
});

// ── getDateLabel ─────────────────────────────────────────────────

describe('getDateLabel', () => {
	test('returns "I dag" for today', () => {
		const today = new Date();
		const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
		expect(getDateLabel(todayStr)).toBe('I dag');
	});

	test('returns "I går" for yesterday', () => {
		const yesterday = new Date();
		yesterday.setDate(yesterday.getDate() - 1);
		const yStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
		expect(getDateLabel(yStr)).toBe('I går');
	});

	test('returns formatted date for older dates', () => {
		const label = getDateLabel('2026-01-15');
		expect(label).toMatch(/jan/i);
		expect(label).toMatch(/15/);
	});
});

// ── Sleep formatting ─────────────────────────────────────────────

describe('calcSleepDurationMs', () => {
	test('calculates duration from start to end', () => {
		const entry = makeSleep({
			start_time: '2026-03-27T08:00:00.000Z',
			end_time: '2026-03-27T09:30:00.000Z',
		});
		expect(calcSleepDurationMs(entry)).toBe(90 * 60 * 1000);
	});

	test('returns 0 for ongoing sleep', () => {
		const entry = makeSleep({ end_time: null });
		expect(calcSleepDurationMs(entry)).toBe(0);
	});

	test('subtracts pause time', () => {
		const entry = makeSleep({
			start_time: '2026-03-27T08:00:00.000Z',
			end_time: '2026-03-27T09:30:00.000Z',
			pauses: [
				{
					id: 1,
					sleep_id: 1,
					pause_time: '2026-03-27T08:30:00.000Z',
					resume_time: '2026-03-27T08:45:00.000Z',
					created_by_event_id: null,
				},
			],
		});
		// 90 min - 15 min pause = 75 min
		expect(calcSleepDurationMs(entry)).toBe(75 * 60 * 1000);
	});

	test('handles multiple pauses', () => {
		const entry = makeSleep({
			start_time: '2026-03-27T08:00:00.000Z',
			end_time: '2026-03-27T10:00:00.000Z',
			pauses: [
				{
					id: 1,
					sleep_id: 1,
					pause_time: '2026-03-27T08:30:00.000Z',
					resume_time: '2026-03-27T08:40:00.000Z',
					created_by_event_id: null,
				},
				{
					id: 2,
					sleep_id: 1,
					pause_time: '2026-03-27T09:00:00.000Z',
					resume_time: '2026-03-27T09:10:00.000Z',
					created_by_event_id: null,
				},
			],
		});
		// 120 min - 10 min - 10 min = 100 min
		expect(calcSleepDurationMs(entry)).toBe(100 * 60 * 1000);
	});

	test('never returns negative', () => {
		const entry = makeSleep({
			start_time: '2026-03-27T08:00:00.000Z',
			end_time: '2026-03-27T08:05:00.000Z',
			pauses: [
				{
					id: 1,
					sleep_id: 1,
					pause_time: '2026-03-27T08:00:00.000Z',
					resume_time: '2026-03-27T08:10:00.000Z',
					created_by_event_id: null,
				},
			],
		});
		expect(calcSleepDurationMs(entry)).toBe(0);
	});
});

describe('formatSleepDuration', () => {
	test('returns "pågår…" for ongoing sleep', () => {
		const entry = makeSleep({ end_time: null });
		expect(formatSleepDuration(entry)).toBe('pågår…');
	});

	test('returns formatted duration for completed sleep', () => {
		const entry = makeSleep({
			start_time: '2026-03-27T08:00:00.000Z',
			end_time: '2026-03-27T09:30:00.000Z',
		});
		expect(formatSleepDuration(entry)).toBe('1h 30m');
	});
});

describe('formatSleepTimes', () => {
	test('formats start — end', () => {
		const entry = makeSleep({
			start_time: '2026-03-27T08:00:00.000Z',
			end_time: '2026-03-27T09:30:00.000Z',
		});
		const result = formatSleepTimes(entry);
		expect(result).toContain('—');
		expect(result).not.toContain('no');
	});

	test('uses "no" for ongoing sleep', () => {
		const entry = makeSleep({ end_time: null });
		const result = formatSleepTimes(entry);
		expect(result).toContain('no');
	});
});

describe('getSleepIcon', () => {
	test('returns moon for night', () => {
		expect(getSleepIcon('night')).toBe('🌙');
	});

	test('returns sleep for nap', () => {
		expect(getSleepIcon('nap')).toBe('😴');
	});
});

describe('getSleepTypeLabel', () => {
	test('returns Nattesøvn for night', () => {
		expect(getSleepTypeLabel('night')).toBe('Nattesøvn');
	});

	test('returns Lur for nap', () => {
		expect(getSleepTypeLabel('nap')).toBe('Lur');
	});
});

describe('getPauseSummary', () => {
	test('returns null for no pauses', () => {
		expect(getPauseSummary(makeSleep())).toBeNull();
	});

	test('returns null for empty pauses array', () => {
		expect(getPauseSummary(makeSleep({ pauses: [] }))).toBeNull();
	});

	test('returns count and total minutes', () => {
		const entry = makeSleep({
			pauses: [
				{
					id: 1,
					sleep_id: 1,
					pause_time: '2026-03-27T08:30:00.000Z',
					resume_time: '2026-03-27T08:45:00.000Z',
					created_by_event_id: null,
				},
			],
		});
		const result = getPauseSummary(entry);
		expect(result).toEqual({ count: 1, totalMinutes: 15 });
	});
});

describe('getSleepBadges', () => {
	test('returns empty for no mood/method', () => {
		expect(getSleepBadges(makeSleep())).toEqual([]);
	});

	test('returns mood badge', () => {
		const badges = getSleepBadges(makeSleep({ mood: 'normal' }));
		expect(badges).toHaveLength(1);
		expect(badges[0].emoji).toBe('😊');
	});

	test('returns mood + method badges', () => {
		const badges = getSleepBadges(makeSleep({ mood: 'upset', method: 'nursing' }));
		expect(badges).toHaveLength(2);
		expect(badges[0].emoji).toBe('😢');
		expect(badges[1].emoji).toBe('🤱');
	});
});

describe('getFallAsleepLabel', () => {
	test('returns null for null input', () => {
		expect(getFallAsleepLabel(null)).toBeNull();
	});

	test('returns label for known value', () => {
		expect(getFallAsleepLabel('<5')).toBe('< 5 min');
		expect(getFallAsleepLabel('30+')).toBe('30+ min');
	});

	test('returns value itself for unknown', () => {
		expect(getFallAsleepLabel('unknown')).toBe('unknown');
	});
});

describe('getWokeByLabel', () => {
	test('returns null for null input', () => {
		expect(getWokeByLabel(null)).toBeNull();
	});

	test('returns label for self', () => {
		expect(getWokeByLabel('self')).toBe('Vakna sjølv');
	});

	test('returns label for us', () => {
		expect(getWokeByLabel('us')).toBe('Vekt av oss');
	});
});

// ── Diaper formatting ────────────────────────────────────────────

describe('isPottyEntry', () => {
	test('detects potty entries', () => {
		expect(isPottyEntry('potty_wet')).toBe(true);
		expect(isPottyEntry('potty_dirty')).toBe(true);
		expect(isPottyEntry('potty_nothing')).toBe(true);
		expect(isPottyEntry('diaper_only')).toBe(true);
	});

	test('rejects regular diaper entries', () => {
		expect(isPottyEntry('wet')).toBe(false);
		expect(isPottyEntry('dirty')).toBe(false);
		expect(isPottyEntry('both')).toBe(false);
		expect(isPottyEntry('dry')).toBe(false);
	});
});

describe('getDiaperIcon', () => {
	test('returns correct icon for known types', () => {
		expect(getDiaperIcon('wet')).toBe('💧');
		expect(getDiaperIcon('potty_wet')).toBe('🚽');
	});

	test('returns fallback for unknown type', () => {
		expect(getDiaperIcon('unknown')).toBe('💩');
	});
});

describe('getDiaperMeta', () => {
	test('formats regular diaper with amount', () => {
		const meta = getDiaperMeta(makeDiaper({ type: 'wet', amount: 'mykje' }));
		expect(meta).toBe('Våt · mykje');
	});

	test('formats potty with status label', () => {
		const meta = getDiaperMeta(makeDiaper({ type: 'potty_wet', amount: 'dry' }));
		expect(meta).toBe('Tiss på do · Tørr bleie');
	});

	test('formats diaper with no amount', () => {
		const meta = getDiaperMeta(makeDiaper({ type: 'dry', amount: null }));
		expect(meta).toBe('Tørr');
	});
});

describe('getDiaperCategoryLabel', () => {
	test('returns Do for potty entries', () => {
		expect(getDiaperCategoryLabel('potty_wet')).toBe('Do');
		expect(getDiaperCategoryLabel('diaper_only')).toBe('Do');
	});

	test('returns Bleie for regular entries', () => {
		expect(getDiaperCategoryLabel('wet')).toBe('Bleie');
		expect(getDiaperCategoryLabel('dirty')).toBe('Bleie');
	});
});

// ── Event builders ───────────────────────────────────────────────

describe('buildSleepUpdateEvent', () => {
	test('builds sleep.updated event with required fields', () => {
		const event = buildSleepUpdateEvent({
			sleepDomainId: 'sleep-001',
			startTime: '2026-03-27T08:00:00.000Z',
			type: 'nap',
			mood: null,
			method: null,
			fallAsleepTime: null,
		});
		expect(event.type).toBe('sleep.updated');
		expect(event.domainId).toBe('sleep-001');
		expect(event.payload.sleepDomainId).toBe('sleep-001');
		expect(event.payload.startTime).toBe('2026-03-27T08:00:00.000Z');
		expect(event.payload.type).toBe('nap');
	});

	test('includes optional endTime', () => {
		const event = buildSleepUpdateEvent({
			sleepDomainId: 'sleep-001',
			startTime: '2026-03-27T08:00:00.000Z',
			endTime: '2026-03-27T09:30:00.000Z',
			type: 'nap',
			mood: null,
			method: null,
			fallAsleepTime: null,
		});
		expect(event.payload.endTime).toBe('2026-03-27T09:30:00.000Z');
	});

	test('omits endTime when undefined', () => {
		const event = buildSleepUpdateEvent({
			sleepDomainId: 'sleep-001',
			startTime: '2026-03-27T08:00:00.000Z',
			type: 'nap',
			mood: null,
			method: null,
			fallAsleepTime: null,
		});
		expect(event.payload).not.toHaveProperty('endTime');
	});

	test('includes notes when provided', () => {
		const event = buildSleepUpdateEvent({
			sleepDomainId: 'sleep-001',
			startTime: '2026-03-27T08:00:00.000Z',
			type: 'nap',
			mood: 'normal',
			method: 'bed',
			fallAsleepTime: '<5',
			notes: 'Sov godt',
		});
		expect(event.payload.notes).toBe('Sov godt');
		expect(event.payload.mood).toBe('normal');
		expect(event.payload.method).toBe('bed');
		expect(event.payload.fallAsleepTime).toBe('<5');
	});
});

describe('buildSleepDeleteEvent', () => {
	test('builds sleep.deleted event', () => {
		const event = buildSleepDeleteEvent('sleep-001');
		expect(event.type).toBe('sleep.deleted');
		expect(event.payload.sleepDomainId).toBe('sleep-001');
		expect(event.domainId).toBe('sleep-001');
	});
});

describe('buildDiaperUpdateEvent', () => {
	test('builds diaper.updated event', () => {
		const event = buildDiaperUpdateEvent({
			diaperDomainId: 'diaper-001',
			type: 'wet',
			amount: 'middels',
		});
		expect(event.type).toBe('diaper.updated');
		expect(event.payload.diaperDomainId).toBe('diaper-001');
		expect(event.payload.type).toBe('wet');
		expect(event.payload.amount).toBe('middels');
		expect(event.domainId).toBe('diaper-001');
	});

	test('includes note when provided', () => {
		const event = buildDiaperUpdateEvent({
			diaperDomainId: 'diaper-001',
			type: 'dirty',
			amount: 'mykje',
			note: 'Stor ein',
		});
		expect(event.payload.note).toBe('Stor ein');
	});

	test('omits note when undefined', () => {
		const event = buildDiaperUpdateEvent({
			diaperDomainId: 'diaper-001',
			type: 'wet',
			amount: 'lite',
		});
		expect(event.payload).not.toHaveProperty('note');
	});
});

describe('buildDiaperDeleteEvent', () => {
	test('builds diaper.deleted event', () => {
		const event = buildDiaperDeleteEvent('diaper-001');
		expect(event.type).toBe('diaper.deleted');
		expect(event.payload.diaperDomainId).toBe('diaper-001');
		expect(event.domainId).toBe('diaper-001');
	});
});

// ── Datetime helpers ─────────────────────────────────────────────

describe('isoToDateInput', () => {
	test('extracts date part in local time', () => {
		// This depends on local timezone, but the format should be YYYY-MM-DD
		const result = isoToDateInput('2026-03-27T08:00:00.000Z');
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});

describe('isoToTimeInput', () => {
	test('extracts time part in local time', () => {
		const result = isoToTimeInput('2026-03-27T08:00:00.000Z');
		expect(result).toMatch(/^\d{2}:\d{2}$/);
	});
});

describe('dateTimeToIso', () => {
	test('combines date and time into ISO string', () => {
		const result = dateTimeToIso('2026-03-27', '10:30');
		expect(result).toContain('2026-03-27');
		// Should be a valid ISO string
		expect(new Date(result).toISOString()).toBe(result);
	});
});
