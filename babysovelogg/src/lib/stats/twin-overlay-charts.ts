import { TS_CHART, tsPlotH, tsXByDate } from "$lib/charts/scales.js";
import { band, nullablePolyline } from "$lib/charts/paths.js";
import { regressionEquations, sleepDuration } from "$lib/data/galland2012.js";
import type { ChildStats } from "$lib/stats/multi-child-stats.js";
import type { TimelineRowRender, TimelineBlockRender } from "$lib/components/charts/SleepTimelineChart.svelte";

const CHILD_COLOR_VARS = ["--moon", "--peach-dark"] as const;

/** Per-child lane geometry inside a gantt date row (ROW_H=20). Two lanes of
 *  LANE_H stacked with a 1px gap, starting 2px below the row top. */
const LANE_H = 6;
const LANE_GAP = 1;

export interface TwinTimeline {
  rows: TimelineRowRender[];
  hourLabels: { x: number; label: string }[];
  height: number;
}

/**
 * Merge each twin's gantt into ONE timeline where every date row carries both
 * children's blocks in stacked per-child lanes (top = child 0, below = child 1),
 * coloured per child. Block x/w are already in the shared fixed gantt scale and
 * all children share the same 30-day calendar rows, so only y + colour differ.
 * Returns null when no child has timeline data.
 */
export function buildTwinTimeline(children: ChildStats[]): TwinTimeline | null {
  const withData = children.filter((c) => c.stats.gantt.rows.length > 0);
  if (withData.length === 0) return null;
  const base = withData[0].stats.gantt;
  const byDate = children.map((c) => {
    const m = new Map<string, ChildStats["stats"]["gantt"]["rows"][number]["blocks"]>();
    for (const row of c.stats.gantt.rows) m.set(row.date, row.blocks);
    return m;
  });
  const rows: TimelineRowRender[] = base.rows.map((row) => {
    const blocks: TimelineBlockRender[] = [];
    children.forEach((_child, ci) => {
      const laneY = row.y + 2 + ci * (LANE_H + LANE_GAP);
      const colorVar = CHILD_COLOR_VARS[ci] ?? "--text-light";
      for (const b of byDate[ci].get(row.date) ?? []) {
        blocks.push({ x: b.x, w: b.w, y: laneY, h: LANE_H, type: b.type, colorVar });
      }
    });
    return { date: row.date, dateLabel: row.dateLabel, y: row.y, blocks };
  });
  return { rows, hourLabels: base.hourLabels, height: base.height };
}

export interface TwinOverlayPoint {
  date: string;
  x: number;
  y: number | null;
  value: number | null;
}

export interface TwinOverlaySeries {
  id: string;
  label: string;
  colorVar: string;
  path: string;
  points: TwinOverlayPoint[];
}

export interface TwinOverlayBand {
  path: string;
  colorVar: string;
  opacity?: number;
}

export interface TwinOverlayChart {
  dates: string[];
  xByDate: Record<string, number>;
  xLabels: { x: number; label: string }[];
  yTicks: { y: number; label: string }[];
  gridLines: number[];
  series: TwinOverlaySeries[];
}

export interface TwinSleepVsNormChart extends TwinOverlayChart {
  bands: TwinOverlayBand[];
}

export interface TwinOverlayCharts {
  sleepTrend: TwinOverlayChart | null;
  sleepVsNorm: TwinSleepVsNormChart | null;
  nightStretch: TwinOverlayChart | null;
  bedtime: TwinOverlayChart | null;
  napCount: TwinOverlayChart | null;
}

export interface TwinOverlayOptions {
  now?: number;
}

interface ChildValueMap {
  child: ChildStats;
  colorVar: string;
  values: Map<string, number>;
}

type YMap = (value: number) => number;

export function buildTwinOverlayCharts(
  children: ChildStats[],
  opts: TwinOverlayOptions = {},
): TwinOverlayCharts {
  return {
    sleepTrend: buildSleepTrend(children, opts),
    sleepVsNorm: buildSleepVsNorm(children, opts),
    nightStretch: buildNightStretch(children),
    bedtime: buildBedtime(children),
    napCount: buildNapCount(children, opts),
  };
}

