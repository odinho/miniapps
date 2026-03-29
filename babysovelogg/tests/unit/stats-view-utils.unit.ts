import { describe, it, expect } from "bun:test";
import {
	dayLabel,
	fmtDate,
	buildBars,
	getMaxMin,
	buildYTicks,
	buildGridLines,
	buildBarGeometries,
	computeDiaperStats,
	buildTrendRows,
	getBestWorst,
	computeAllStats,
	CHART,
	type BarData,
} from "$lib/stats-view-utils.js";
import type { WeekStats } from "$lib/engine/stats.js";
import type { DiaperLogRow, SleepEntry } from "$lib/types.js";

// ── dayLabel ────────────────────────────────────────────────────

describe("dayLabel", () => {
	it("returns short Norwegian weekday", () => {
		const result = dayLabel("2026-03-23"); // Monday
		expect(result).toBeTruthy();
		expect(typeof result).toBe("string");
		expect(result.length).toBeLessThanOrEqual(4);
	});
});

// ── fmtDate ─────────────────────────────────────────────────────

describe("fmtDate", () => {
	it("returns short formatted date", () => {
		const result = fmtDate("2026-03-23");
		expect(result).toBeTruthy();
		expect(typeof result).toBe("string");
	});
});

// ── buildBars ───────────────────────────────────────────────────

describe("buildBars", () => {
	it("extracts bar data from week stats", () => {
		const ws: WeekStats = {
			days: [
				{ date: "2026-03-20", stats: { totalNapMinutes: 90, totalNightMinutes: 120, napCount: 2, sleeps: [] } },
				{ date: "2026-03-21", stats: { totalNapMinutes: 60, totalNightMinutes: 0, napCount: 1, sleeps: [] } },
			],
			avgNapMinutesPerDay: 75,
			avgNightMinutesPerDay: 60,
			avgNapsPerDay: 1.5,
		};
		const bars = buildBars(ws);
		expect(bars).toHaveLength(2);
		expect(bars[0].napMin).toBe(90);
		expect(bars[0].nightMin).toBe(120);
		expect(bars[1].napMin).toBe(60);
	});

	it("limits to last 7 days", () => {
		const days = Array.from({ length: 10 }, (_, i) => ({
			date: `2026-03-${String(10 + i).padStart(2, "0")}`,
			stats: { totalNapMinutes: i * 10, totalNightMinutes: 0, napCount: 1, sleeps: [] },
		}));
		const ws: WeekStats = { days, avgNapMinutesPerDay: 0, avgNightMinutesPerDay: 0, avgNapsPerDay: 0 };
		expect(buildBars(ws)).toHaveLength(7);
	});

	it("returns empty for no days", () => {
		const ws: WeekStats = { days: [], avgNapMinutesPerDay: 0, avgNightMinutesPerDay: 0, avgNapsPerDay: 0 };
		expect(buildBars(ws)).toHaveLength(0);
	});
});

// ── getMaxMin ───────────────────────────────────────────────────

describe("getMaxMin", () => {
	it("returns at least 60", () => {
		expect(getMaxMin([])).toBe(60);
		expect(getMaxMin([{ date: "d", dayLabel: "d", napMin: 10, nightMin: 10 }])).toBe(60);
	});

	it("returns max of nap + night", () => {
		const bars: BarData[] = [
			{ date: "d1", dayLabel: "d", napMin: 100, nightMin: 200 },
			{ date: "d2", dayLabel: "d", napMin: 50, nightMin: 50 },
		];
		expect(getMaxMin(bars)).toBe(300);
	});
});

// ── buildYTicks ─────────────────────────────────────────────────

describe("buildYTicks", () => {
	it("returns 4 ticks", () => {
		const ticks = buildYTicks(240);
		expect(ticks).toHaveLength(4);
	});

	it("tick labels are in hours", () => {
		const ticks = buildYTicks(240);
		expect(ticks[3].label).toBe("4h");
	});

	it("y decreases as value increases", () => {
		const ticks = buildYTicks(240);
		expect(ticks[0].y).toBeGreaterThan(ticks[3].y);
	});
});

// ── buildGridLines ──────────────────────────────────────────────

describe("buildGridLines", () => {
	it("returns 5 lines (0 to 4)", () => {
		expect(buildGridLines(240)).toHaveLength(5);
	});
});

// ── buildBarGeometries ──────────────────────────────────────────

