export type { SleepEntry, SleepPause } from "$lib/types.js";
import type { SleepEntry, SleepPause } from "$lib/types.js";
import { isoToDateInTz, getHourInTz } from "$lib/tz.js";

export interface DayStats {
  totalNapMinutes: number;
  totalNightMinutes: number;
  napCount: number;
  sleeps: SleepEntry[];
}

export interface WeekStats {
  days: { date: string; stats: DayStats }[];
  avgNapMinutesPerDay: number;
  avgNightMinutesPerDay: number;
  avgNapsPerDay: number;
}

function pauseMinutes(pauses: SleepPause[] | undefined, endTime: string): number {
  if (!pauses || pauses.length === 0) return 0;
  let total = 0;
  for (const p of pauses) {
    const ps = new Date(p.pause_time).getTime();
    const pe = p.resume_time ? new Date(p.resume_time).getTime() : new Date(endTime).getTime();
    total += pe - ps;
  }
  return total / 60000;
}

function durationMinutes(s: SleepEntry): number {
  if (!s.end_time) return 0;
  const raw = (new Date(s.end_time).getTime() - new Date(s.start_time).getTime()) / 60000;
  return raw - pauseMinutes(s.pauses, s.end_time);
}

/** Get stats for today's sleeps. */
export function getTodayStats(sleeps: SleepEntry[]): DayStats {
  let totalNapMinutes = 0;
  let totalNightMinutes = 0;
  let napCount = 0;

  for (const s of sleeps) {
    if (!s.end_time) continue;
    const dur = durationMinutes(s);
    if (dur <= 0) continue;

    if (s.type === "nap") {
      totalNapMinutes += dur;
      napCount++;
    } else {
      totalNightMinutes += dur;
    }
  }

  return {
    totalNapMinutes: Math.round(totalNapMinutes),
    totalNightMinutes: Math.round(totalNightMinutes),
    napCount,
    sleeps,
  };
}

/** Get aggregated stats for a week of sleeps, grouped by day.
 *  When tz is provided, groups by local date in the baby's timezone. */
export function getWeekStats(sleeps: SleepEntry[], tz?: string): WeekStats {
  // Group by date (based on start_time, in baby's local timezone)
  const byDate = new Map<string, SleepEntry[]>();

  for (const s of sleeps) {
    const date = tz ? isoToDateInTz(s.start_time, tz) : s.start_time.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push(s);
  }

  const days = [...byDate.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([date, daySleeps]) => ({ date, stats: getTodayStats(daySleeps) }));

  const count = days.length || 1;
  const avgNapMinutesPerDay = Math.round(
    days.reduce((sum, d) => sum + d.stats.totalNapMinutes, 0) / count,
  );
  const avgNightMinutesPerDay = Math.round(
    days.reduce((sum, d) => sum + d.stats.totalNightMinutes, 0) / count,
  );
  const avgNapsPerDay =
    Math.round((days.reduce((sum, d) => sum + d.stats.napCount, 0) / count) * 10) / 10;

  return { days, avgNapMinutesPerDay, avgNightMinutesPerDay, avgNapsPerDay };
}

/** Average wake window in minutes from a list of completed sleeps. */
export function getAverageWakeWindow(sleeps: SleepEntry[]): number | null {
  const gaps = getWakeWindowGaps(sleeps);
  if (gaps.length === 0) return null;
  return Math.round(gaps.reduce((a, b) => a + b.minutes, 0) / gaps.length);
}

/** Individual wake window gaps with timestamps. */
export interface WakeWindowGap {
  /** ISO timestamp of the gap start (previous sleep end) */
  time: string;
  /** Gap duration in minutes */
  minutes: number;
}

