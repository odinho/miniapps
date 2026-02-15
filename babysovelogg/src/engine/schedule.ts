import { WAKE_WINDOWS, NAP_COUNTS, findByAge } from "./constants.js";

export interface SleepEntry {
  start_time: string;
  end_time: string | null;
  type: "nap" | "night";
}

/** Calculate age in months from birthdate ISO string. */
export function calculateAgeMonths(birthdate: string, now?: Date): number {
  const birth = new Date(birthdate);
  const ref = now ?? new Date();
  let months = (ref.getFullYear() - birth.getFullYear()) * 12 + (ref.getMonth() - birth.getMonth());
  if (ref.getDate() < birth.getDate()) months--;
  return Math.max(0, months);
}

/** Get recommended wake window in minutes. If recentSleeps provided, adapts using 7-day average. */
export function getWakeWindow(ageMonths: number, recentSleeps?: SleepEntry[]): number {
  const range = findByAge(WAKE_WINDOWS, ageMonths);
  const defaultWW = (range.minMinutes + range.maxMinutes) / 2;

  if (!recentSleeps || recentSleeps.length < 2) return defaultWW;

  const avgWW = getAverageWakeWindowFromSleeps(recentSleeps);
  if (avgWW === null) return defaultWW;

  // Clamp to age-appropriate range
  return Math.max(range.minMinutes, Math.min(range.maxMinutes, avgWW));
}

/** Predict next nap time as ISO string. */
export function predictNextNap(
  lastWakeTime: string,
  ageMonths: number,
  recentSleeps?: SleepEntry[]
): string {
  const ww = getWakeWindow(ageMonths, recentSleeps);
  const wake = new Date(lastWakeTime);
  return new Date(wake.getTime() + ww * 60 * 1000).toISOString();
}

export interface PredictedNap {
  startTime: string;
  endTime: string;
}

/** Predict all naps for the day based on wake-up time and recent sleep patterns. */
export function predictDayNaps(
  wakeUpTime: string,
  ageMonths: number,
  recentSleeps?: SleepEntry[]
): PredictedNap[] {
  const napCount = findByAge(NAP_COUNTS, ageMonths);
  const ww = getWakeWindow(ageMonths, recentSleeps);
  const expectedNaps = napCount.naps;
  
  const predictions: PredictedNap[] = [];
  let currentWake = new Date(wakeUpTime);
  
  // Estimate nap duration based on age (younger babies = longer naps)
  const napDurationMinutes = ageMonths < 6 ? 60 : ageMonths < 12 ? 45 : 30;
  
  for (let i = 0; i < expectedNaps; i++) {
    const napStart = new Date(currentWake.getTime() + ww * 60 * 1000);
    const napEnd = new Date(napStart.getTime() + napDurationMinutes * 60 * 1000);
    
    predictions.push({
      startTime: napStart.toISOString(),
      endTime: napEnd.toISOString(),
    });
    
    // Next wake window starts after this nap ends
    currentWake = napEnd;
  }
  
  return predictions;
}

/** Recommend bedtime based on today's sleeps and age. */
export function recommendBedtime(todaySleeps: SleepEntry[], ageMonths: number): string {
  const napCount = findByAge(NAP_COUNTS, ageMonths);

  // If baby has had enough naps, recommend bedtime after last wake window
  const lastSleep = [...todaySleeps]
    .filter((s) => s.end_time)
    .sort((a, b) => new Date(b.end_time!).getTime() - new Date(a.end_time!).getTime())[0];

  if (!lastSleep?.end_time) {
    // Default: 19:00 today
    const today = new Date();
    today.setHours(19, 0, 0, 0);
    return today.toISOString();
  }

  const ww = getWakeWindow(ageMonths);
  // Last wake window of the day is typically longer
  const lastWWMultiplier = todaySleeps.length >= napCount.naps ? 1.15 : 1.0;
  const bedtime = new Date(
    new Date(lastSleep.end_time).getTime() + ww * lastWWMultiplier * 60 * 1000
  );

  // Clamp bedtime between 18:00 and 20:30
  const hour = bedtime.getHours() + bedtime.getMinutes() / 60;
  if (hour < 18) bedtime.setHours(18, 0, 0, 0);
  if (hour > 20.5) bedtime.setHours(20, 30, 0, 0);

  return bedtime.toISOString();
}

/** Detect if baby is transitioning to fewer naps. Returns suggested new nap count or null. */
export function detectNapTransition(
  recentDaysSleeps: SleepEntry[][]
): { dropping: boolean; currentAvgNaps: number; suggestedNaps: number } | null {
  if (recentDaysSleeps.length < 5) return null;

  const napCounts = recentDaysSleeps.map(
    (day) => day.filter((s) => s.type === "nap" && s.end_time).length
  );
  const avgNaps = napCounts.reduce((a, b) => a + b, 0) / napCounts.length;

  // Check if trending lower (last 3 days vs first days)
  const recent3 = napCounts.slice(-3);
  const earlier = napCounts.slice(0, -3);
  const recentAvg = recent3.reduce((a, b) => a + b, 0) / recent3.length;
  const earlierAvg = earlier.reduce((a, b) => a + b, 0) / earlier.length;

  if (earlierAvg - recentAvg >= 0.5) {
    return {
      dropping: true,
      currentAvgNaps: Math.round(avgNaps * 10) / 10,
      suggestedNaps: Math.round(recentAvg),
    };
  }

  return { dropping: false, currentAvgNaps: Math.round(avgNaps * 10) / 10, suggestedNaps: Math.round(avgNaps) };
}

/** Helper: compute average wake window from a list of sleeps (in minutes). */
function getAverageWakeWindowFromSleeps(sleeps: SleepEntry[]): number | null {
  const sorted = [...sleeps]
    .filter((s) => s.end_time)
    .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  if (sorted.length < 2) return null;

  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = new Date(sorted[i - 1].end_time!).getTime();
    const nextStart = new Date(sorted[i].start_time).getTime();
    const gapMin = (nextStart - prevEnd) / 60000;
    // Only count reasonable gaps (10 min to 8 hours)
    if (gapMin >= 10 && gapMin <= 480) {
      gaps.push(gapMin);
    }
  }

  if (gaps.length === 0) return null;
  return gaps.reduce((a, b) => a + b, 0) / gaps.length;
}