describe("buildBarGeometries", () => {
	it("computes geometry for each bar", () => {
		const bars: BarData[] = [
			{ date: "d1", dayLabel: "d", napMin: 60, nightMin: 120 },
			{ date: "d2", dayLabel: "d", napMin: 30, nightMin: 0 },
		];
		const geom = buildBarGeometries(bars, 180);
		expect(geom).toHaveLength(2);
		expect(geom[0].x).toBeLessThan(geom[1].x);
		expect(geom[0].napH).toBeGreaterThan(0);
		expect(geom[0].nightH).toBeGreaterThan(0);
		expect(geom[1].nightH).toBe(0);
	});

	it("bar width capped at 36", () => {
		const bars: BarData[] = [{ date: "d1", dayLabel: "d", napMin: 60, nightMin: 0 }];
		const geom = buildBarGeometries(bars, 60);
		expect(geom[0].barW).toBeLessThanOrEqual(36);
	});

	it("baseY equals PAD_T + chartH", () => {
		const bars: BarData[] = [{ date: "d1", dayLabel: "d", napMin: 60, nightMin: 0 }];
		const geom = buildBarGeometries(bars, 60);
		expect(geom[0].baseY).toBe(CHART.PAD_T + CHART.H - CHART.PAD_T - CHART.PAD_B);
	});
});

// ── computeDiaperStats ──────────────────────────────────────────

function mkDiaper(type: string, time: string): DiaperLogRow {
	return { id: 1, baby_id: 1, time, type, amount: null, note: null, deleted: 0, domain_id: "d", created_by_event_id: null, updated_by_event_id: null };
}

describe("computeDiaperStats", () => {
	it("counts wet/dirty/both", () => {
		const d = [
			mkDiaper("wet", "2026-03-20T10:00:00"),
			mkDiaper("wet", "2026-03-20T12:00:00"),
			mkDiaper("dirty", "2026-03-20T14:00:00"),
			mkDiaper("both", "2026-03-21T08:00:00"),
		];
		const s = computeDiaperStats(d);
		expect(s.total).toBe(4);
		expect(s.wetCount).toBe(2);
		expect(s.dirtyCount).toBe(1);
		expect(s.bothCount).toBe(1);
	});

	it("calculates perDay across unique days", () => {
		const d = [
			mkDiaper("wet", "2026-03-20T10:00:00"),
			mkDiaper("wet", "2026-03-20T12:00:00"),
			mkDiaper("dirty", "2026-03-21T14:00:00"),
		];
		const s = computeDiaperStats(d);
		expect(s.perDay).toBe(1.5);
	});

	it("potty success rate null when < 3 potty entries", () => {
		const d = [
			mkDiaper("potty_wet", "2026-03-20T10:00:00"),
			mkDiaper("potty_nothing", "2026-03-20T12:00:00"),
		];
		const s = computeDiaperStats(d);
		expect(s.pottyCount).toBe(2);
		expect(s.pottySuccessRate).toBeNull();
	});

	it("potty success rate calculated when >= 3 entries", () => {
		const d = [
			mkDiaper("potty_wet", "2026-03-20T10:00:00"),
			mkDiaper("potty_dirty", "2026-03-20T12:00:00"),
			mkDiaper("potty_nothing", "2026-03-20T14:00:00"),
		];
		const s = computeDiaperStats(d);
		expect(s.pottyCount).toBe(3);
		expect(s.pottySuccessRate).toBe(67); // 2/3
	});

	it("handles empty array", () => {
		const s = computeDiaperStats([]);
		expect(s.total).toBe(0);
		expect(s.perDay).toBe(0);
		expect(s.pottySuccessRate).toBeNull();
	});
});

// ── buildTrendRows ──────────────────────────────────────────────

describe("buildTrendRows", () => {
	const ws7: WeekStats = {
		days: [],
		avgNapMinutesPerDay: 120,
		avgNightMinutesPerDay: 180,
		avgNapsPerDay: 2,
	};
	const ws30: WeekStats = {
		days: [],
		avgNapMinutesPerDay: 100,
		avgNightMinutesPerDay: 200,
		avgNapsPerDay: 1.8,
	};

	it("returns 5 rows (1 header + 4 data)", () => {
		const rows = buildTrendRows(ws7, ws30);
		expect(rows).toHaveLength(5);
	});

	it("first row is header", () => {
		const rows = buildTrendRows(ws7, ws30);
		expect(rows[0].isHeader).toBe(true);
		expect(rows[0].val7).toBe("7 dagar");
		expect(rows[0].val30).toBe("30 dagar");
	});

	it("total sleep row computed correctly", () => {
		const rows = buildTrendRows(ws7, ws30);
		const totalRow = rows[1];
		expect(totalRow.label).toBe("Total søvn/dag");
		expect(totalRow.val7).toBe("5h 0m"); // (120+180) min
		expect(totalRow.val30).toBe("5h 0m"); // (100+200) min
	});

	it("naps per day shown as string", () => {
		const rows = buildTrendRows(ws7, ws30);
		const napRow = rows[3];
		expect(napRow.label).toBe("Lurar/dag");
		expect(napRow.val7).toBe("2");
		expect(napRow.val30).toBe("1.8");
	});
});

