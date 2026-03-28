import { getExpectedNapCount } from "./schedule.js";
import type { SleepLogRow, SleepPauseRow } from "$lib/types.js";

/** Simple hour-based classification fallback. */
export function classifySleepTypeByHour(hour?: number): "nap" | "night" {
  const h = hour ?? new Date().getHours();
  return h >= 18 || h < 6 ? "night" : "nap";
}

/** Smart classification: considers time-of-day, nap count, and last wake time. */
export function classifySleepType(
  todaySleeps: SleepLogRow[],
  ageMonths?: number,
  customNapCount?: number | null,
  hour?: number,
): "nap" | "night" {
  const h = hour ?? new Date().getHours();
  // Clear night (before 6am or after 8pm)
  if (h < 6 || h >= 20) return "night";
  // Clear daytime (before 4pm)
  if (h < 16) return "nap";
  // Ambiguous zone (16:00–19:59): check if naps are done for the day
  if (ageMonths != null) {
    const expectedNaps = getExpectedNapCount(ageMonths, customNapCount);
    const completedNaps = todaySleeps.filter((s) => s.type === "nap" && s.end_time).length;
    if (completedNaps >= expectedNaps) return "night";
  }
  // In the 16–18 range, if we haven't met nap count, still likely a nap
  if (h < 18) return "nap";
  return "night";
}

/** Total pause duration in milliseconds. */
export function calcPauseMs(pauses: SleepPauseRow[]): number {
  let total = 0;
  for (const p of pauses) {
    const start = new Date(p.pause_time).getTime();
    const end = p.resume_time ? new Date(p.resume_time).getTime() : Date.now();
    total += end - start;
  }
  return total;
}
