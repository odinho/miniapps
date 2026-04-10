import type { SleepEntry, DiaperLogRow } from "$lib/types.js";
import {
	getWeekStats,
	getAverageWakeWindow,
	getLongestNightStretches,
	getWakeWindowGaps,
	buildSleepHeatmap,
	getBedtimes,
	type WeekStats,
	type NightStretch,
	type WakeWindowGap,
	type HeatmapRow,
	type BedtimePoint,
} from "$lib/engine/stats.js";
import { formatDuration } from "$lib/utils.js";
import { isoToDateInTz } from "$lib/tz.js";
import { regressionEquations, sleepDuration } from "$lib/data/galland2012.js";

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
	return new Date(d + "T12:00:00").toLocaleDateString("nb-NO", {
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

// ── Time-series chart shared config ────────────────────────────

export const TS_CHART = {
	W: 360,
	H: 200,
	PAD_L: 40,
	PAD_R: 12,
	PAD_T: 16,
	PAD_B: 32,
} as const;

function tsPlotW(): number { return TS_CHART.W - TS_CHART.PAD_L - TS_CHART.PAD_R; }
function tsPlotH(): number { return TS_CHART.H - TS_CHART.PAD_T - TS_CHART.PAD_B; }

/** Compute a rolling average over an array of values. Returns same-length array with nulls where window is incomplete. */
function rollingAvg(values: number[], window: number): (number | null)[] {
	return values.map((_, i) => {
		if (i < window - 1) return null;
		let sum = 0;
		for (let j = i - window + 1; j <= i; j++) sum += values[j];
		return sum / window;
	});
}

/** Build an SVG path from points, skipping nulls. */
function rollingAvgPath(xs: number[], ys: (number | null)[]): string {
	const segments: string[] = [];
	let inSegment = false;
	for (let i = 0; i < xs.length; i++) {
		if (ys[i] == null) { inSegment = false; continue; }
		segments.push(`${inSegment ? "L" : "M"}${xs[i]},${ys[i]}`);
		inSegment = true;
	}
	return segments.join(" ");
}

/** Map a day index to X coordinate within the time-series plot area. */
function tsX(index: number, total: number): number {
	if (total <= 1) return TS_CHART.PAD_L + tsPlotW() / 2;
	return TS_CHART.PAD_L + (index / (total - 1)) * tsPlotW();
}

// ── Chart B: Total Sleep vs Age Norms ─────────────────────────

export interface NormBandPoint {
	x: number;
	yMin: number;
	yMax: number;
	yTypical: number;
}

export interface SleepVsNormData {
	/** SVG path for the actual sleep area (filled) */
	actualPath: string;
	/** SVG path for the norm band (filled, translucent) */
	bandPath: string;
	/** SVG path for the norm typical line */
	typicalPath: string;
	/** Dot positions for actual data points */
	dots: { x: number; y: number; hours: number; date: string }[];
	/** Y-axis ticks */
	yTicks: { y: number; label: string }[];
	/** X-axis date labels (sparse — first, middle, last) */
	xLabels: { x: number; label: string }[];
	/** Grid lines (y values) */
	gridLines: number[];
	maxHours: number;
}

/** Get Galland norm range for a given age in months, interpolated from discrete bands. */
function gallandRange(ageMonths: number): { min: number; max: number; typical: number } {
	const typical = regressionEquations.sleepDurationHours(Math.max(0.01, ageMonths / 12));
	// Find matching band for upper/lower
	const bands = sleepDuration.ageBands.filter((b) => !("note" in b));
	for (const b of bands) {
		if (ageMonths >= b.ageMonths[0] && ageMonths <= b.ageMonths[1]) {
			return { min: b.lower, max: b.upper, typical };
		}
	}
	// Fallback: use regression ± 3h
	return { min: typical - 3, max: typical + 3, typical };
}

export function buildSleepVsNorm(
	allDays: { date: string; totalHours: number }[],
	birthdate: string,
): SleepVsNormData {
	// Filter out days with no data to avoid misleading drops to zero
	const days = allDays.filter((d) => d.totalHours > 0);
	if (days.length === 0) {
		return { actualPath: "", bandPath: "", typicalPath: "", dots: [], yTicks: [], xLabels: [], gridLines: [], maxHours: 0 };
	}

	const birthMs = new Date(birthdate).getTime();
	const n = days.length;

	// Compute age at each day and norm values
	const points = days.map((d, i) => {
		const dayMs = new Date(d.date + "T12:00:00").getTime();
		const ageMonths = Math.max(0, (dayMs - birthMs) / (30.44 * 24 * 60 * 60 * 1000));
		const norm = gallandRange(ageMonths);
		return { ...d, i, ageMonths, norm };
	});

	// Determine Y-axis range
	const allValues = points.flatMap((p) => [p.totalHours, p.norm.max, p.norm.min]);
	const maxHours = Math.ceil(Math.max(...allValues) + 0.5);
	const minHours = Math.max(0, Math.floor(Math.min(...allValues) - 0.5));
	const range = maxHours - minHours || 1;

	// Y mapping relative to minHours
	const yMap = (h: number) => TS_CHART.PAD_T + tsPlotH() - ((h - minHours) / range) * tsPlotH();

	// Build actual sleep area path (area from baseline to data)
	const baseY = yMap(minHours);
	const actualPoints = points.map((p) => `${tsX(p.i, n)},${yMap(p.totalHours)}`);
	const actualPath = `M${tsX(0, n)},${baseY} L${actualPoints.join(" L")} L${tsX(n - 1, n)},${baseY} Z`;

	// Build norm band polygon (upper forward, lower backward)
	const upperPoints = points.map((p) => `${tsX(p.i, n)},${yMap(p.norm.max)}`);
	const lowerPoints = points.map((p) => `${tsX(p.i, n)},${yMap(p.norm.min)}`).toReversed();
	const bandPath = `M${upperPoints.join(" L")} L${lowerPoints.join(" L")} Z`;

	// Typical line
	const typicalPoints = points.map((p) => `${tsX(p.i, n)},${yMap(p.norm.typical)}`);
	const typicalPath = `M${typicalPoints.join(" L")}`;

	// Dots
	const dots = points.map((p) => ({
		x: tsX(p.i, n),
		y: yMap(p.totalHours),
		hours: Math.round(p.totalHours * 10) / 10,
		date: p.date,
	}));

	// Y-axis ticks (every 2 hours within range)
	const yTicks: { y: number; label: string }[] = [];
	const gridLines: number[] = [];
	for (let h = Math.ceil(minHours); h <= maxHours; h += 2) {
		const y = yMap(h);
		yTicks.push({ y, label: `${h}t` });
		gridLines.push(y);
	}

	// X-axis labels (sparse)
	const xLabels: { x: number; label: string }[] = [];
	const labelIndices = n <= 7
		? points.map((_, i) => i)
		: [0, Math.floor(n / 2), n - 1];
	for (const i of labelIndices) {
		xLabels.push({
			x: tsX(i, n),
			label: new Date(points[i].date + "T12:00:00").toLocaleDateString("nb-NO", { day: "numeric", month: "short" }),
		});
	}

	return { actualPath, bandPath, typicalPath, dots, yTicks, xLabels, gridLines, maxHours };
}

// ── Chart A: 30-Day Stacked Area Trend ────────────────────────

export interface StackedAreaData {
	/** SVG path for night sleep (bottom area) */
	nightPath: string;
	/** SVG path for nap sleep (top area, stacked on night) */
	napPath: string;
	/** 7-day rolling average path for total sleep */
	rollingAvgPath: string;
	/** Y-axis ticks */
	yTicks: { y: number; label: string }[];
	/** X-axis labels */
	xLabels: { x: number; label: string }[];
	/** Grid lines */
	gridLines: number[];
	maxHours: number;
}

export function buildStackedArea(
	allDays: { date: string; napMin: number; nightMin: number }[],
): StackedAreaData {
	// Filter out days with no data to avoid misleading drops to zero
	const days = allDays.filter((d) => d.napMin + d.nightMin > 0);
	if (days.length === 0) {
		return { nightPath: "", napPath: "", rollingAvgPath: "", yTicks: [], xLabels: [], gridLines: [], maxHours: 0 };
	}

	const n = days.length;
	const maxMin = Math.max(60, ...days.map((d) => d.napMin + d.nightMin));
	const maxHours = Math.ceil(maxMin / 60);
	const plotH = tsPlotH();
	const baseY = TS_CHART.PAD_T + plotH;

	const yMap = (min: number) => baseY - (min / maxMin) * plotH;

	// Night area: baseline → night values → baseline
	const nightTopPoints = days.map((d, i) => `${tsX(i, n)},${yMap(d.nightMin)}`);
	const nightPath = `M${tsX(0, n)},${baseY} L${nightTopPoints.join(" L")} L${tsX(n - 1, n)},${baseY} Z`;

	// Nap area: night top → total top → night top (reversed)
	const totalTopPoints = days.map((d, i) => `${tsX(i, n)},${yMap(d.nightMin + d.napMin)}`);
	const napPath = `M${nightTopPoints.join(" L")} L${totalTopPoints.toReversed().join(" L")} Z`;

	// 7-day rolling average for total sleep
	const totals = days.map((d) => d.napMin + d.nightMin);
	const avgValues = rollingAvg(totals, 7);
	const xs = days.map((_, i) => tsX(i, n));
	const avgYs = avgValues.map((v) => v != null ? yMap(v) : null);
	const avgPath = rollingAvgPath(xs, avgYs);

	// Y-axis ticks
	const yTicks: { y: number; label: string }[] = [];
	const gridLines: number[] = [];
	const step = maxHours <= 6 ? 1 : 2;
	for (let h = step; h <= maxHours; h += step) {
		const y = yMap(h * 60);
		yTicks.push({ y, label: `${h}t` });
		gridLines.push(y);
	}

	// X-axis labels
	const xLabels: { x: number; label: string }[] = [];
	const labelIndices = n <= 7
		? days.map((_, i) => i)
		: [0, Math.floor(n / 2), n - 1];
	for (const i of labelIndices) {
		xLabels.push({
			x: tsX(i, n),
			label: new Date(days[i].date + "T12:00:00").toLocaleDateString("nb-NO", { day: "numeric", month: "short" }),
		});
	}

	return { nightPath, napPath, rollingAvgPath: avgPath, yTicks, xLabels, gridLines, maxHours };
}

// ── Chart C: Night Stretch Growth ─────────────────────────────

export interface NightStretchChartData {
	/** SVG polyline path for the line */
	linePath: string;
	/** SVG area path (filled under line) */
	areaPath: string;
	/** 7-day rolling average path */
	rollingAvgPath: string;
	/** Dot positions */
	dots: { x: number; y: number; hours: number; date: string }[];
	/** Y-axis ticks */
	yTicks: { y: number; label: string }[];
	/** X-axis labels */
	xLabels: { x: number; label: string }[];
	/** Grid lines */
	gridLines: number[];
	maxHours: number;
}

export function buildNightStretchChart(
	stretches: NightStretch[],
): NightStretchChartData {
	if (stretches.length === 0) {
		return { linePath: "", areaPath: "", rollingAvgPath: "", dots: [], yTicks: [], xLabels: [], gridLines: [], maxHours: 0 };
	}

	const n = stretches.length;
	const maxMin = Math.max(60, ...stretches.map((s) => s.minutes));
	const maxHours = Math.ceil(maxMin / 60);
	const plotH = tsPlotH();
	const baseY = TS_CHART.PAD_T + plotH;

	const yMap = (min: number) => baseY - (min / maxMin) * plotH;

	const linePoints = stretches.map((s, i) => `${tsX(i, n)},${yMap(s.minutes)}`);
	const linePath = `M${linePoints.join(" L")}`;
	const areaPath = `M${tsX(0, n)},${baseY} L${linePoints.join(" L")} L${tsX(n - 1, n)},${baseY} Z`;

	// 7-day rolling average
	const mins = stretches.map((s) => s.minutes);
	const avgValues = rollingAvg(mins, 7);
	const xs = stretches.map((_, i) => tsX(i, n));
	const avgYs = avgValues.map((v) => v != null ? yMap(v) : null);
	const avgPath = rollingAvgPath(xs, avgYs);

	const dots = stretches.map((s, i) => ({
		x: tsX(i, n),
		y: yMap(s.minutes),
		hours: Math.round((s.minutes / 60) * 10) / 10,
		date: s.date,
	}));

	const yTicks: { y: number; label: string }[] = [];
	const gridLines: number[] = [];
	const step = maxHours <= 4 ? 1 : 2;
	for (let h = step; h <= maxHours; h += step) {
		const y = yMap(h * 60);
		yTicks.push({ y, label: `${h}t` });
		gridLines.push(y);
	}

	const xLabels: { x: number; label: string }[] = [];
	const labelIndices = n <= 7
		? stretches.map((_, i) => i)
		: [0, Math.floor(n / 2), n - 1];
	for (const i of labelIndices) {
		xLabels.push({
			x: tsX(i, n),
			label: new Date(stretches[i].date + "T12:00:00").toLocaleDateString("nb-NO", { day: "numeric", month: "short" }),
		});
	}

	return { linePath, areaPath, rollingAvgPath: avgPath, dots, yTicks, xLabels, gridLines, maxHours };
}

// ── Bedtime Consistency Chart ─────────────────────────────────

function fmtHour(h: number): string {
	const hh = Math.floor(h);
	const mm = Math.round((h - hh) * 60);
	return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export interface BedtimeChartData {
	linePath: string;
	dots: { x: number; y: number; label: string; date: string }[];
	yTicks: { y: number; label: string }[];
	xLabels: { x: number; label: string }[];
	gridLines: number[];
	avgY: number;
	avgLabel: string;
}

export function buildBedtimeChart(
	bedtimes: BedtimePoint[],
): BedtimeChartData {
	if (bedtimes.length === 0) {
		return { linePath: "", dots: [], yTicks: [], xLabels: [], gridLines: [], avgY: 0, avgLabel: "" };
	}

	const n = bedtimes.length;
	// Y-axis: bedtime hours. Inverted — earlier bedtime at top, later at bottom.
	// Typical range: 17:00–23:00
	const hours = bedtimes.map((b) => b.hour);
	const rawMin = Math.floor(Math.min(...hours));
	const rawMax = Math.ceil(Math.max(...hours));
	// Pad range when all bedtimes cluster near same hour
	const minH = rawMax - rawMin < 1 ? rawMin - 1 : rawMin;
	const maxH = rawMax - rawMin < 1 ? rawMax + 1 : rawMax;
	const range = maxH - minH;
	const plotH = tsPlotH();

	// Inverted Y: higher hour value = lower on chart (later bedtime = lower)
	const yMap = (h: number) => TS_CHART.PAD_T + ((h - minH) / range) * plotH;

	const linePoints = bedtimes.map((b, i) => `${tsX(i, n)},${yMap(b.hour)}`);
	const linePath = `M${linePoints.join(" L")}`;

	const dots = bedtimes.map((b, i) => ({
		x: tsX(i, n),
		y: yMap(b.hour),
		label: fmtHour(b.hour),
		date: b.date,
	}));

	// Average bedtime line
	const avgH = hours.reduce((a, b) => a + b, 0) / hours.length;
	const avgY = yMap(avgH);
	const avgLabel = fmtHour(avgH);

	// Y-axis ticks: every hour
	const yTicks: { y: number; label: string }[] = [];
	const gridLines: number[] = [];
	for (let h = minH; h <= maxH; h++) {
		const y = yMap(h);
		yTicks.push({ y, label: fmtHour(h) });
		gridLines.push(y);
	}

	const xLabels: { x: number; label: string }[] = [];
	const labelIndices = n <= 7
		? bedtimes.map((_, i) => i)
		: [0, Math.floor(n / 2), n - 1];
	for (const i of labelIndices) {
		xLabels.push({
			x: tsX(i, n),
			label: new Date(bedtimes[i].date + "T12:00:00").toLocaleDateString("nb-NO", { day: "numeric", month: "short" }),
		});
	}

	return { linePath, dots, yTicks, xLabels, gridLines, avgY, avgLabel };
}

// ── Nap Count Trend Chart ─────────────────────────────────────

export interface NapCountChartData {
	linePath: string;
	rollingAvgPath: string;
	dots: { x: number; y: number; count: number; date: string }[];
	yTicks: { y: number; label: string }[];
	xLabels: { x: number; label: string }[];
	gridLines: number[];
	maxCount: number;
}

export function buildNapCountChart(
	days: { date: string; napCount: number }[],
): NapCountChartData {
	const filtered = days.filter((d) => d.napCount > 0);
	if (filtered.length === 0) {
		return { linePath: "", rollingAvgPath: "", dots: [], yTicks: [], xLabels: [], gridLines: [], maxCount: 0 };
	}

	const n = filtered.length;
	const maxCount = Math.max(1, ...filtered.map((d) => d.napCount));
	const plotH = tsPlotH();
	const baseY = TS_CHART.PAD_T + plotH;

	const yMap = (count: number) => baseY - (count / maxCount) * plotH;

	// Step-style line: horizontal segments between points
	const segments: string[] = [];
	for (let i = 0; i < n; i++) {
		const x = tsX(i, n);
		const y = yMap(filtered[i].napCount);
		if (i === 0) {
			segments.push(`M${x},${y}`);
		} else {
			// Horizontal then vertical (step)
			segments.push(`H${x} V${y}`);
		}
	}
	const linePath = segments.join(" ");

	// Rolling average
	const counts = filtered.map((d) => d.napCount);
	const avgValues = rollingAvg(counts, 7);
	const xs = filtered.map((_, i) => tsX(i, n));
	const avgYs = avgValues.map((v) => v != null ? yMap(v) : null);
	const avgPath = rollingAvgPath(xs, avgYs);

	const dots = filtered.map((d, i) => ({
		x: tsX(i, n),
		y: yMap(d.napCount),
		count: d.napCount,
		date: d.date,
	}));

	const yTicks: { y: number; label: string }[] = [];
	const gridLines: number[] = [];
	for (let c = 1; c <= maxCount; c++) {
		const y = yMap(c);
		yTicks.push({ y, label: `${c}` });
		gridLines.push(y);
	}

	const xLabels: { x: number; label: string }[] = [];
	const labelIndices = n <= 7
		? filtered.map((_, i) => i)
		: [0, Math.floor(n / 2), n - 1];
	for (const i of labelIndices) {
		xLabels.push({
			x: tsX(i, n),
			label: new Date(filtered[i].date + "T12:00:00").toLocaleDateString("nb-NO", { day: "numeric", month: "short" }),
		});
	}

	return { linePath, rollingAvgPath: avgPath, dots, yTicks, xLabels, gridLines, maxCount };
}

// ── Chart D: Sleep Timeline (Gantt) ───────────────────────────

export const GANTT = {
	W: 360,
	ROW_H: 20,
	PAD_L: 56,
	PAD_R: 8,
	PAD_T: 24,
	HOUR_START: 0, // 00:00 left edge — night sleep in the middle
} as const;

export interface GanttBlock {
	x: number;
	w: number;
	y: number;
	type: "nap" | "night";
}

export interface GanttRow {
	date: string;
	dateLabel: string;
	y: number;
	blocks: GanttBlock[];
}

export interface GanttChartData {
	rows: GanttRow[];
	hourLabels: { x: number; label: string }[];
	height: number;
}

export function buildGanttChart(
	sleeps: SleepEntry[],
	days: number,
	tz?: string,
): GanttChartData {
	const completed = sleeps.filter((s) => s.end_time);
	if (completed.length === 0) return { rows: [], hourLabels: [], height: 0 };

	const plotW = GANTT.W - GANTT.PAD_L - GANTT.PAD_R;
	const hoursSpan = 24;

	// Map a fractional hour to x position on the 18:00–18:00 axis
	const hourToX = (h: number): number => {
		let offset = h - GANTT.HOUR_START;
		if (offset < 0) offset += 24;
		return GANTT.PAD_L + (offset / hoursSpan) * plotW;
	};

	// Group by calendar date (00:00–00:00 rows)
	// Sleeps that span midnight appear on BOTH the start date and end date rows.
	const byGanttDate = new Map<string, SleepEntry[]>();
	for (const s of completed) {
		const dateStr = tz ? isoToDateInTz(s.start_time, tz) : s.start_time.slice(0, 10);
		if (!byGanttDate.has(dateStr)) byGanttDate.set(dateStr, []);
		byGanttDate.get(dateStr)!.push(s);
		// If sleep crosses midnight, also add to the end-date row
		if (s.end_time) {
			const endDateStr = tz ? isoToDateInTz(s.end_time, tz) : s.end_time.slice(0, 10);
			if (endDateStr !== dateStr) {
				if (!byGanttDate.has(endDateStr)) byGanttDate.set(endDateStr, []);
				byGanttDate.get(endDateStr)!.push(s);
			}
		}
	}

	// Build continuous calendar date range for last N days, anchored to today
	const nowDate = tz
		? new Date().toLocaleDateString("en-CA", { timeZone: tz })
		: new Date().toISOString().slice(0, 10);
	const calendarDates: string[] = [];
	const end = new Date(nowDate + "T12:00:00");
	for (let i = days - 1; i >= 0; i--) {
		const d = new Date(end);
		d.setDate(d.getDate() - i);
		calendarDates.push(d.toISOString().slice(0, 10));
	}

	const rows: GanttRow[] = calendarDates.map((date, i) => {
		const y = GANTT.PAD_T + i * GANTT.ROW_H;
		const entries = byGanttDate.get(date) ?? [];
		const blocks: GanttBlock[] = [];

		for (const s of entries) {
			const startDate = new Date(s.start_time);
			const endDate = new Date(s.end_time!);
			const sleepDateStr = tz ? isoToDateInTz(s.start_time, tz) : s.start_time.slice(0, 10);

			let clipStartH: number;
			let clipEndH: number;

			if (sleepDateStr === date) {
				// This row owns the start of the sleep
				clipStartH = tz
					? getLocalHourFrac(startDate, tz)
					: startDate.getHours() + startDate.getMinutes() / 60;
				const endDateStr = tz ? isoToDateInTz(s.end_time!, tz) : s.end_time!.slice(0, 10);
				if (endDateStr !== date) {
					// Sleep extends past midnight — clip to end of day
					clipEndH = 24;
				} else {
					clipEndH = tz
						? getLocalHourFrac(endDate, tz)
						: endDate.getHours() + endDate.getMinutes() / 60;
				}
			} else {
				// This row shows the morning continuation of a cross-midnight sleep
				clipStartH = 0;
				clipEndH = tz
					? getLocalHourFrac(endDate, tz)
					: endDate.getHours() + endDate.getMinutes() / 60;
			}

			const durationH = clipEndH - clipStartH;
			if (durationH <= 0) continue;

			const x = hourToX(clipStartH);
			const w = (durationH / hoursSpan) * plotW;

			blocks.push({ x, w: Math.max(2, w), y: y + 2, type: s.type });
		}

		return {
			date,
			dateLabel: new Date(date + "T12:00:00").toLocaleDateString("nb-NO", { weekday: "short", day: "numeric" }),
			y,
			blocks,
		};
	});

	// Hour labels along top
	const hourLabels: { x: number; label: string }[] = [];
	for (let h = GANTT.HOUR_START; h < GANTT.HOUR_START + 24; h += 3) {
		const displayH = h % 24;
		hourLabels.push({ x: hourToX(displayH), label: `${String(displayH).padStart(2, "0")}` });
	}

	const height = GANTT.PAD_T + calendarDates.length * GANTT.ROW_H + 8;

	return { rows, hourLabels, height };
}

function getLocalHourFrac(date: Date, tz: string): number {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
	}).formatToParts(date);
	const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
	const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
	return (h % 24) + m / 60;
}

// ── Chart E: Heatmap geometry ─────────────────────────────────

export const HEATMAP = {
	W: 360,
	CELL_W: 13,
	CELL_H: 14,
	PAD_L: 56,
	PAD_T: 20,
	PAD_R: 8,
	GAP: 1,
} as const;

export interface HeatmapCellGeo {
	x: number;
	y: number;
	w: number;
	h: number;
	minutes: number;
	opacity: number;
}

export interface HeatmapChartData {
	cells: HeatmapCellGeo[];
	dateLabels: { x: number; y: number; label: string }[];
	hourLabels: { x: number; label: string }[];
	height: number;
	width: number;
}

export function buildHeatmapChart(heatmapRows: HeatmapRow[], days: number): HeatmapChartData {
	const rows = heatmapRows.slice(-days);
	if (rows.length === 0) return { cells: [], dateLabels: [], hourLabels: [], height: 0, width: 0 };

	const cellW = HEATMAP.CELL_W;
	const cellH = HEATMAP.CELL_H;
	const gap = HEATMAP.GAP;

	const cells: HeatmapCellGeo[] = [];
	const dateLabels: { x: number; y: number; label: string }[] = [];

	for (let r = 0; r < rows.length; r++) {
		const row = rows[r];
		const y = HEATMAP.PAD_T + r * (cellH + gap);

		dateLabels.push({
			x: HEATMAP.PAD_L - 4,
			y: y + cellH / 2 + 3,
			label: new Date(row.date + "T12:00:00").toLocaleDateString("nb-NO", { weekday: "short", day: "numeric" }),
		});

		for (let offset = 0; offset < 24; offset++) {
			const h = offset; // 00:00-start — night sleep in the middle
			const x = HEATMAP.PAD_L + offset * (cellW + gap);
			const minutes = row.hours[h];
			const opacity = Math.min(1, minutes / 60);
			cells.push({ x, y, w: cellW, h: cellH, minutes, opacity });
		}
	}

	const hourLabels: { x: number; label: string }[] = [];
	for (let offset = 0; offset < 24; offset += 3) {
		const displayH = offset;
		hourLabels.push({
			x: HEATMAP.PAD_L + offset * (cellW + gap) + cellW / 2,
			label: `${String(displayH).padStart(2, "0")}`,
		});
	}

	const width = HEATMAP.PAD_L + 24 * (cellW + gap) + HEATMAP.PAD_R;
	const height = HEATMAP.PAD_T + rows.length * (cellH + gap) + 8;

	return { cells, dateLabels, hourLabels, height, width };
}

// ── Chart F: Wake Window Scatter ──────────────────────────────

export interface WakeScatterData {
	dots: { x: number; y: number; minutes: number }[];
	bandY: { top: number; bottom: number } | null;
	yTicks: { y: number; label: string }[];
	gridLines: number[];
	maxMin: number;
}

export function buildWakeScatter(
	gaps: WakeWindowGap[],
	recommendedRange?: { min: number; max: number },
): WakeScatterData {
	if (gaps.length === 0) return { dots: [], bandY: null, yTicks: [], gridLines: [], maxMin: 0 };

	const n = gaps.length;
	const maxMin = Math.max(180, ...gaps.map((g) => g.minutes));
	const plotH = tsPlotH();
	const baseY = TS_CHART.PAD_T + plotH;

	const yMap = (min: number) => baseY - (min / maxMin) * plotH;

	const dots = gaps.map((g, i) => ({
		x: tsX(i, n),
		y: yMap(g.minutes),
		minutes: g.minutes,
	}));

	let bandY: { top: number; bottom: number } | null = null;
	if (recommendedRange) {
		bandY = {
			top: yMap(recommendedRange.max),
			bottom: yMap(recommendedRange.min),
		};
	}

	const yTicks: { y: number; label: string }[] = [];
	const gridLines: number[] = [];
	const stepMin = maxMin <= 180 ? 30 : 60;
	for (let m = stepMin; m <= maxMin; m += stepMin) {
		const y = yMap(m);
		yTicks.push({ y, label: m >= 60 ? `${Math.round(m / 60)}t` : `${m}m` });
		gridLines.push(y);
	}

	return { dots, bandY, yTicks, gridLines, maxMin };
}

// ── Sleep Pressure Chart ──────────────────────────────────────

export interface PressurePoint {
	x: number;
	y: number;
	hour: number;
	pressureMin: number;
}

export interface SleepPressureChartData {
	/** One curve per recent day */
	curves: Array<{
		date: string;
		linePath: string;
		areaPath: string;
		sleepBands: Array<{ x1: number; x2: number; type: 'nap' | 'night' }>;
	}>;
	/** Average curve (bold) */
	avgLinePath: string | null;
	xLabels: Array<{ x: number; label: string }>;
	yTicks: Array<{ y: number; label: string }>;
	gridLines: number[];
}

/**
 * Build a sleep pressure chart from recent sleep data.
 * Shows how awake-time accumulates (pressure rises) and resets during sleep.
 * X-axis = time of day (05:00–22:00), Y-axis = minutes awake since last sleep.
 */
export function buildSleepPressureChart(
	sleeps: SleepEntry[],
	tz?: string,
): SleepPressureChartData {
	const empty: SleepPressureChartData = { curves: [], avgLinePath: null, xLabels: [], yTicks: [], gridLines: [] };

	// Group sleeps by local date
	const timezone = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	const dayMap = new Map<string, SleepEntry[]>();
	for (const s of sleeps) {
		if (!s.end_time) continue;
		const d = isoToDateInTz(s.start_time, timezone);
		if (!dayMap.has(d)) dayMap.set(d, []);
		dayMap.get(d)!.push(s);
	}

	// Get last 7 complete days (not today)
	const today = new Date().toLocaleDateString("en-CA", { timeZone: timezone });
	const sortedDays = [...dayMap.keys()].filter(d => d !== today).toSorted().slice(-7);
	if (sortedDays.length === 0) return empty;

	// Chart config: 05:00–22:00 (17 hours)
	const startHour = 5;
	const endHour = 22;
	const totalHours = endHour - startHour;
	const plotW = tsPlotW();
	const plotH = tsPlotH();
	const maxPressure = 300; // 5 hours max on Y axis
	const baseY = TS_CHART.PAD_T + plotH;

	const xMap = (h: number) => TS_CHART.PAD_L + ((h - startHour) / totalHours) * plotW;
	const yMap = (min: number) => baseY - (Math.min(min, maxPressure) / maxPressure) * plotH;

	// For each day, compute the pressure curve at 5-min intervals
	const resolution = 5; // minutes
	const steps = totalHours * 60 / resolution;
	const allCurves: number[][] = [];

	const curves = sortedDays.map(dayStr => {
		const daySleeps = dayMap.get(dayStr)!
			.filter(s => s.end_time)
			.toSorted((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

		// Find the earliest wake time (end of first night or start of day)
		const firstNight = daySleeps.find(s => s.type === 'night');
		const wakeMs = firstNight?.end_time
			? new Date(firstNight.end_time).getTime()
			: new Date(`${dayStr}T06:00:00`).getTime();

		// Build minute-by-minute sleep state
		const dayStartMs = new Date(`${dayStr}T${String(startHour).padStart(2, '0')}:00:00`).getTime();

		const pressureValues: number[] = [];
		let pressure = 0;
		const points: string[] = [];

		for (let i = 0; i <= steps; i++) {
			const timeMs = dayStartMs + i * resolution * 60_000;
			const hour = startHour + (i * resolution) / 60;

			// Before wake: pressure is 0
			if (timeMs < wakeMs) {
				pressure = 0;
			} else {
				// Check if sleeping at this moment
				const sleeping = daySleeps.some(s => {
					const sStart = new Date(s.start_time).getTime();
					const sEnd = new Date(s.end_time!).getTime();
					return timeMs >= sStart && timeMs < sEnd && s.type === 'nap';
				});

				if (sleeping) {
					// During nap: pressure decreases rapidly
					pressure = Math.max(0, pressure - resolution * 0.8);
				} else {
					// Awake: pressure builds
					pressure += resolution;
				}
			}

			pressureValues.push(pressure);
			points.push(`${xMap(hour)},${yMap(pressure)}`);
		}

		allCurves.push(pressureValues);

		const linePath = `M${points.join(" L")}`;
		const areaPath = `${linePath} L${xMap(endHour)},${baseY} L${xMap(startHour)},${baseY} Z`;

		// Sleep bands (nap shaded regions)
		const sleepBands = daySleeps
			.filter(s => s.type === 'nap' && s.end_time)
			.map(s => {
				const sH = (new Date(s.start_time).getTime() - dayStartMs) / 3_600_000 + startHour;
				const eH = (new Date(s.end_time!).getTime() - dayStartMs) / 3_600_000 + startHour;
				return {
					x1: xMap(Math.max(startHour, sH)),
					x2: xMap(Math.min(endHour, eH)),
					type: 'nap' as const,
				};
			})
			.filter(b => b.x2 > b.x1);

		return { date: dayStr, linePath, areaPath, sleepBands };
	});

	// Average curve
	let avgLinePath: string | null = null;
	if (allCurves.length >= 2) {
		const avgPoints: string[] = [];
		for (let i = 0; i <= steps; i++) {
			const avg = allCurves.reduce((sum, c) => sum + c[i], 0) / allCurves.length;
			const hour = startHour + (i * resolution) / 60;
			avgPoints.push(`${xMap(hour)},${yMap(avg)}`);
		}
		avgLinePath = `M${avgPoints.join(" L")}`;
	}

	// X labels: every 2 hours
	const xLabels: Array<{ x: number; label: string }> = [];
	for (let h = 6; h <= 22; h += 2) {
		xLabels.push({ x: xMap(h), label: `${String(h).padStart(2, '0')}` });
	}

	// Y ticks: every 60 minutes
	const yTicks: Array<{ y: number; label: string }> = [];
	const gridLines: number[] = [];
	for (let m = 60; m <= maxPressure; m += 60) {
		const y = yMap(m);
		yTicks.push({ y, label: `${m / 60}t` });
		gridLines.push(y);
	}

	return { curves, avgLinePath, xLabels, yTicks, gridLines };
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

/** Fetch all sleep data (no time limit) for full-history views. */
export async function fetchFullHistory(): Promise<SleepEntry[]> {
	const res = await fetch("/api/sleeps?limit=10000");
	return res.json();
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

export function computeDiaperStats(diapers: DiaperLogRow[], tz?: string): DiaperStats {
	const total = diapers.length;
	const byDay = new Set(diapers.map((d) => tz ? isoToDateInTz(d.time, tz) : d.time.slice(0, 10)));
	const dayCount = byDay.size || 1;

	let wetCount = 0;
	let dirtyCount = 0;
	let bothCount = 0;
	let pottyTotal = 0;
	let pottySuccess = 0;

	for (const d of diapers) {
		if (d.type === "wet" || d.type === "potty_wet") wetCount++;
		else if (d.type === "dirty" || d.type === "potty_dirty") dirtyCount++;
		else if (d.type === "both" || d.type === "potty_both") {
			bothCount++;
			wetCount++;
			dirtyCount++;
		}

		if (d.type.startsWith("potty_")) {
			pottyTotal++;
			if (d.type === "potty_wet" || d.type === "potty_dirty" || d.type === "potty_both") pottySuccess++;
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

export function getBestWorst(weekStats: WeekStats, tz?: string): BestWorst | null {
	const today = tz
		? new Date().toLocaleDateString("en-CA", { timeZone: tz })
		: new Date().toISOString().slice(0, 10);
	const daysWithTotal = weekStats.days
		.filter((d) => d.date !== today) // exclude incomplete current day
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
	// Tier 1 charts
	stackedArea: StackedAreaData;
	sleepVsNorm: SleepVsNormData | null;
	nightStretchChart: NightStretchChartData;
	bedtimeChart: BedtimeChartData;
	napCountChart: NapCountChartData;
	pressureChart: SleepPressureChartData;
	// Tier 2 charts
	gantt: GanttChartData;
	heatmapChart: HeatmapChartData;
	wakeScatter: WakeScatterData;
	nightStretches: NightStretch[];
	wakeGaps: WakeWindowGap[];
	heatmap: HeatmapRow[];
}

export function computeAllStats(
	sleeps: SleepEntry[],
	diapers: DiaperLogRow[],
	tz?: string,
	birthdate?: string,
): ComputedStats {
	const mapped: SleepEntry[] = sleeps.map((s) => ({
		start_time: s.start_time,
		end_time: s.end_time,
		type: s.type,
		pauses: s.pauses,
	}));

	const sevenDaysAgo = new Date();
	sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
	sevenDaysAgo.setHours(0, 0, 0, 0);
	const week7 = mapped.filter(
		(s) => new Date(s.start_time).getTime() >= sevenDaysAgo.getTime(),
	);
	const weekStats = getWeekStats(week7, tz);
	const allStats = getWeekStats(mapped, tz);

	const bars = buildBars(weekStats);
	const maxMin = getMaxMin(bars);
	const barGeometries = bars.length > 0 ? buildBarGeometries(bars, maxMin) : [];
	const yTicks = buildYTicks(maxMin);
	const gridLines = buildGridLines(maxMin);

	const wakeAvg = getAverageWakeWindow(week7);
	const trendRows = buildTrendRows(weekStats, allStats);
	const bestWorst = getBestWorst(weekStats, tz);

	const week7Diapers = diapers.filter(
		(d) => new Date(d.time).getTime() > Date.now() - 7 * 86400000,
	);
	const diaperStats7 = diapers.length > 0 ? computeDiaperStats(week7Diapers, tz) : null;
	const diaperStats30 = diapers.length > 0 ? computeDiaperStats(diapers, tz) : null;

	// Exclude today's incomplete data from charts
	const today = tz
		? new Date().toLocaleDateString("en-CA", { timeZone: tz })
		: new Date().toISOString().slice(0, 10);
	const completeDays = allStats.days.filter((d) => d.date !== today);

	// New charts: stacked area from completed days
	const stackedAreaDays = completeDays.map((d) => ({
		date: d.date,
		napMin: d.stats.totalNapMinutes,
		nightMin: d.stats.totalNightMinutes,
	}));
	const stackedArea = buildStackedArea(stackedAreaDays);

	// Sleep vs age norms (requires birthdate)
	let sleepVsNorm: SleepVsNormData | null = null;
	if (birthdate) {
		const normDays = completeDays.map((d) => ({
			date: d.date,
			totalHours: (d.stats.totalNapMinutes + d.stats.totalNightMinutes) / 60,
		}));
		sleepVsNorm = buildSleepVsNorm(normDays, birthdate);
	}

	// Night stretch growth
	const nightStretches = getLongestNightStretches(mapped, tz);
	const nightStretchChart = buildNightStretchChart(nightStretches);

	// Bedtime consistency
	const bedtimes = getBedtimes(mapped, tz);
	const bedtimeChart = buildBedtimeChart(bedtimes);

	// Nap count trend
	const napCountDays = completeDays.map((d) => ({ date: d.date, napCount: d.stats.napCount }));
	const napCountChart = buildNapCountChart(napCountDays);

	// Sleep pressure chart
	const pressureChart = buildSleepPressureChart(mapped, tz);

	// Tier 2: advanced charts
	const wakeGaps = getWakeWindowGaps(week7);
	const heatmap = buildSleepHeatmap(mapped, tz);
	const gantt = buildGanttChart(mapped, 30, tz);
	const heatmapChart = buildHeatmapChart(heatmap, heatmap.length);
	const wakeScatter = buildWakeScatter(wakeGaps);

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
		stackedArea,
		sleepVsNorm,
		nightStretchChart,
		bedtimeChart,
		napCountChart,
		pressureChart,
		gantt,
		heatmapChart,
		wakeScatter,
		nightStretches,
		wakeGaps,
		heatmap,
	};
}
