import type { SleepEntry, DiaperLogRow } from "$lib/types.js";
import { getWeekStats, getAverageWakeWindow, type WeekStats } from "$lib/engine/stats.js";
import { formatDuration } from "$lib/utils.js";

// ── SVG bar chart helpers ──────────────────────────────────────

export const CHART = {
	W: 320,
	H: 180,
	PAD_L: 36,
	PAD_B: 28,
	PAD_T: 12,
	PAD_R: 8,
} as const;

export interface BarData {
	date: string;
	dayLabel: string;
	napMin: number;
	nightMin: number;
}

export interface BarGeometry {
	bar: BarData;
	x: number;
	barW: number;
	baseY: number;
	napH: number;
	nightH: number;
}

export interface YTick {
	y: number;
	label: string;
}

export function dayLabel(dateStr: string): string {
	const d = new Date(dateStr + "T12:00:00");
	return d.toLocaleDateString("nb-NO", { weekday: "short" });
}

export function fmtDate(d: string): string {
	return new Date(d + "T12:00:00").toLocaleDateString([], {
		weekday: "short",
		month: "short",
		day: "numeric",
	});
}

export function buildBars(weekStats: WeekStats): BarData[] {
	return weekStats.days.slice(-7).map((d) => ({
		date: d.date,
		dayLabel: dayLabel(d.date),
		napMin: d.stats.totalNapMinutes,
		nightMin: d.stats.totalNightMinutes,
	}));
}

export function getMaxMin(bars: BarData[]): number {
	return Math.max(60, ...bars.map((b) => b.napMin + b.nightMin));
}

export function buildYTicks(maxMin: number): YTick[] {
	const chartH = CHART.H - CHART.PAD_T - CHART.PAD_B;
	const ticks: YTick[] = [];
	for (let i = 1; i <= 4; i++) {
		const mins = Math.round((maxMin / 4) * i);
		const y = CHART.PAD_T + chartH - (chartH * mins) / maxMin;
		ticks.push({ y, label: `${Math.round(mins / 60)}h` });
	}
	return ticks;
}

export function buildGridLines(maxMin: number): number[] {
	const chartH = CHART.H - CHART.PAD_T - CHART.PAD_B;
	const lines: number[] = [];
	for (let i = 0; i <= 4; i++) {
		const mins = Math.round((maxMin / 4) * i);
		lines.push(CHART.PAD_T + chartH - (chartH * mins) / maxMin);
	}
	return lines;
}

export function buildBarGeometries(bars: BarData[], maxMin: number): BarGeometry[] {
	const chartW = CHART.W - CHART.PAD_L - CHART.PAD_R;
	const chartH = CHART.H - CHART.PAD_T - CHART.PAD_B;
	const gap = chartW / bars.length;
	const barW = Math.min(36, gap * 0.7);
	const baseY = CHART.PAD_T + chartH;

	return bars.map((bar, i) => {
		const x = CHART.PAD_L + gap * i + (gap - barW) / 2;
		const napH = (bar.napMin / maxMin) * chartH;
		const nightH = (bar.nightMin / maxMin) * chartH;
		return { bar, x, barW, baseY, napH, nightH };
	});
}

// ── Data fetching ──────────────────────────────────────────────

export interface StatsData {
	sleeps: SleepEntry[];
	diapers: DiaperLogRow[];
}

export async function fetchStatsData(): Promise<StatsData> {
	const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
	const [sleepRes, diaperRes] = await Promise.all([
		fetch(`/api/sleeps?from=${thirtyDaysAgo}&limit=500`),
		fetch(`/api/diapers?from=${thirtyDaysAgo}&limit=500`),
	]);
	const sleeps = await sleepRes.json();
	const diapers = await diaperRes.json();
	return { sleeps, diapers };
}

// ── Diaper stats ───────────────────────────────────────────────

export interface DiaperStats {
	total: number;
	perDay: number;
	wetCount: number;
	dirtyCount: number;
	bothCount: number;
	pottyCount: number;
	pottySuccessRate: number | null;
}

export function computeDiaperStats(diapers: DiaperLogRow[]): DiaperStats {
	const total = diapers.length;
	const byDay = new Set(diapers.map((d) => d.time.slice(0, 10)));
	const dayCount = byDay.size || 1;

	let wetCount = 0;
	let dirtyCount = 0;
	let bothCount = 0;
	let pottyTotal = 0;
	let pottySuccess = 0;

	for (const d of diapers) {
		if (d.type === "wet") wetCount++;
		else if (d.type === "dirty") dirtyCount++;
		else if (d.type === "both") bothCount++;

		if (d.type.startsWith("potty_")) {
			pottyTotal++;
			if (d.type === "potty_wet" || d.type === "potty_dirty") pottySuccess++;
		}
	}

	return {
		total,
		perDay: Math.round((total / dayCount) * 10) / 10,
		wetCount,
		dirtyCount,
		bothCount,
		pottyCount: pottyTotal,
		pottySuccessRate:
			pottyTotal >= 3 ? Math.round((pottySuccess / pottyTotal) * 100) : null,
	};
}

