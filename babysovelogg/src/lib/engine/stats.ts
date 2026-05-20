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

/** Wake-to-wake "sleep day" totals — the parent's natural way to count.
 *
 * `todaySleeps` is filtered server-side to `start_time >= midnight`, so the
 * overnight that ended *this* morning (started yesterday evening) is not in
 * that list. For "Søvn i dag" the parent expects that morning night to
 * belong to today — passing it as `priorOvernight` adds its pause-adjusted
 * duration to the night minutes.
 */
export interface SleepDayTotals {
  napMinutes: number;
  /** Night sleep that *started* today (rare — only an unusual deep-night log). */
  todayNightMinutes: number;
  /** The overnight that ended this morning. 0 when none provided. */
  priorNightMinutes: number;
  /** napMinutes + todayNightMinutes + priorNightMinutes. */
  totalMinutes: number;
  /** True iff the prior overnight contributed a non-zero duration. */
  includesPriorNight: boolean;
}

export function getSleepDayTotals(
  todaySleeps: SleepEntry[],
  priorOvernight: SleepEntry | null,
): SleepDayTotals {
  const today = getTodayStats(todaySleeps);
  let priorNightMinutes = 0;
  if (priorOvernight?.end_time) {
    const raw = durationMinutes(priorOvernight);
    if (raw > 0) priorNightMinutes = Math.round(raw);
  }
  return {
    napMinutes: today.totalNapMinutes,
    todayNightMinutes: today.totalNightMinutes,
    priorNightMinutes,
    totalMinutes: today.totalNapMinutes + today.totalNightMinutes + priorNightMinutes,
    includesPriorNight: priorNightMinutes > 0,
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
  const getOrInit = (date: string): number[] => {
    let r = rows.get(date);
    if (!r) {
      r = Array.from({ length: 24 }, () => 0);
      rows.set(date, r);
    }
    return r;
  };

  for (const s of sleeps) {
    if (!s.end_time) continue;
    const startMs = new Date(s.start_time).getTime();
    const endMs = new Date(s.end_time).getTime();
    if (endMs <= startMs) continue;

    // Distribute the sleep's minutes per (date, hour) slot. A sleep that
    // crosses midnight contributes its pre-midnight minutes to the start
    // date's row and its post-midnight minutes to the *next* date's row —
    // the previous implementation lumped everything on the start date,
    // which left every morning's overnight portion missing from the day
    // a parent would naturally look at it under (e.g. last night's 00-06
    // showing on Thursday's row instead of Friday's).
    const startDate = new Date(startMs);
    const startHourFrac = tz ? getHourInTz(startDate, tz) : startDate.getHours() + startDate.getMinutes() / 60;
    const totalMinutes = (endMs - startMs) / 60000;

    let remaining = totalMinutes;
    let currentHourFrac = startHourFrac;
    let currentDate = tz ? isoToDateInTz(s.start_time, tz) : s.start_time.slice(0, 10);
    let row = getOrInit(currentDate);

    while (remaining > 0) {
      const hourIdx = Math.floor(currentHourFrac) % 24;
      const minutesIntoHour = (currentHourFrac - Math.floor(currentHourFrac)) * 60;
      const minutesLeftInSlot = 60 - minutesIntoHour;
      const chunk = Math.min(remaining, minutesLeftInSlot);
      row[hourIdx] += chunk;
      remaining -= chunk;
      const nextHour = hourIdx + 1;
      if (nextHour >= 24) {
        // Wrapped past midnight — advance to the next calendar date so
        // post-midnight minutes land on the morning the parent slept into.
        currentDate = nextLocalDate(currentDate);
        row = getOrInit(currentDate);
      }
      currentHourFrac = nextHour % 24;
    }
  }

  // Cap each slot at 60 min after aggregation (multiple sleeps could
  // overlap an hour due to logging quirks or data import).
  for (const row of rows.values()) {
    for (let i = 0; i < 24; i++) {
      if (row[i] > 60) row[i] = 60;
    }
  }

  return [...rows.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([date, hours]) => ({ date, hours: hours.map((m) => Math.round(m)) }));
}

/** Calendar next YYYY-MM-DD for a YYYY-MM-DD key. UTC math is safe — we're
 * shifting a date *key*, not an instant, so DST doesn't bite. */
function nextLocalDate(key: string): string {
  const ms = new Date(`${key}T00:00:00Z`).getTime() + 86400_000;
  return new Date(ms).toISOString().slice(0, 10);
}
