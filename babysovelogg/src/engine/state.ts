import {
  calculateAgeMonths,
  predictNextNap,
  recommendBedtime,
  predictDayNaps,
} from "./schedule.js";
import { getTodayStats } from "./stats.js";
import type { Baby, SleepLogRow, SleepPauseRow, DayStartRow, SleepEntry } from "../../types.js";

export interface DayData {
  baby: Baby;
  activeSleep: SleepLogRow | undefined;
  todaySleeps: SleepLogRow[];
  recentSleeps: SleepLogRow[];
  todayWakeUp: DayStartRow | undefined;
  pausesBySleep: Map<number, SleepPauseRow[]>;
  diaperCount: number;
  lastDiaperTime: string | null;
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

      let predictedNaps = null;
      if (todayWakeUp) {
        const allPredicted = predictDayNaps(
          todayWakeUp.wake_time,
          ageMonths,
          recentSleeps.map(toSleepEntry),
          customNaps,
        );
        const completedNaps = todaySleeps.filter((s) => s.type === "nap" && s.end_time);
        predictedNaps = allPredicted.slice(completedNaps.length);
      }

      prediction = {
        nextNap: predictNextNap(wakeTimeForPrediction, ageMonths, recentSleeps.map(toSleepEntry)),
        bedtime,
        predictedNaps,
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
