import { describe, it, expect } from 'vitest';
import {
	WOKE_OPTIONS,
	buildWakeUpEvent,
	getBedtimeSummary,
} from '$lib/wake-sheet-actions.js';
import type { SleepLogRow } from '$lib/types.js';

function makeSleep(overrides: Partial<SleepLogRow> = {}): SleepLogRow {
	return {
		id: 1,
		baby_id: 1,
		start_time: '2026-03-27T10:00:00.000Z',
		end_time: '2026-03-27T11:00:00.000Z',
		type: 'nap',
		notes: null,
		mood: null,
		method: null,
		fall_asleep_time: null,
		woke_by: null,
		wake_notes: null,
		deleted: 0,
		domain_id: 'slp_test1',
		created_by_event_id: null,
		updated_by_event_id: null,
		...overrides,
	};
}

describe('WOKE_OPTIONS', () => {
	it('has self and woken options', () => {
		expect(WOKE_OPTIONS).toHaveLength(2);
		expect(WOKE_OPTIONS[0].value).toBe('self');
		expect(WOKE_OPTIONS[1].value).toBe('woken');
	});

	it('has Norwegian labels', () => {
		expect(WOKE_OPTIONS[0].label).toBe('Vakna sjølv');
		expect(WOKE_OPTIONS[1].label).toBe('Vekt av oss');
	});
});

describe('buildWakeUpEvent', () => {
	it('returns null when nothing is entered', () => {
		expect(buildWakeUpEvent('slp_1', null, '')).toBeNull();
	});

	it('returns null when notes are only whitespace', () => {
		expect(buildWakeUpEvent('slp_1', null, '   ')).toBeNull();
	});

	it('builds event when wokeBy is selected', () => {
		const evt = buildWakeUpEvent('slp_1', 'self', '');
		expect(evt).not.toBeNull();
		expect(evt!.type).toBe('sleep.updated');
		expect(evt!.payload.sleepDomainId).toBe('slp_1');
		expect(evt!.payload.wokeBy).toBe('self');
		expect(evt!.payload.wakeNotes).toBeUndefined();
	});

	it('builds event when woken is selected', () => {
		const evt = buildWakeUpEvent('slp_1', 'woken', '');
		expect(evt!.payload.wokeBy).toBe('woken');
	});

	it('builds event when only notes are provided', () => {
		const evt = buildWakeUpEvent('slp_1', null, 'Glad og uthvilt');
		expect(evt!.type).toBe('sleep.updated');
		expect(evt!.payload.wokeBy).toBeUndefined();
		expect(evt!.payload.wakeNotes).toBe('Glad og uthvilt');
	});

	it('trims whitespace from notes', () => {
		const evt = buildWakeUpEvent('slp_1', null, '  test  ');
		expect(evt!.payload.wakeNotes).toBe('test');
	});

	it('builds event with both wokeBy and notes', () => {
		const evt = buildWakeUpEvent('slp_1', 'self', 'Glad og uthvilt');
		expect(evt!.payload).toEqual({
			sleepDomainId: 'slp_1',
			wokeBy: 'self',
			wakeNotes: 'Glad og uthvilt',
		});
	});

	it('preserves sleepDomainId', () => {
		const evt = buildWakeUpEvent('slp_abc123', 'self', '');
		expect(evt!.payload.sleepDomainId).toBe('slp_abc123');
	});

	it('does not include mood/method/bedtime fields', () => {
		const evt = buildWakeUpEvent('slp_1', 'self', 'note');
		const payload = evt!.payload as Record<string, unknown>;
		expect(payload).not.toHaveProperty('mood');
		expect(payload).not.toHaveProperty('method');
		expect(payload).not.toHaveProperty('fallAsleepTime');
		expect(payload).not.toHaveProperty('notes');
		expect(payload).not.toHaveProperty('startTime');
		expect(payload).not.toHaveProperty('endTime');
	});
});

describe('getBedtimeSummary', () => {
	it('returns hasTags=false when no bedtime data', () => {
		const result = getBedtimeSummary(makeSleep());
		expect(result.hasTags).toBe(false);
		expect(result.badges).toEqual([]);
		expect(result.fallAsleepLabel).toBeNull();
		expect(result.notes).toBeNull();
	});

	it('returns mood badge', () => {
		const result = getBedtimeSummary(makeSleep({ mood: 'normal' }));
		expect(result.hasTags).toBe(true);
		expect(result.badges).toHaveLength(1);
		expect(result.badges[0].emoji).toBe('😊');
		expect(result.badges[0].title).toBe('normal');
	});

	it('returns method badge', () => {
		const result = getBedtimeSummary(makeSleep({ method: 'nursing' }));
		expect(result.hasTags).toBe(true);
		expect(result.badges).toHaveLength(1);
		expect(result.badges[0].emoji).toBe('🤱');
		expect(result.badges[0].title).toBe('nursing');
	});

	it('returns both mood and method badges', () => {
		const result = getBedtimeSummary(makeSleep({ mood: 'normal', method: 'nursing' }));
		expect(result.badges).toHaveLength(2);
		expect(result.badges[0].emoji).toBe('😊');
		expect(result.badges[1].emoji).toBe('🤱');
	});

	it('returns fall asleep label with known bucket', () => {
		const result = getBedtimeSummary(makeSleep({ fall_asleep_time: '5-15' }));
		expect(result.hasTags).toBe(true);
		expect(result.fallAsleepLabel).toBe('5–15 min');
	});

	it('returns fall asleep label with unknown bucket', () => {
		const result = getBedtimeSummary(makeSleep({ fall_asleep_time: 'custom' }));
		expect(result.fallAsleepLabel).toBe('custom');
	});

	it('returns notes', () => {
		const result = getBedtimeSummary(makeSleep({ notes: 'Roleg kveld' }));
		expect(result.hasTags).toBe(true);
		expect(result.notes).toBe('Roleg kveld');
	});

	it('returns full summary with all bedtime data', () => {
		const result = getBedtimeSummary(
			makeSleep({
				mood: 'upset',
				method: 'held',
				fall_asleep_time: '15-30',
				notes: 'Tung kveld',
			}),
		);
		expect(result.hasTags).toBe(true);
		expect(result.badges).toHaveLength(2);
		expect(result.fallAsleepLabel).toBe('15–30 min');
		expect(result.notes).toBe('Tung kveld');
	});

	it('ignores unknown mood values without emoji', () => {
		const result = getBedtimeSummary(makeSleep({ mood: 'unknown_mood' }));
		expect(result.badges).toHaveLength(0);
		// hasTags is false because no badges, no fallAsleep, no notes
		expect(result.hasTags).toBe(false);
	});

	it('ignores unknown method values without emoji', () => {
		const result = getBedtimeSummary(makeSleep({ method: 'unknown_method' }));
		expect(result.badges).toHaveLength(0);
		expect(result.hasTags).toBe(false);
	});

	it('does not include woke_by or wake_notes in summary', () => {
		const result = getBedtimeSummary(
			makeSleep({ woke_by: 'self', wake_notes: 'Glad' }),
		);
		expect(result.hasTags).toBe(false);
		expect(result.badges).toEqual([]);
	});
});
