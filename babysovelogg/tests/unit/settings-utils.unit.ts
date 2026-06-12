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
	buildComparisonTable,
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
		expect(ev.payload).not.toHaveProperty('trackDiaper');
	});

	it('builds baby.updated for existing baby with all fields', () => {
		const ev = buildBabyEvent(
			{
				name: 'Halldis',
				birthdate: '2025-06-15',
				customNapCount: 2,
				pottyMode: true,
				trackDiaper: true,
			},
			false,
		);
		expect(ev.type).toBe('baby.updated');
		expect(ev.payload).toEqual({
			name: 'Halldis',
			birthdate: '2025-06-15',
			customNapCount: 2,
			pottyMode: true,
			trackDiaper: true,
			targetBedtime: null,
		});
	});

	it('scopes baby.updated to the given babyId so the edit cannot hit a sibling', () => {
		const ev = buildBabyEvent({ name: 'Ada', birthdate: '2025-06-15' }, false, 1);
		expect(ev.payload.babyId).toBe(1);
	});

	it('omits babyId when none is given (single-baby / replay-compat fallback)', () => {
		const ev = buildBabyEvent({ name: 'Ada', birthdate: '2025-06-15' }, false);
		expect(ev.payload).not.toHaveProperty('babyId');
	});

	it('sets null for customNapCount when not provided on update', () => {
		const ev = buildBabyEvent({ name: 'Test', birthdate: '2025-01-01' }, false);
		expect(ev.payload.customNapCount).toBeNull();
		expect(ev.payload.pottyMode).toBe(false);
		expect(ev.payload.trackDiaper).toBe(false);
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
	it('returns 4 budget rows', () => {
		const rows = buildSleepInfoRows(9);
		expect(rows).toHaveLength(4);
		expect(rows[0].label).toBe('Søvn totalt');
		expect(rows[1].label).toBe('Nattesøvn');
		expect(rows[2].label).toBe('Lurar');
		expect(rows[3].label).toBe('Vaken totalt');
	});

	it('24h budget adds up for 9-month-old', () => {
		const rows = buildSleepInfoRows(9);
		expect(rows[0].value).toContain('14t');
		expect(rows[3].value).toContain('10t');
		expect(rows[2].value).toContain('2 ×');
		// Nap norm comes from SHINE 9mo daytime (~133 min) / 2 = ~67 min/nap.
		// Night fills the remaining ~11.8h.
		expect(rows[1].value).toContain('11.8t');
	});

	it('24h budget adds up for 1-month-old', () => {
		const rows = buildSleepInfoRows(1);
		expect(rows[0].value).toContain('15.5t');
		expect(rows[3].value).toContain('8.5t');
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
		expect(sleepRow!.value).toBe('1t 30m');
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

describe('buildComparisonTable', () => {
	it('shows norm and learned side by side', () => {
		const rows = buildComparisonTable(9, {
			napDurationMin: 120,
			nightDurationMin: 660,
			wakeWindowMin: 270,
			bedtimeWakeWindowMin: 300,
			expectedNapCount: 1,
			});
		expect(rows.length).toBeGreaterThanOrEqual(5);
		// Every row should have both norm and a learned value
		for (const r of rows.filter(row => row.norm)) {
			expect(r.learned).not.toBe('—');
		}
		// Without today data, every today slot is undefined (no third column rendered)
		expect(rows.every(r => r.today === undefined)).toBe(true);
	});

	it('legacy `actual` alias mirrors `learned`', () => {
		const rows = buildComparisonTable(9, {
			napDurationMin: 120,
			nightDurationMin: 660,
			wakeWindowMin: 270,
			bedtimeWakeWindowMin: 300,
			expectedNapCount: 1,
			});
		for (const r of rows) {
			expect(r.actual).toBe(r.learned);
		}
	});

	it('shows altNorm column when baby nap count differs from norm', () => {
		// 9mo norm = 2 naps, but baby does 1
		const rows = buildComparisonTable(9, {
			napDurationMin: 120,
			nightDurationMin: 660,
			wakeWindowMin: 270,
			bedtimeWakeWindowMin: 300,
			expectedNapCount: 1,
			});
		const hasAlt = rows.some(r => r.altNorm !== undefined);
		expect(hasAlt).toBe(true);
		// The nap count row should show the difference
		const napRow = rows.find(r => r.label === 'Lurar');
		expect(napRow?.norm).toBe('2');
		expect(napRow?.learned).toBe('1');
		expect(napRow?.altNorm).toBe('1');
	});

	it('no altNorm when baby matches norm', () => {
		const rows = buildComparisonTable(9, {
			napDurationMin: 45,
			nightDurationMin: 660,
			wakeWindowMin: 180,
			bedtimeWakeWindowMin: 200,
			expectedNapCount: 2,
			});
		const hasAlt = rows.some(r => r.altNorm !== undefined);
		expect(hasAlt).toBe(false);
	});

	it('shows dashes when no learned data', () => {
		const rows = buildComparisonTable(9, null);
		for (const r of rows.filter(row => row.norm)) {
			expect(r.learned).toBe('—');
		}
	});

	it('populates today column when dayTotals + sleeps are provided', () => {
		const rows = buildComparisonTable(
			11,
			{
				napDurationMin: 123,
				nightDurationMin: 659,
				wakeWindowMin: 298,
				bedtimeWakeWindowMin: 386,
				expectedNapCount: 1,
			},
			{
				dayTotals: {
					napMinutes: 113,
					todayNightMinutes: 0,
					priorNightMinutes: 770,
					totalMinutes: 883,
					includesPriorNight: true,
				},
				todaySleeps: [
					{
						start_time: '2026-05-20T11:29:00.000Z',
						end_time: '2026-05-20T13:22:00.000Z',
						type: 'nap',
					} as never,
				],
				completedNapCount: 1,
				expectedNapCount: 1,
				dailyTrendTotalMin: 780,
			},
		);

		const napCount = rows.find(r => r.label === 'Lurar');
		expect(napCount?.today).toBe('1 av 1');
		const napDur = rows.find(r => r.label === 'Lurvarigheit');
		expect(napDur?.today).toBe('1t53');
		const night = rows.find(r => r.label === 'Nattesøvn');
		expect(night?.today).toBe('12t50');
		const total = rows.find(r => r.label === 'Søvn totalt');
		expect(total?.today).toBe('14t43');
		const trend = rows.find(r => r.label === 'Trendmål (7d/30d)');
		expect(trend?.today).toBe('13t');
		expect(trend?.learned).toBe('—');
	});

	it('omits Trendmål row when trend is null (sparse data)', () => {
		const rows = buildComparisonTable(
			9,
			{
				napDurationMin: 90,
				nightDurationMin: 660,
				wakeWindowMin: 180,
				bedtimeWakeWindowMin: 220,
				expectedNapCount: 2,
			},
			{
				dayTotals: null,
				todaySleeps: [],
				completedNapCount: 0,
				expectedNapCount: 2,
				dailyTrendTotalMin: null,
			},
		);
		expect(rows.some(r => r.label === 'Trendmål (7d/30d)')).toBe(false);
	});
});
