import {
  calculateAgeMonths,
  predictNextNap,
  recommendBedtime,
  predictDayNaps,
  getExpectedNapCount,
} from "./schedule.js";
import { getTodayStats } from "./stats.js";
import type { Baby, SleepLogRow, SleepPauseRow, DayStartRow, SleepEntry } from "$lib/types.js";
import type { PredictedNap } from "./schedule.js";

export interface DayData {
  baby: Baby;
  activeSleep: SleepLogRow | undefined;
  todaySleeps: SleepLogRow[];
  recentSleeps: SleepLogRow[];
  todayWakeUp: DayStartRow | undefined;
  pausesBySleep: Map<number, SleepPauseRow[]>;
  diaperCount: number;
  lastDiaperTime: string | null;
  /** Optional override for "now", used by tests. Defaults to Date.now(). */
  now?: number;
}

function toSleepEntry(s: SleepLogRow): SleepEntry {
  return { start_time: s.start_time, end_time: s.end_time, type: s.type as SleepEntry["type"] };
}

/** Pure state assembly — takes fetched data, returns the API response shape. */
export function assembleState(data: DayData) {
  const { baby, activeSleep, todaySleeps, recentSleeps, todayWakeUp, pausesBySleep } = data;

  const ageMonths = calculateAgeMonths(baby.birthdate);

  const todaySleepsWithPauses = todaySleeps.map((s) => ({
    ...toSleepEntry(s),
    pauses: pausesBySleep.get(s.id) || [],
  }));
  const stats = getTodayStats(todaySleepsWithPauses);

  let prediction = null;
  if (!activeSleep) {
    const lastCompleted = todaySleeps.find((s) => s.end_time);
    const wakeTimeForPrediction = lastCompleted?.end_time || todayWakeUp?.wake_time;

    if (wakeTimeForPrediction) {
      const customNaps = baby.custom_nap_count ?? null;
      const bedtime = recommendBedtime(todaySleeps.map(toSleepEntry), ageMonths, customNaps);
      const bedtimeMs = new Date(bedtime).getTime();
      const completedNaps = todaySleeps.filter((s) => s.type === "nap" && s.end_time);
      const expectedNapCount = getExpectedNapCount(ageMonths, customNaps);

      // Build predicted naps from day schedule (accounts for custom nap count)
      let predictedNaps: PredictedNap[] | null = null;
      if (todayWakeUp) {
        const allPredicted = predictDayNaps(
          todayWakeUp.wake_time,
          ageMonths,
          recentSleeps.map(toSleepEntry),
          customNaps,
        );
        const remaining = allPredicted.slice(completedNaps.length);

        // B8: Filter out predicted naps starting within 60 min of bedtime
        predictedNaps = remaining.filter(
          (n) => new Date(n.startTime).getTime() < bedtimeMs - 60 * 60000,
        );
      }

      // B2: Derive nextNap from the day schedule when available (respects custom nap count)
      // instead of the simple age-based wake window
      let nextNap: string;
      if (predictedNaps && predictedNaps.length > 0) {
        nextNap = predictedNaps[0].startTime;
      } else {
        nextNap = predictNextNap(
          wakeTimeForPrediction,
          ageMonths,
          recentSleeps.map(toSleepEntry),
        );
      }

      // B8: Don't suggest a nap that starts within 60 min of bedtime
      const nextNapMs = new Date(nextNap).getTime();
      const napsAllDone = completedNaps.length >= expectedNapCount;
      if (nextNapMs > bedtimeMs - 60 * 60000 || napsAllDone) {
        // All naps done or too close to bedtime — show bedtime instead of next nap
        nextNap = bedtime;
      }

      prediction = {
        nextNap,
        bedtime,
        predictedNaps,
        napsAllDone,
      };
    }
  }

  return {
    baby,
    activeSleep,
    todaySleeps,
    stats,
    prediction,
    ageMonths,
    diaperCount: data.diaperCount,
    lastDiaperTime: data.lastDiaperTime,
    todayWakeUp,
  };
}