function buildSleepTrend(children: ChildStats[], opts: TwinOverlayOptions): TwinOverlayChart | null {
  const maps = childMaps(children, (child) => {
    const values = new Map<string, number>();
    for (const day of completeDays(child, opts.now)) {
      const total = day.stats.totalNapMinutes + day.stats.totalNightMinutes;
      if (total > 0) values.set(day.date, total);
    }
    return values;
  });
  const maxMin = Math.max(60, ...allValues(maps));
  const maxHours = Math.ceil(maxMin / 60);
  const yMap = linearY(0, maxMin);
  const step = maxHours <= 6 ? 1 : 2;
  const yTicks = hourTicks(step, maxHours, (h) => yMap(h * 60));
  return buildChart(maps, yMap, yTicks);
}

function buildSleepVsNorm(children: ChildStats[], opts: TwinOverlayOptions): TwinSleepVsNormChart | null {
  const birthdate = children[0]?.birthdate;
  if (!birthdate || children.some((child) => child.birthdate !== birthdate)) return null;

  const maps = childMaps(children, (child) => {
    const values = new Map<string, number>();
    for (const day of completeDays(child, opts.now)) {
      const total = day.stats.totalNapMinutes + day.stats.totalNightMinutes;
      if (total > 0) values.set(day.date, total / 60);
    }
    return values;
  });
  const dates = unionDates(maps);
  if (dates.length === 0) return null;

  const birthMs = new Date(birthdate).getTime();
  const norms = dates.map((date) => gallandRange(ageMonthsAt(date, birthMs)));
  const values = [...allValues(maps), ...norms.flatMap((norm) => [norm.min, norm.max])];
  const maxHours = Math.ceil(Math.max(...values) + 0.5);
  const minHours = Math.max(0, Math.floor(Math.min(...values) - 0.5));
  const yMap = linearY(minHours, maxHours);
  const yTicks: { y: number; label: string }[] = [];
  const gridLines: number[] = [];
  for (let h = Math.ceil(minHours); h <= maxHours; h += 2) {
    const y = yMap(h);
    yTicks.push({ y, label: `${h}t` });
    gridLines.push(y);
  }

  const chart = buildChart(maps, yMap, yTicks, dates);
  if (!chart) return null;
  const xByDate = tsXByDate(dates);
  const upperPoints = dates.map((date, i) => `${xByDate.get(date)!},${yMap(norms[i].max)}`);
  const lowerPoints = dates.map((date, i) => `${xByDate.get(date)!},${yMap(norms[i].min)}`).toReversed();
  return {
    ...chart,
    bands: [{ path: band(upperPoints, lowerPoints), colorVar: "--moon-glow", opacity: 0.5 }],
  };
}

function buildNightStretch(children: ChildStats[]): TwinOverlayChart | null {
  const maps = childMaps(children, (child) => {
    const values = new Map<string, number>();
    for (const stretch of child.stats.nightStretches) {
      if (stretch.minutes > 0) values.set(stretch.date, stretch.minutes);
    }
    return values;
  });
  const maxMin = Math.max(60, ...allValues(maps));
  const maxHours = Math.ceil(maxMin / 60);
  const yMap = linearY(0, maxMin);
  const step = maxHours <= 4 ? 1 : 2;
  const yTicks = hourTicks(step, maxHours, (h) => yMap(h * 60));
  return buildChart(maps, yMap, yTicks);
}

function buildBedtime(children: ChildStats[]): TwinOverlayChart | null {
  const maps = childMaps(children, (child) => {
    const values = new Map<string, number>();
    for (const bedtime of child.stats.bedtimes) values.set(bedtime.date, bedtime.hour);
    return values;
  });
  const values = allValues(maps);
  if (values.length === 0) return null;
  const rawMin = Math.floor(Math.min(...values));
  const rawMax = Math.ceil(Math.max(...values));
  const minH = rawMax - rawMin < 1 ? rawMin - 1 : rawMin;
  const maxH = rawMax - rawMin < 1 ? rawMax + 1 : rawMax;
  const range = maxH - minH || 1;
  const yMap = (hour: number) => TS_CHART.PAD_T + ((hour - minH) / range) * tsPlotH();
  const yTicks: { y: number; label: string }[] = [];
  const gridLines: number[] = [];
  for (let h = minH; h <= maxH; h++) {
    const y = yMap(h);
    yTicks.push({ y, label: fmtHour(h) });
    gridLines.push(y);
  }
  return buildChart(maps, yMap, yTicks);
}

