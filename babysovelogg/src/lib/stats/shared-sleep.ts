import { isoToDateInTz, getMinuteOfDayInTz } from "$lib/tz.js";
import { TS_CHART, tsX, tsPlotH } from "$lib/charts/scales.js";
import { areaUnder } from "$lib/charts/paths.js";
import type { SleepEntry } from "$lib/types.js";

// "Felles søvn" / parent downtime: the minutes both children are asleep at the
// same time, per local day. Pure — interval intersection of the two children's
// completed sleeps, bucketed by tz day (split at local midnight).

interface Interval {
  start: number;
  end: number;
}

function toIntervals(sleeps: SleepEntry[]): Interval[] {
  return sleeps
    .filter((s) => s.end_time)
    .map((s) => ({ start: new Date(s.start_time).getTime(), end: new Date(s.end_time as string).getTime() }))
    .filter((iv) => iv.end > iv.start)
    .toSorted((a, b) => a.start - b.start);
}

function merge(intervals: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const iv of intervals) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ ...iv });
  }
  return out;
}

/** Intersection of two sorted, merged (non-overlapping) interval lists. */
function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].start, b[j].start);
    const end = Math.min(a[i].end, b[j].end);
    if (end > start) out.push({ start, end });
    if (a[i].end < b[j].end) i++;
    else j++;
  }
  return out;
}

export interface SharedSleepDay {
  date: string;
  minutes: number;
}

/**
 * Both-asleep minutes per local day across two children's sleeps. Overlap
 * windows that cross local midnight are split between days. Today (incomplete)
 * is excluded; only days with shared sleep appear (matching the other charts'
 * zero-day filtering).
 */
export function computeSharedSleepByDay(
  sleepsA: SleepEntry[],
  sleepsB: SleepEntry[],
  tz: string,
  now: number = Date.now(),
): SharedSleepDay[] {
  const overlap = intersect(merge(toIntervals(sleepsA)), merge(toIntervals(sleepsB)));
  const byDay = new Map<string, number>();
  for (const iv of overlap) {
    let s = iv.start;
    while (s < iv.end) {
      const date = isoToDateInTz(new Date(s).toISOString(), tz);
      const msToMidnight = (1440 - getMinuteOfDayInTz(new Date(s), tz)) * 60_000;
      const chunkEnd = Math.min(iv.end, s + msToMidnight);
      byDay.set(date, (byDay.get(date) ?? 0) + (chunkEnd - s) / 60_000);
      s = chunkEnd;
    }
  }
  const today = isoToDateInTz(new Date(now).toISOString(), tz);
  return [...byDay.entries()]
    .filter(([date]) => date !== today)
    .map(([date, minutes]) => ({ date, minutes: Math.round(minutes) }))
    .toSorted((a, b) => a.date.localeCompare(b.date));
}

export function avgSharedSleepPerDay(days: SharedSleepDay[]): number {
  if (days.length === 0) return 0;
  return Math.round(days.reduce((sum, d) => sum + d.minutes, 0) / days.length);
}

export interface SharedSleepChart {
  areaPath: string;
  yTicks: { y: number; label: string }[];
  xLabels: { x: number; label: string }[];
  gridLines: number[];
  avgMinutes: number;
}

/** Chart geometry for the per-day shared-sleep area (reuses the time-series frame). */
export function buildSharedSleepChart(days: SharedSleepDay[]): SharedSleepChart | null {
  if (days.length === 0) return null;
  const n = days.length;
  const maxMin = Math.max(60, ...days.map((d) => d.minutes));
  const maxHours = Math.ceil(maxMin / 60);
  const plotH = tsPlotH();
  const baseY = TS_CHART.PAD_T + plotH;
  const yMap = (min: number) => baseY - (min / maxMin) * plotH;

  const points = days.map((d, i) => `${tsX(i, n)},${yMap(d.minutes)}`);
  const areaPath = areaUnder(points, tsX(0, n), tsX(n - 1, n), baseY);

  const yTicks: { y: number; label: string }[] = [];
  const gridLines: number[] = [];
  const step = maxHours <= 6 ? 1 : 2;
  for (let h = step; h <= maxHours; h += step) {
    const y = yMap(h * 60);
    yTicks.push({ y, label: `${h}t` });
    gridLines.push(y);
  }

  const xLabels: { x: number; label: string }[] = [];
  const labelIndices = n <= 7 ? days.map((_, i) => i) : [0, Math.floor(n / 2), n - 1];
  for (const i of labelIndices) {
    xLabels.push({
      x: tsX(i, n),
      label: new Date(days[i].date + "T12:00:00").toLocaleDateString("nb-NO", { day: "numeric", month: "short" }),
    });
  }

  return { areaPath, yTicks, xLabels, gridLines, avgMinutes: avgSharedSleepPerDay(days) };
}