// ── Trend computations ─────────────────────────────────────────

export interface TrendRow {
	label: string;
	val7: string;
	val30: string;
	isHeader: boolean;
}

export function buildTrendRows(weekStats: WeekStats, allStats: WeekStats): TrendRow[] {
	const avgTotal7 = weekStats.avgNapMinutesPerDay + weekStats.avgNightMinutesPerDay;
	const avgTotal30 = allStats.avgNapMinutesPerDay + allStats.avgNightMinutesPerDay;

	return [
		{ label: "", val7: "7 dagar", val30: "30 dagar", isHeader: true },
		{
			label: "Total søvn/dag",
			val7: formatDuration(avgTotal7 * 60000),
			val30: formatDuration(avgTotal30 * 60000),
			isHeader: false,
		},
		{
			label: "Snitt lurvarighet",
			val7: formatDuration(
				(weekStats.avgNapMinutesPerDay * 60000) / Math.max(1, weekStats.avgNapsPerDay),
			),
			val30: formatDuration(
				(allStats.avgNapMinutesPerDay * 60000) / Math.max(1, allStats.avgNapsPerDay),
			),
			isHeader: false,
		},
		{
			label: "Lurar/dag",
			val7: String(weekStats.avgNapsPerDay),
			val30: String(allStats.avgNapsPerDay),
			isHeader: false,
		},
		{
			label: "Nattesøvn",
			val7: formatDuration(weekStats.avgNightMinutesPerDay * 60000),
			val30: formatDuration(allStats.avgNightMinutesPerDay * 60000),
			isHeader: false,
		},
	];
}

// ── Best/worst ─────────────────────────────────────────────────

export interface BestWorst {
	best: { date: string; label: string; duration: string };
	worst: { date: string; label: string; duration: string };
}

export function getBestWorst(weekStats: WeekStats): BestWorst | null {
	const daysWithTotal = weekStats.days
		.map((d) => ({
			date: d.date,
			total: d.stats.totalNapMinutes + d.stats.totalNightMinutes,
		}))
		.filter((d) => d.total > 0);

	if (daysWithTotal.length < 2) return null;

	daysWithTotal.sort((a, b) => b.total - a.total);
	const best = daysWithTotal[0];
	const worst = daysWithTotal[daysWithTotal.length - 1];

	return {
		best: {
			date: best.date,
			label: fmtDate(best.date),
			duration: formatDuration(best.total * 60000),
		},
		worst: {
			date: worst.date,
			label: fmtDate(worst.date),
			duration: formatDuration(worst.total * 60000),
		},
	};
}

// ── Compute all stats from raw data ────────────────────────────

export interface ComputedStats {
	weekStats: WeekStats;
	allStats: WeekStats;
	bars: BarData[];
	maxMin: number;
	barGeometries: BarGeometry[];
	yTicks: YTick[];
	gridLines: number[];
	wakeAvg: number | null;
	trendRows: TrendRow[];
	bestWorst: BestWorst | null;
	diaperStats7: DiaperStats | null;
	diaperStats30: DiaperStats | null;
}

export function computeAllStats(
	sleeps: SleepEntry[],
	diapers: DiaperLogRow[],
): ComputedStats {
	const mapped: SleepEntry[] = sleeps.map((s) => ({
		start_time: s.start_time,
		end_time: s.end_time,
		type: s.type,
		pauses: s.pauses,
	}));

	const week7 = mapped.filter(
		(s) => new Date(s.start_time).getTime() > Date.now() - 7 * 86400000,
	);
	const weekStats = getWeekStats(week7);
	const allStats = getWeekStats(mapped);

	const bars = buildBars(weekStats);
	const maxMin = getMaxMin(bars);
	const barGeometries = bars.length > 0 ? buildBarGeometries(bars, maxMin) : [];
	const yTicks = buildYTicks(maxMin);
	const gridLines = buildGridLines(maxMin);

	const wakeAvg = getAverageWakeWindow(week7);
	const trendRows = buildTrendRows(weekStats, allStats);
	const bestWorst = getBestWorst(weekStats);

	const week7Diapers = diapers.filter(
		(d) => new Date(d.time).getTime() > Date.now() - 7 * 86400000,
	);
	const diaperStats7 = diapers.length > 0 ? computeDiaperStats(week7Diapers) : null;
	const diaperStats30 = diapers.length > 0 ? computeDiaperStats(diapers) : null;

	return {
		weekStats,
		allStats,
		bars,
		maxMin,
		barGeometries,
		yTicks,
		gridLines,
		wakeAvg,
		trendRows,
		bestWorst,
		diaperStats7,
		diaperStats30,
	};
}
