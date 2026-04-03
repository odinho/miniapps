import {
  calculateAgeMonths,
  predictNextNap,
  recommendBedtime,
  predictDayNaps,
  resolveNapCount,
  predictNapEndTime,
  predictNightEndTime,
} from "./schedule.js";
import { getTodayStats } from "./stats.js";
import { computeConfidence } from "./confidence.js";
import { calibrate } from "./calibration.js";
import type { Baby, SleepLogRow, SleepPauseRow, DayStartRow, SleepEntry, BabyContext } from "$lib/types.js";
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

/** Build a BabyContext from a Baby record and recent sleep data. */
function buildContext(baby: Baby, recentSleeps: SleepEntry[]): BabyContext {
  return {
    birthdate: baby.birthdate,
    ageMonths: calculateAgeMonths(baby.birthdate),
    tz: baby.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    customNapCount: baby.custom_nap_count ?? null,
    recentSleeps,
  };
}

/** Pure state assembly — takes fetched data, returns the API response shape. */
export function assembleState(data: DayData) {
  const { baby, activeSleep, todaySleeps, recentSleeps, todayWakeUp, pausesBySleep } = data;

  const recentEntries = recentSleeps.map(toSleepEntry);
  const ctx = buildContext(baby, recentEntries);

  const todaySleepsWithPauses = todaySleeps.map((s) => ({
    ...toSleepEntry(s),
    pauses: pausesBySleep.get(s.id) || [],
  }));
  const stats = getTodayStats(todaySleepsWithPauses);

  // Calculate predictions even during active sleep so ghost arcs stay visible
  const now = data.now ?? Date.now();
  let prediction = null;
  {
    const lastCompleted = todaySleeps.find((s) => s.end_time);
    const wakeTimeForPrediction = lastCompleted?.end_time || todayWakeUp?.wake_time;

    if (wakeTimeForPrediction) {
      const bedtime = recommendBedtime(todaySleeps.map(toSleepEntry), ctx);
      const bedtimeMs = new Date(bedtime).getTime();
      const completedNaps = todaySleeps.filter((s) => s.type === "nap" && s.end_time);
      // During active nap, count it toward consumed slots
      const consumedNaps = completedNaps.length + (activeSleep?.type === "nap" ? 1 : 0);
      const expectedNapCount = resolveNapCount(ctx);

      // Build predicted naps from day schedule (accounts for custom nap count)
      // Compute once — reused for predictions and confidence intervals below
      const allPredictedFromWakeUp = todayWakeUp
        ? predictDayNaps(todayWakeUp.wake_time, ctx)
        : [];
      let predictedNaps: PredictedNap[] | null = null;
      if (todayWakeUp) {
        const allPredicted = allPredictedFromWakeUp;
        let remaining = allPredicted.slice(consumedNaps);

        // If remaining predictions are stale (actual last wake is past the predicted
        // nap start), the schedule drifted — recalculate from the actual wake time
        if (remaining.length > 0) {
          const actualWakeMs = new Date(wakeTimeForPrediction).getTime();
          const predictedStartMs = new Date(remaining[0].startTime).getTime();
          if (actualWakeMs > predictedStartMs) {
            remaining = predictDayNaps(
              wakeTimeForPrediction,
              { ...ctx, customNapCount: remaining.length },
            );
          }
        }

        // B8: Filter out predicted naps starting within 60 min of bedtime
        predictedNaps = remaining.filter(
          (n) => new Date(n.startTime).getTime() < bedtimeMs - 60 * 60000,
        );
      }

      // B2: Derive nextNap from the day schedule when available (respects custom nap count)
      let nextNap: string;
      if (predictedNaps && predictedNaps.length > 0) {
        nextNap = predictedNaps[0].startTime;
      } else {
        nextNap = predictNextNap(wakeTimeForPrediction, ctx);
      }

      // Detect skipped naps: if the predicted next nap is >90 min overdue (same day), it was skipped
      const nextNapMs = new Date(nextNap).getTime();
      const overdueMs = now - nextNapMs;
      const napSkipped = !activeSleep && overdueMs > 90 * 60000 && overdueMs < 18 * 60 * 60000;
      const napsAllDone = consumedNaps >= expectedNapCount || napSkipped;

      // B8: Don't suggest a nap that starts within 60 min of bedtime
      if (nextNapMs > bedtimeMs - 60 * 60000 || napsAllDone) {
        // All naps done or too close to bedtime — show bedtime instead of next nap
        nextNap = bedtime;
      }

      // Clear predicted nap bubbles if all naps are done (by count or skipped)
      if (napsAllDone) {
        predictedNaps = null;
      }

      // During active night sleep, don't show stale daytime nap predictions
      if (activeSleep && activeSleep.type === "night") {
        predictedNaps = null;
      }

      // Compute confidence intervals and calibration
      const allPredictedForConf = allPredictedFromWakeUp;
      const confidence = allPredictedForConf.length > 0
        ? computeConfidence(allPredictedForConf, bedtime, ctx.ageMonths, ctx.recentSleeps, ctx.tz)
        : null;
      const calibration = calibrate(ctx.ageMonths, ctx.recentSleeps, ctx.customNapCount, ctx.tz);

      // Compute expected nap end for active naps
      let expectedNapEnd: string | null = null;
      if (activeSleep && activeSleep.type === "nap" && !activeSleep.end_time) {
        expectedNapEnd = predictNapEndTime(activeSleep.start_time, ctx);
      }

      // Compute expected night end for active night sleep
      let expectedNightEnd: string | null = null;
      if (activeSleep && activeSleep.type === "night" && !activeSleep.end_time) {
        const todayNapMin = todaySleeps
          .filter((s) => s.type === "nap" && s.end_time)
          .reduce((sum, s) => sum + (new Date(s.end_time!).getTime() - new Date(s.start_time).getTime()) / 60000, 0);
        expectedNightEnd = predictNightEndTime(activeSleep.start_time, ctx, todayNapMin);
      }

      prediction = {
        nextNap,
        bedtime,
        predictedNaps,
        napsAllDone: napsAllDone || activeSleep?.type === "night",
        expectedNapEnd,
        expectedNightEnd,
        confidence,
        calibration,
      };
    }
  }

  return {
    baby,
    activeSleep,
    todaySleeps,
    stats,
    prediction,
    ageMonths: ctx.ageMonths,
    diaperCount: data.diaperCount,
    lastDiaperTime: data.lastDiaperTime,
    todayWakeUp,
  };
}
