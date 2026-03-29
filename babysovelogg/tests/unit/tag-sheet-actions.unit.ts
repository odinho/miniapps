import { describe, it, expect, setSystemTime, beforeEach, afterEach, afterAll } from 'bun:test';

afterAll(() => setSystemTime());
import {
	buildTagEvent,
	buildTimeAdjustEvent,
	nudgeTime,
	shouldShowDiaperNudge,
	collectTagSheetEvents,
} from '$lib/tag-sheet-actions.js';
import type { DiaperLogRow } from '$lib/types.js';

function makeDiaper(overrides: Partial<DiaperLogRow> = {}): DiaperLogRow {
	return {
		id: 1,
		baby_id: 1,
		time: '2026-03-27T12:00:00.000Z',
		type: 'wet',
		amount: null,
		note: null,
		deleted: 0,
		domain_id: 'dip_test1',
		created_by_event_id: null,
		updated_by_event_id: null,
		...overrides,
	};
}

describe('buildTagEvent', () => {
	it('returns null when nothing is selected', () => {
		expect(buildTagEvent('slp_1', null, null, null, '')).toBeNull();
		expect(buildTagEvent('slp_1', null, null, null, '   ')).toBeNull();
	});

	it('builds event when mood is selected', () => {
		const evt = buildTagEvent('slp_1', 'normal', null, null, '');
		expect(evt).not.toBeNull();
		expect(evt!.type).toBe('sleep.tagged');
		expect(evt!.payload.mood).toBe('normal');
		expect(evt!.payload.method).toBeNull();
		expect(evt!.payload.fallAsleepTime).toBeNull();
		expect(evt!.payload.notes).toBeNull();
	});

	it('builds event when method is selected', () => {
		const evt = buildTagEvent('slp_1', null, 'nursing', null, '');
		expect(evt!.payload.method).toBe('nursing');
	});

	it('builds event when fallAsleepTime is selected', () => {
		const evt = buildTagEvent('slp_1', null, null, '5-15', '');
		expect(evt!.payload.fallAsleepTime).toBe('5-15');
	});

	it('builds event when notes are provided', () => {
		const evt = buildTagEvent('slp_1', null, null, null, 'cried a bit');
		expect(evt!.payload.notes).toBe('cried a bit');
	});

	it('trims whitespace from notes', () => {
		const evt = buildTagEvent('slp_1', null, null, null, '  test  ');
		expect(evt!.payload.notes).toBe('test');
	});

	it('builds event with all fields set', () => {
		const evt = buildTagEvent('slp_1', 'upset', 'held', '15-30', 'rough night');
		expect(evt!.payload).toEqual({
			sleepDomainId: 'slp_1',
			mood: 'upset',
			method: 'held',
			fallAsleepTime: '15-30',
			notes: 'rough night',
		});
	});

	it('preserves sleepDomainId', () => {
		const evt = buildTagEvent('slp_abc123', 'normal', null, null, '');
		expect(evt!.payload.sleepDomainId).toBe('slp_abc123');
	});
});

describe('buildTimeAdjustEvent', () => {
	it('returns null when times are identical', () => {
		const t = '2026-03-27T10:00:00.000Z';
		expect(buildTimeAdjustEvent('slp_1', t, t)).toBeNull();
	});

	it('builds sleep.updated event when time changed', () => {
		const original = '2026-03-27T10:00:00.000Z';
		const adjusted = '2026-03-27T09:55:00.000Z';
		const evt = buildTimeAdjustEvent('slp_1', original, adjusted);
		expect(evt).not.toBeNull();
		expect(evt!.type).toBe('sleep.updated');
		expect(evt!.payload.sleepDomainId).toBe('slp_1');
		expect(evt!.payload.startTime).toBe(adjusted);
	});
});

