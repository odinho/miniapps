import { getExpectedNapCount } from "./schedule.js";
import type { SleepLogRow, SleepPauseRow } from "$lib/types.js";

/** Simple hour-based classification fallback. */
export function classifySleepTypeByHour(hour?: number): "nap" | "night" {
  const h = hour ?? new Date().getHours();
  return h >= 18 || h < 6 ? "night" : "nap";
}

/** Smart classification: considers time-of-day, nap count, and last wake time.
 *  When `napsAllDone` is provided (from the prediction engine's resolveNapCount),
 *  it takes precedence over age-default nap counting. */
export function classifySleepType(
  todaySleeps: SleepLogRow[],
  ageMonths?: number,
  customNapCount?: number | null,
  hour?: number,
  napsAllDone?: boolean,
): "nap" | "night" {
  const h = hour ?? new Date().getHours();
  // Clear night (before 6am or after 8pm)
  if (h < 6 || h >= 20) return "night";
  // Clear daytime (before 4pm)
  if (h < 16) return "nap";
  // Ambiguous zone (16:00–19:59): check if naps are done for the day
  if (napsAllDone != null) {
    // Use the prediction engine's learned nap count (handles transitions correctly)
    if (napsAllDone) return "night";
  } else if (ageMonths != null) {
    // Fallback: age-default nap count (no prediction data available)
    const expectedNaps = getExpectedNapCount(ageMonths, customNapCount);
    const completedNaps = todaySleeps.filter((s) => s.type === "nap" && s.end_time).length;
    if (completedNaps >= expectedNaps) return "night";
  }
  // In the 16–18 range, if we haven't met nap count, still likely a nap
  if (h < 18) return "nap";
  return "night";
}

/** Check if a completed sleep should be reclassified as night based on duration and start time.
 *  Sleeps >6h starting after 17:00 are almost certainly night sleeps. */
export function shouldReclassifyAsNight(startTime: string, endTime: string): boolean {
  const start = new Date(startTime);
  const end = new Date(endTime);
  const durationMs = end.getTime() - start.getTime();
  const durationHours = durationMs / (1000 * 60 * 60);
  const startHour = start.getHours();
  return durationHours > 6 && startHour >= 17;
}

/** Total pause duration in milliseconds. */
export function calcPauseMs(pauses: SleepPauseRow[], nowMs?: number): number {
  const resolvedNow = nowMs ?? Date.now();
  let total = 0;
  for (const p of pauses) {
    const start = new Date(p.pause_time).getTime();
    const end = p.resume_time ? new Date(p.resume_time).getTime() : resolvedNow;
    total += end - start;
  }
  return total;
}
