import { describe, it, expect, beforeAll, afterAll, setSystemTime } from 'bun:test';
import {
	NAP_OPTIONS,
	POTTY_OPTIONS,
	buildBabyEvent,
	validateSettings,
	getSleepNeedForAge,
	getNapCountForAge,
	getNextSleepMilestone,
	buildSleepInfoRows,
	buildPredictionRows,
	formatAge,
} from '../../src/lib/settings-utils.js';

// --- Constants ---

describe('NAP_OPTIONS', () => {
	it('has 6 options starting with Auto', () => {
		expect(NAP_OPTIONS).toHaveLength(6);
		expect(NAP_OPTIONS[0]).toEqual({ value: null, label: 'Auto' });
		expect(NAP_OPTIONS[5]).toEqual({ value: 4, label: '4' });
	});

	it('Auto has null value, rest are 0-4', () => {
		expect(NAP_OPTIONS.map((o) => o.value)).toEqual([null, 0, 1, 2, 3, 4]);
	});
});

describe('POTTY_OPTIONS', () => {
	it('has 2 options: diaper and potty', () => {
		expect(POTTY_OPTIONS).toHaveLength(2);
		expect(POTTY_OPTIONS[0].value).toBe(false);
		expect(POTTY_OPTIONS[1].value).toBe(true);
	});
});

// --- Event builders ---

describe('buildBabyEvent', () => {
	it('builds baby.created for new baby', () => {
		const ev = buildBabyEvent({ name: 'Halldis', birthdate: '2025-06-15' }, true);
		expect(ev.type).toBe('baby.created');
		expect(ev.payload).toMatchObject({ name: 'Halldis', birthdate: '2025-06-15' });
		expect(ev.payload).toHaveProperty('timezone');
		expect(ev.payload).not.toHaveProperty('customNapCount');
		expect(ev.payload).not.toHaveProperty('pottyMode');
	});

	it('builds baby.updated for existing baby with all fields', () => {
		const ev = buildBabyEvent(
			{ name: 'Halldis', birthdate: '2025-06-15', customNapCount: 2, pottyMode: true },
			false,
		);
		expect(ev.type).toBe('baby.updated');
		expect(ev.payload).toEqual({
			name: 'Halldis',
			birthdate: '2025-06-15',
			customNapCount: 2,
			pottyMode: true,
			targetBedtime: null,
		});
	});

	it('sets null for customNapCount when not provided on update', () => {
		const ev = buildBabyEvent({ name: 'Test', birthdate: '2025-01-01' }, false);
		expect(ev.payload.customNapCount).toBeNull();
		expect(ev.payload.pottyMode).toBe(false);
	});
});

// --- Validation ---

describe('validateSettings', () => {
	it('rejects empty name', () => {
		const r = validateSettings('', '2025-01-01');
		expect(r.valid).toBe(false);
		expect(r.nameError).toBe(true);
		expect(r.dateError).toBe(false);
		expect(r.message).toBe('Skriv inn namn');
	});

	it('rejects whitespace-only name', () => {
		const r = validateSettings('   ', '2025-01-01');
		expect(r.valid).toBe(false);
		expect(r.nameError).toBe(true);
	});

	it('rejects empty birthdate', () => {
		const r = validateSettings('Halldis', '');
		expect(r.valid).toBe(false);
		expect(r.dateError).toBe(true);
		expect(r.nameError).toBe(false);
		expect(r.message).toBe('Vel termindato');
	});

	it('rejects both empty', () => {
		const r = validateSettings('', '');
		expect(r.valid).toBe(false);
		expect(r.nameError).toBe(true);
		expect(r.dateError).toBe(true);
		expect(r.message).toBe('Skriv inn namn');
	});

	it('accepts valid input', () => {
		const r = validateSettings('Halldis', '2025-06-15');
		expect(r.valid).toBe(true);
		expect(r.nameError).toBe(false);
		expect(r.dateError).toBe(false);
		expect(r.message).toBeNull();
	});
});

// --- Sleep info for age ---

describe('getSleepNeedForAge', () => {
	it('returns correct range for each bracket', () => {
		expect(getSleepNeedForAge(1)).toBe('14–17 timar');
		expect(getSleepNeedForAge(4)).toBe('13–16 timar');
		expect(getSleepNeedForAge(7)).toBe('12–15 timar');
		expect(getSleepNeedForAge(10)).toBe('12–14 timar');
		expect(getSleepNeedForAge(15)).toBe('11–14 timar');
		expect(getSleepNeedForAge(20)).toBe('11–13 timar');
	});
});

describe('getNapCountForAge', () => {
	it('returns correct range for each bracket', () => {
		expect(getNapCountForAge(2)).toBe('4–5 lurar');
		expect(getNapCountForAge(5)).toBe('3 lurar');
		expect(getNapCountForAge(8)).toBe('2–3 lurar');
		expect(getNapCountForAge(11)).toBe('2 lurar');
		expect(getNapCountForAge(14)).toBe('1–2 lurar');
		expect(getNapCountForAge(20)).toBe('1 lur');
	});
});

describe('getNextSleepMilestone', () => {
	it('returns milestone for young babies', () => {
		expect(getNextSleepMilestone(2)).toContain('3 mnd');
	});

	it('returns 4-month regression milestone', () => {
		expect(getNextSleepMilestone(3)).toContain('4 mnd');
		expect(getNextSleepMilestone(3)).toContain('regresjon');
	});

	it('returns null for 18+ months', () => {
		expect(getNextSleepMilestone(18)).toBeNull();
		expect(getNextSleepMilestone(24)).toBeNull();
	});

	it('returns milestone for each bracket', () => {
		expect(getNextSleepMilestone(5)).toContain('6 mnd');
		expect(getNextSleepMilestone(8)).toContain('9 mnd');
		expect(getNextSleepMilestone(11)).toContain('12 mnd');
		expect(getNextSleepMilestone(15)).toContain('18 mnd');
	});
});