// ── getBestWorst ────────────────────────────────────────────────

describe("getBestWorst", () => {
	it("returns null when < 2 days with data", () => {
		const ws: WeekStats = {
			days: [{ date: "2026-03-20", stats: { totalNapMinutes: 60, totalNightMinutes: 0, napCount: 1, sleeps: [] } }],
			avgNapMinutesPerDay: 60,
			avgNightMinutesPerDay: 0,
			avgNapsPerDay: 1,
		};
		expect(getBestWorst(ws)).toBeNull();
	});

	it("returns null when all days have 0 sleep", () => {
		const ws: WeekStats = {
			days: [
				{ date: "2026-03-20", stats: { totalNapMinutes: 0, totalNightMinutes: 0, napCount: 0, sleeps: [] } },
				{ date: "2026-03-21", stats: { totalNapMinutes: 0, totalNightMinutes: 0, napCount: 0, sleeps: [] } },
			],
			avgNapMinutesPerDay: 0,
			avgNightMinutesPerDay: 0,
			avgNapsPerDay: 0,
		};
		expect(getBestWorst(ws)).toBeNull();
	});

	it("correctly identifies best and worst days", () => {
		const ws: WeekStats = {
			days: [
				{ date: "2026-03-20", stats: { totalNapMinutes: 60, totalNightMinutes: 120, napCount: 1, sleeps: [] } },
				{ date: "2026-03-21", stats: { totalNapMinutes: 30, totalNightMinutes: 60, napCount: 1, sleeps: [] } },
				{ date: "2026-03-22", stats: { totalNapMinutes: 90, totalNightMinutes: 180, napCount: 2, sleeps: [] } },
			],
			avgNapMinutesPerDay: 60,
			avgNightMinutesPerDay: 120,
			avgNapsPerDay: 1.3,
		};
		const result = getBestWorst(ws);
		expect(result).not.toBeNull();
		expect(result!.best.date).toBe("2026-03-22"); // 270 min
		expect(result!.worst.date).toBe("2026-03-21"); // 90 min
		expect(result!.best.duration).toBe("4h 30m");
		expect(result!.worst.duration).toBe("1h 30m");
	});
});

// ── computeAllStats ─────────────────────────────────────────────

describe("computeAllStats", () => {
	const now = Date.now();
	const sleeps: SleepEntry[] = [
		{
			start_time: new Date(now - 4 * 3600000).toISOString(),
			end_time: new Date(now - 3 * 3600000).toISOString(),
			type: "nap",
		},
		{
			start_time: new Date(now - 10 * 3600000).toISOString(),
			end_time: new Date(now - 2 * 3600000).toISOString(),
			type: "night",
		},
	];

	it("produces all computed fields", () => {
		const result = computeAllStats(sleeps, []);
		expect(result.weekStats).toBeDefined();
		expect(result.allStats).toBeDefined();
		expect(result.bars.length).toBeGreaterThan(0);
		expect(result.barGeometries.length).toBeGreaterThan(0);
		expect(result.yTicks).toHaveLength(4);
		expect(result.gridLines).toHaveLength(5);
		expect(result.trendRows).toHaveLength(5);
		expect(result.diaperStats7).toBeNull();
		expect(result.diaperStats30).toBeNull();
	});

	it("computes diaper stats when diapers present", () => {
		const diapers: DiaperLogRow[] = [
			mkDiaper("wet", new Date(now - 3600000).toISOString()),
		];
		const result = computeAllStats(sleeps, diapers);
		expect(result.diaperStats7).not.toBeNull();
		expect(result.diaperStats7!.total).toBe(1);
		expect(result.diaperStats30).not.toBeNull();
	});

	it("empty sleeps with empty diapers give null diaper stats", () => {
		const result = computeAllStats([], []);
		expect(result.diaperStats7).toBeNull();
	});

	it("preserves pauses in mapped sleeps", () => {
		const withPause: SleepEntry[] = [
			{
				start_time: new Date(now - 3600000).toISOString(),
				end_time: new Date(now).toISOString(),
				type: "nap",
				pauses: [
					{
						pause_time: new Date(now - 2400000).toISOString(),
						resume_time: new Date(now - 1800000).toISOString(),
					},
				],
			},
		];
		const result = computeAllStats(withPause, []);
		// Should not crash; pauses are passed through
		expect(result.weekStats.days.length).toBeGreaterThan(0);
	});
});