/** Return all valid wake window gaps (10–480 min) between consecutive completed sleeps. */
export function getWakeWindowGaps(sleeps: SleepEntry[]): WakeWindowGap[] {
  const sorted = [...sleeps]
    .filter((s) => s.end_time)
    .toSorted((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  if (sorted.length < 2) return [];

  const gaps: WakeWindowGap[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1].end_time!;
    const prevEndMs = new Date(prevEnd).getTime();
    const nextStart = new Date(sorted[i].start_time).getTime();
    const gapMin = (nextStart - prevEndMs) / 60000;
    if (gapMin >= 10 && gapMin <= 480) {
      gaps.push({ time: prevEnd, minutes: Math.round(gapMin) });
    }
  }
  return gaps;
}

/** Per-night longest unbroken sleep stretch. */
export interface NightStretch {
  date: string;
  minutes: number;
}

/** Get the longest continuous sleep stretch per night.
 *  If a night entry has pauses, we find the longest segment between them. */
export function getLongestNightStretches(sleeps: SleepEntry[], tz?: string): NightStretch[] {
  const nights = sleeps.filter((s) => s.type === "night" && s.end_time);
  const byDate = new Map<string, number>();

  for (const s of nights) {
    const startMs = new Date(s.start_time).getTime();
    const endMs = new Date(s.end_time!).getTime();
    const date = tz ? isoToDateInTz(s.start_time, tz) : s.start_time.slice(0, 10);

    let longest: number;
    if (!s.pauses || s.pauses.length === 0) {
      longest = (endMs - startMs) / 60000;
    } else {
      // Split into segments between pauses
      const breaks = s.pauses
        .filter((p) => p.resume_time)
        .map((p) => ({ pause: new Date(p.pause_time).getTime(), resume: new Date(p.resume_time!).getTime() }))
        .toSorted((a, b) => a.pause - b.pause);

      longest = 0;
      let segStart = startMs;
      for (const b of breaks) {
        const seg = (b.pause - segStart) / 60000;
        if (seg > longest) longest = seg;
        segStart = b.resume;
      }
      // Final segment after last resume
      const lastSeg = (endMs - segStart) / 60000;
      if (lastSeg > longest) longest = lastSeg;
    }

    if (longest <= 0) continue;
    const existing = byDate.get(date) ?? 0;
    if (longest > existing) byDate.set(date, longest);
  }

  return [...byDate.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([date, minutes]) => ({ date, minutes: Math.round(minutes) }));
}

/** Per-night bedtime (start of night sleep) as fractional hour. */
export interface BedtimePoint {
  date: string;
  /** Bedtime as fractional hour (e.g. 19.5 = 19:30) */
  hour: number;
}

/** Extract bedtime per night — the start time of the earliest night sleep entry per date. */
export function getBedtimes(sleeps: SleepEntry[], tz?: string): BedtimePoint[] {
  const nights = sleeps.filter((s) => s.type === "night" && s.end_time);
  const byDate = new Map<string, number>();

  for (const s of nights) {
    const date = tz ? isoToDateInTz(s.start_time, tz) : s.start_time.slice(0, 10);
    const startDate = new Date(s.start_time);
    const hour = tz
      ? getHourInTz(startDate, tz)
      : startDate.getHours() + startDate.getMinutes() / 60;

    const existing = byDate.get(date);
    // Keep the earliest night sleep start as "bedtime"
    // But for bedtimes, earlier in the evening means a higher hour (e.g. 19:00 > 18:00)
    // We want the first night sleep of the evening, which is the one with the earliest start
    if (existing === undefined || hour < existing) {
      byDate.set(date, hour);
    }
  }

  return [...byDate.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([date, hour]) => ({ date, hour: Math.round(hour * 100) / 100 }));
}

/** Heatmap row: sleep minutes per hour-of-day for a single date. */
export interface HeatmapRow {
  date: string;
  /** 24 values, index 0 = 00:00–01:00, index 23 = 23:00–00:00 */
  hours: number[];
}

/** Build a sleep heatmap: minutes of sleep per hour-of-day, grouped by date. */
export function buildSleepHeatmap(sleeps: SleepEntry[], tz?: string): HeatmapRow[] {
  const rows = new Map<string, number[]>();

  for (const s of sleeps) {
    if (!s.end_time) continue;
    const startMs = new Date(s.start_time).getTime();
    const endMs = new Date(s.end_time).getTime();
    if (endMs <= startMs) continue;

    // Walk through each hour slot the sleep overlaps
    // Anchor to the start date; a sleep crossing midnight contributes to the start date's row
    const date = tz ? isoToDateInTz(s.start_time, tz) : s.start_time.slice(0, 10);
    if (!rows.has(date)) rows.set(date, Array.from({ length: 24 }, () => 0));
    const row = rows.get(date)!;

    // Get start hour in local time
    const startDate = new Date(startMs);
    const startHourFrac = tz ? getHourInTz(startDate, tz) : startDate.getHours() + startDate.getMinutes() / 60;
    const totalMinutes = (endMs - startMs) / 60000;

    // Distribute minutes across hour slots
    let remaining = totalMinutes;
    let currentHourFrac = startHourFrac;

    while (remaining > 0) {
      const hourIdx = Math.floor(currentHourFrac) % 24;
      const minutesIntoHour = (currentHourFrac - Math.floor(currentHourFrac)) * 60;
      const minutesLeftInSlot = 60 - minutesIntoHour;
      const chunk = Math.min(remaining, minutesLeftInSlot);
      row[hourIdx] += chunk;
      remaining -= chunk;
      currentHourFrac = (hourIdx + 1) % 24;
    }

    // Cap each slot at 60 min
    for (let i = 0; i < 24; i++) {
      if (row[i] > 60) row[i] = 60;
    }
  }

  return [...rows.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([date, hours]) => ({ date, hours: hours.map((m) => Math.round(m)) }));
}