describe('buildSleepInfoRows', () => {
	it('returns budget rows + detail rows', () => {
		const rows = buildSleepInfoRows(9);
		const main = rows.filter(r => !r.detail);
		const detail = rows.filter(r => r.detail);
		expect(main).toHaveLength(4);
		expect(main[0].label).toBe('Søvn totalt');
		expect(main[1].label).toBe('Nattesøvn');
		expect(main[2].label).toBe('Lurar');
		expect(main[3].label).toBe('Vaken totalt');
		// 2-nap baby has 3 positional wake windows
		expect(detail).toHaveLength(3);
		expect(detail[0].label).toBe('Morgon');
		expect(detail[2].label).toBe('Kveld');
	});

	it('24h budget adds up for 9-month-old', () => {
		const rows = buildSleepInfoRows(9);
		expect(rows[0].value).toContain('14t');
		expect(rows[3].value).toContain('10t');
		expect(rows[2].value).toContain('2 ×');
		expect(rows[1].value).toContain('12.5t');
	});

	it('24h budget adds up for 1-month-old', () => {
		const rows = buildSleepInfoRows(1);
		expect(rows[0].value).toContain('15.5t');
		expect(rows[3].value).toContain('8.5t');
	});

	it('1-nap baby has 2 positional windows', () => {
		const rows = buildSleepInfoRows(15); // 12-18 months: 1 nap
		const detail = rows.filter(r => r.detail);
		expect(detail).toHaveLength(2);
		expect(detail[0].label).toBe('Morgon');
		expect(detail[1].label).toBe('Kveld');
	});
});

// --- Prediction panel ---

describe('buildPredictionRows', () => {
	it('always includes expected naps row', () => {
		const rows = buildPredictionRows({
			ageMonths: 6,
			napCount: null,
			completedNaps: 1,
			wakeTime: null,
			recentSleeps: [],
			serverPrediction: null,
			totalSleepMinutes: 0,
		});
		expect(rows.length).toBeGreaterThanOrEqual(1);
		expect(rows[0].label).toBe('Forventa lurar i dag');
		expect(rows[0].value).toContain('1 av');
	});

	it('uses custom nap count when provided', () => {
		const rows = buildPredictionRows({
			ageMonths: 6,
			napCount: 3,
			completedNaps: 0,
			wakeTime: null,
			recentSleeps: [],
			serverPrediction: null,
			totalSleepMinutes: 0,
		});
		expect(rows[0].value).toBe('0 av 3');
	});

	it('includes sleep-in-day when totalSleepMinutes > 0', () => {
		const rows = buildPredictionRows({
			ageMonths: 6,
			napCount: null,
			completedNaps: 1,
			wakeTime: null,
			recentSleeps: [],
			serverPrediction: null,
			totalSleepMinutes: 90,
		});
		const sleepRow = rows.find((r) => r.label === 'Søvn i dag');
		expect(sleepRow).toBeDefined();
		expect(sleepRow!.value).toBe('1h 30m');
	});

	it('uses server prediction when wakeTime and serverPrediction available', () => {
		const rows = buildPredictionRows({
			ageMonths: 6,
			napCount: 2,
			completedNaps: 0,
			wakeTime: '2026-03-27T06:00:00.000Z',
			recentSleeps: [],
			serverPrediction: {
				predictedNaps: [
					{ startTime: '2026-03-27T08:30:00Z', endTime: '2026-03-27T09:15:00Z' },
					{ startTime: '2026-03-27T12:00:00Z', endTime: '2026-03-27T12:45:00Z' },
				],
				bedtime: '2026-03-27T18:00:00Z',
			},
			totalSleepMinutes: 0,
		});
		// Should include Lur 1, Lur 2, Leggetid
		const lurRows = rows.filter((r) => r.label.startsWith('Lur'));
		expect(lurRows).toHaveLength(2);
		const bedtime = rows.find((r) => r.label === 'Leggetid');
		expect(bedtime).toBeDefined();
		expect(bedtime!.value).toMatch(/^~/);
	});

	it('falls back to server prediction when no wakeTime', () => {
		const rows = buildPredictionRows({
			ageMonths: 6,
			napCount: null,
			completedNaps: 0,
			wakeTime: null,
			recentSleeps: [],
			serverPrediction: {
				predictedNaps: [
					{ startTime: '2026-03-27T09:00:00Z', endTime: '2026-03-27T10:00:00Z' },
				],
				bedtime: '2026-03-27T19:00:00Z',
			},
			totalSleepMinutes: 0,
		});
		const lurRows = rows.filter((r) => r.label.startsWith('Lur'));
		expect(lurRows).toHaveLength(1);
		expect(rows.find((r) => r.label === 'Leggetid')).toBeDefined();
	});
});

// --- Age formatting ---

describe('formatAge', () => {
	// Pin to the 15th to avoid month-boundary flakiness (e.g. Mar 31 - 1 month = Mar 3)
	beforeAll(() => setSystemTime(new Date('2026-03-15T12:00:00Z')));
	afterAll(() => setSystemTime());

	it('returns nyfødd for less than 1 month', () => {
		expect(formatAge('2026-03-05')).toBe('nyfødd');
	});

	it('returns singular for 1 month', () => {
		expect(formatAge('2026-02-15')).toBe('1 månad');
	});

	it('returns plural for 6 months', () => {
		expect(formatAge('2025-09-15')).toBe('6 månader');
	});
});