describe('nudgeTime', () => {
	it('subtracts 1 minute', () => {
		const result = nudgeTime('2026-03-27T10:05:00.000Z', 1);
		expect(result).toBe('2026-03-27T10:04:00.000Z');
	});

	it('subtracts 5 minutes', () => {
		const result = nudgeTime('2026-03-27T10:10:00.000Z', 5);
		expect(result).toBe('2026-03-27T10:05:00.000Z');
	});

	it('wraps across hour boundary', () => {
		const result = nudgeTime('2026-03-27T10:02:00.000Z', 5);
		expect(result).toBe('2026-03-27T09:57:00.000Z');
	});

	it('wraps across midnight', () => {
		const result = nudgeTime('2026-03-27T00:02:00.000Z', 5);
		expect(result).toBe('2026-03-26T23:57:00.000Z');
	});
});

describe('shouldShowDiaperNudge', () => {
	beforeEach(() => {
		setSystemTime(new Date('2026-03-27T14:00:00.000Z'));
	});
	afterEach(() => setSystemTime());

	it('shows nudge when no diapers exist', () => {
		expect(shouldShowDiaperNudge([])).toBe(true);
	});

	it('shows nudge when latest diaper is older than 2 hours', () => {
		const diapers = [makeDiaper({ time: '2026-03-27T11:00:00.000Z' })];
		expect(shouldShowDiaperNudge(diapers)).toBe(true);
	});

	it('hides nudge when latest diaper is within 2 hours', () => {
		const diapers = [makeDiaper({ time: '2026-03-27T12:30:00.000Z' })];
		expect(shouldShowDiaperNudge(diapers)).toBe(false);
	});

	it('checks the latest diaper, not the first', () => {
		const diapers = [
			makeDiaper({ time: '2026-03-27T10:00:00.000Z' }),
			makeDiaper({ time: '2026-03-27T13:00:00.000Z' }),
		];
		expect(shouldShowDiaperNudge(diapers)).toBe(false);
	});

	it('shows nudge when latest diaper is exactly 2 hours ago', () => {
		const diapers = [makeDiaper({ time: '2026-03-27T12:00:00.000Z' })];
		// now=14:00, diaper=12:00, diff=exactly 2h => not >2h, so false
		expect(shouldShowDiaperNudge(diapers)).toBe(false);
	});

	it('shows nudge when latest diaper is 2h + 1ms ago', () => {
		const diapers = [makeDiaper({ time: '2026-03-27T11:59:59.999Z' })];
		expect(shouldShowDiaperNudge(diapers)).toBe(true);
	});

	it('accepts custom threshold', () => {
		const diapers = [makeDiaper({ time: '2026-03-27T13:00:00.000Z' })];
		// 1 hour ago, threshold 30 min
		expect(shouldShowDiaperNudge(diapers, 30 * 60 * 1000)).toBe(true);
	});
});

describe('collectTagSheetEvents', () => {
	it('returns empty array when nothing changed', () => {
		const t = '2026-03-27T10:00:00.000Z';
		const events = collectTagSheetEvents('slp_1', t, t, null, null, null, '');
		expect(events).toEqual([]);
	});

	it('returns only time adjust event when time changed', () => {
		const events = collectTagSheetEvents(
			'slp_1',
			'2026-03-27T10:00:00.000Z',
			'2026-03-27T09:55:00.000Z',
			null,
			null,
			null,
			'',
		);
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe('sleep.updated');
	});

	it('returns only tag event when tags selected', () => {
		const t = '2026-03-27T10:00:00.000Z';
		const events = collectTagSheetEvents('slp_1', t, t, 'normal', 'bed', null, '');
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe('sleep.tagged');
	});

	it('returns both events when time changed and tags selected', () => {
		const events = collectTagSheetEvents(
			'slp_1',
			'2026-03-27T10:00:00.000Z',
			'2026-03-27T09:55:00.000Z',
			'upset',
			'nursing',
			'5-15',
			'cried',
		);
		expect(events).toHaveLength(2);
		expect(events[0].type).toBe('sleep.updated');
		expect(events[1].type).toBe('sleep.tagged');
	});

	it('puts time adjust before tag event', () => {
		const events = collectTagSheetEvents(
			'slp_1',
			'2026-03-27T10:00:00.000Z',
			'2026-03-27T09:59:00.000Z',
			'normal',
			null,
			null,
			'',
		);
		expect(events[0].type).toBe('sleep.updated');
		expect(events[1].type).toBe('sleep.tagged');
	});
});
