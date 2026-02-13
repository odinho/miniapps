export interface SleepEntry {
  start_time: string;
  end_time: string | null;
  type: "nap" | "night";
}

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

function durationMinutes(start: string, end: string): number {
  return (new Date(end).getTime() - new Date(start).getTime()) / 60000;
}

/** Get stats for today's sleeps. */
export function getTodayStats(sleeps: SleepEntry[]): DayStats {
  let totalNapMinutes = 0;
  let totalNightMinutes = 0;
  let napCount = 0;

  for (const s of sleeps) {
    if (!s.end_time) continue;
    const dur = durationMinutes(s.start_time, s.end_time);
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

/** Get aggregated stats for a week of sleeps, grouped by day. */
export function getWeekStats(sleeps: SleepEntry[]): WeekStats {
  // Group by date (based on start_time)
  const byDate = new Map<string, SleepEntry[]>();

  for (const s of sleeps) {
    const date = s.start_time.slice(0, 10); // YYYY-MM-DD
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push(s);
  }

  const days = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, daySleeps]) => ({ date, stats: getTodayStats(daySleeps) }));

  const count = days.length || 1;
  const avgNapMinutesPerDay =
    Math.round(days.reduce((sum, d) => sum + d.stats.totalNapMinutes, 0) / count);
  const avgNightMinutesPerDay =
    Math.round(days.reduce((sum, d) => sum + d.stats.totalNightMinutes, 0) / count);
  const avgNapsPerDay =
    Math.round((days.reduce((sum, d) => sum + d.stats.napCount, 0) / count) * 10) / 10;

  return { days, avgNapMinutesPerDay, avgNightMinutesPerDay, avgNapsPerDay };
}

/** Average wake window in minutes from a list of completed sleeps. */
export function getAverageWakeWindow(sleeps: SleepEntry[]): number | null {
  const sorted = [...sleeps]
    .filter((s) => s.end_time)
    .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  if (sorted.length < 2) return null;

  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = new Date(sorted[i - 1].end_time!).getTime();
    const nextStart = new Date(sorted[i].start_time).getTime();
    const gapMin = (nextStart - prevEnd) / 60000;
    if (gapMin >= 10 && gapMin <= 480) {
      gaps.push(gapMin);
    }
  }

  if (gaps.length === 0) return null;
  return Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
}