function buildNapCount(children: ChildStats[], opts: TwinOverlayOptions): TwinOverlayChart | null {
  const maps = childMaps(children, (child) => {
    const values = new Map<string, number>();
    for (const day of completeDays(child, opts.now)) {
      if (day.stats.napCount > 0) values.set(day.date, day.stats.napCount);
    }
    return values;
  });
  const maxCount = Math.max(1, ...allValues(maps));
  const yMap = linearY(0, maxCount);
  const yTicks: { y: number; label: string }[] = [];
  for (let c = 1; c <= maxCount; c++) yTicks.push({ y: yMap(c), label: `${c}` });
  return buildChart(maps, yMap, yTicks);
}

function buildChart(
  maps: ChildValueMap[],
  yMap: YMap,
  yTicks: { y: number; label: string }[],
  forcedDates?: string[],
): TwinOverlayChart | null {
  const dates = forcedDates ?? unionDates(maps);
  if (dates.length === 0) return null;
  const xByDateMap = tsXByDate(dates);
  const xs = dates.map((date) => xByDateMap.get(date)!);
  const series = maps.map(({ child, colorVar, values }) => {
    const points = dates.map((date) => {
      const value = values.get(date) ?? null;
      return {
        date,
        x: xByDateMap.get(date)!,
        y: value == null ? null : yMap(value),
        value,
      };
    });
    return {
      id: String(child.babyId),
      label: child.name,
      colorVar,
      path: nullablePolyline(xs, points.map((point) => point.y)),
      points,
    };
  });
  return {
    dates,
    xByDate: Object.fromEntries(xByDateMap),
    xLabels: xLabels(dates, xByDateMap),
    yTicks,
    gridLines: yTicks.map((tick) => tick.y),
    series,
  };
}

function childMaps(children: ChildStats[], valuesFor: (child: ChildStats) => Map<string, number>): ChildValueMap[] {
  return children.map((child, i) => ({
    child,
    colorVar: CHILD_COLOR_VARS[i] ?? "--text-light",
    values: valuesFor(child),
  }));
}

function completeDays(child: ChildStats, now: number = Date.now()) {
  const today = child.timezone
    ? new Date(now).toLocaleDateString("en-CA", { timeZone: child.timezone })
    : new Date(now).toISOString().slice(0, 10);
  return child.stats.allStats.days.filter((day) => day.date !== today);
}

function unionDates(maps: ChildValueMap[]): string[] {
  return [...new Set(maps.flatMap((map) => [...map.values.keys()]))].toSorted();
}

function allValues(maps: ChildValueMap[]): number[] {
  return maps.flatMap((map) => [...map.values.values()]);
}

function linearY(min: number, max: number): YMap {
  const range = max - min || 1;
  const baseY = TS_CHART.PAD_T + tsPlotH();
  return (value: number) => baseY - ((value - min) / range) * tsPlotH();
}

function hourTicks(step: number, maxHours: number, yForHour: (hour: number) => number): { y: number; label: string }[] {
  const ticks: { y: number; label: string }[] = [];
  for (let h = step; h <= maxHours; h += step) ticks.push({ y: yForHour(h), label: `${h}t` });
  return ticks;
}

function xLabels(dates: string[], xByDate: Map<string, number>): { x: number; label: string }[] {
  const labelIndices = dates.length <= 7 ? dates.map((_, i) => i) : [0, Math.floor(dates.length / 2), dates.length - 1];
  return labelIndices.map((i) => ({
    x: xByDate.get(dates[i])!,
    label: new Date(dates[i] + "T12:00:00").toLocaleDateString("nb-NO", { day: "numeric", month: "short" }),
  }));
}

function fmtHour(hour: number): string {
  const hh = Math.floor(hour);
  const mm = Math.round((hour - hh) * 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function ageMonthsAt(date: string, birthMs: number): number {
  const dayMs = new Date(date + "T12:00:00").getTime();
  return Math.max(0, (dayMs - birthMs) / (30.44 * 24 * 60 * 60 * 1000));
}

function gallandRange(ageMonths: number): { min: number; max: number; typical: number } {
  const typical = regressionEquations.sleepDurationHours(Math.max(0.01, ageMonths / 12));
  const bands = sleepDuration.ageBands.filter((b) => !("note" in b));
  for (const b of bands) {
    if (ageMonths >= b.ageMonths[0] && ageMonths <= b.ageMonths[1]) {
      return { min: b.lower, max: b.upper, typical };
    }
  }
  return { min: typical - 3, max: typical + 3, typical };
}
