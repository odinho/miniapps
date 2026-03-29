import { describe, it, expect } from 'bun:test';
import {
	DIAPER_TYPES,
	DIAPER_AMOUNTS,
	POTTY_RESULTS,
	POTTY_DIAPER_STATUSES,
	shouldHideDiaperStatus,
	buildDiaperEvent,
	buildPottyEvent,
	isValidTime,
} from '$lib/diaper-form-actions.js';

const testId = () => 'dip_test123';

describe('constants', () => {
	it('DIAPER_TYPES has 4 options', () => {
		expect(DIAPER_TYPES).toHaveLength(4);
		expect(DIAPER_TYPES.map((t) => t.value)).toEqual(['wet', 'dirty', 'both', 'dry']);
	});

	it('DIAPER_AMOUNTS has 3 options', () => {
		expect(DIAPER_AMOUNTS).toHaveLength(3);
		expect(DIAPER_AMOUNTS.map((a) => a.value)).toEqual(['lite', 'middels', 'mykje']);
	});

	it('POTTY_RESULTS has 4 options', () => {
		expect(POTTY_RESULTS).toHaveLength(4);
		expect(POTTY_RESULTS.map((r) => r.value)).toEqual([
			'potty_wet',
			'potty_dirty',
			'potty_nothing',
			'diaper_only',
		]);
	});

	it('POTTY_DIAPER_STATUSES has 3 options', () => {
		expect(POTTY_DIAPER_STATUSES).toHaveLength(3);
		expect(POTTY_DIAPER_STATUSES.map((s) => s.value)).toEqual(['dry', 'damp', 'wet']);
	});
});

describe('shouldHideDiaperStatus', () => {
	it('returns true for diaper_only', () => {
		expect(shouldHideDiaperStatus('diaper_only')).toBe(true);
	});

	it('returns false for potty_wet', () => {
		expect(shouldHideDiaperStatus('potty_wet')).toBe(false);
	});

	it('returns false for potty_dirty', () => {
		expect(shouldHideDiaperStatus('potty_dirty')).toBe(false);
	});

	it('returns false for potty_nothing', () => {
		expect(shouldHideDiaperStatus('potty_nothing')).toBe(false);
	});
});

describe('buildDiaperEvent', () => {
	it('builds diaper.logged event with correct type', () => {
		const evt = buildDiaperEvent(1, '2026-03-27T12:00:00.000Z', 'wet', 'middels', '', testId);
		expect(evt.type).toBe('diaper.logged');
	});

	it('includes babyId and time in payload', () => {
		const evt = buildDiaperEvent(42, '2026-03-27T12:00:00.000Z', 'dirty', 'lite', '', testId);
		expect(evt.payload.babyId).toBe(42);
		expect(evt.payload.time).toBe('2026-03-27T12:00:00.000Z');
	});

	it('includes type and amount', () => {
		const evt = buildDiaperEvent(1, '2026-03-27T12:00:00.000Z', 'both', 'mykje', '', testId);
		expect(evt.payload.type).toBe('both');
		expect(evt.payload.amount).toBe('mykje');
	});

	it('generates a diaperDomainId', () => {
		const evt = buildDiaperEvent(1, '2026-03-27T12:00:00.000Z', 'wet', 'middels', '', testId);
		expect(evt.payload.diaperDomainId).toBe('dip_test123');
	});

	it('sets note to null when empty', () => {
		const evt = buildDiaperEvent(1, '2026-03-27T12:00:00.000Z', 'wet', 'middels', '', testId);
		expect(evt.payload.note).toBeNull();
	});

	it('sets note to null when whitespace only', () => {
		const evt = buildDiaperEvent(1, '2026-03-27T12:00:00.000Z', 'wet', 'middels', '   ', testId);
		expect(evt.payload.note).toBeNull();
	});

	it('trims note whitespace', () => {
		const evt = buildDiaperEvent(1, '2026-03-27T12:00:00.000Z', 'wet', 'middels', '  runny  ', testId);
		expect(evt.payload.note).toBe('runny');
	});

	it('preserves meaningful notes', () => {
		const evt = buildDiaperEvent(
			1,
			'2026-03-27T12:00:00.000Z',
			'dirty',
			'lite',
			'after feeding',
			testId,
		);
		expect(evt.payload.note).toBe('after feeding');
	});
});

describe('buildPottyEvent', () => {
	it('builds diaper.logged event', () => {
		const evt = buildPottyEvent(1, '2026-03-27T12:00:00.000Z', 'potty_wet', 'dry', '', testId);
		expect(evt.type).toBe('diaper.logged');
	});

	it('uses potty result as type', () => {
		const evt = buildPottyEvent(1, '2026-03-27T12:00:00.000Z', 'potty_dirty', 'damp', '', testId);
		expect(evt.payload.type).toBe('potty_dirty');
	});

	it('uses diaper status as amount', () => {
		const evt = buildPottyEvent(1, '2026-03-27T12:00:00.000Z', 'potty_wet', 'wet', '', testId);
		expect(evt.payload.amount).toBe('wet');
	});

	it('sets amount to null for diaper_only', () => {
		const evt = buildPottyEvent(1, '2026-03-27T12:00:00.000Z', 'diaper_only', 'dry', '', testId);
		expect(evt.payload.amount).toBeNull();
	});

	it('generates a diaperDomainId', () => {
		const evt = buildPottyEvent(1, '2026-03-27T12:00:00.000Z', 'potty_wet', 'dry', '', testId);
		expect(evt.payload.diaperDomainId).toBe('dip_test123');
	});

	it('trims and nullifies empty notes', () => {
		const evt = buildPottyEvent(1, '2026-03-27T12:00:00.000Z', 'potty_wet', 'dry', '  ', testId);
		expect(evt.payload.note).toBeNull();
	});

	it('preserves meaningful notes', () => {
		const evt = buildPottyEvent(
			1,
			'2026-03-27T12:00:00.000Z',
			'potty_nothing',
			'dry',
			'tried for 5 min',
			testId,
		);
		expect(evt.payload.note).toBe('tried for 5 min');
	});

	it('includes correct babyId and time', () => {
		const evt = buildPottyEvent(7, '2026-03-27T08:30:00.000Z', 'potty_wet', 'damp', '', testId);
		expect(evt.payload.babyId).toBe(7);
		expect(evt.payload.time).toBe('2026-03-27T08:30:00.000Z');
	});
});

describe('isValidTime', () => {
	it('accepts valid ISO date string', () => {
		expect(isValidTime('2026-03-27T12:00:00.000Z')).toBe(true);
	});

	it('accepts valid date string', () => {
		expect(isValidTime('2026-03-27')).toBe(true);
	});

	it('rejects empty string', () => {
		expect(isValidTime('')).toBe(false);
	});

	it('rejects garbage string', () => {
		expect(isValidTime('not-a-date')).toBe(false);
	});

	it('rejects undefined-like string', () => {
		expect(isValidTime('undefined')).toBe(false);
	});
});
