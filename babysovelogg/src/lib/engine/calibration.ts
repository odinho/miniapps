/**
 * Calibration tracking — measures when the engine should trust itself vs back off.
 *
 * Surfaces data quality signals: how much data is available, how consistent
 * the baby's patterns are, and whether the engine is using learned values
 * or falling back to age defaults.
 */

import { NAP_COUNTS, findByAge } from "./constants.js";
import type { SleepEntry } from "$lib/types.js";
import { isoToDateInTz } from "$lib/tz.js";

export interface CalibrationReport {
  /** Overall trust level for the prediction */
  trust: "learned" | "partial" | "age-default";

  /** Breakdown of what's learned vs defaulted */
  napCount: DataSource;
  wakeWindows: DataSource;
  bedtimeWakeWindow: DataSource;
  napDuration: DataSource;

  /** How many days of usable data */
  daysWithData: number;
  /** How many total completed naps in the lookback window */
  completedNaps: number;

  /** Warnings about data quality */
  warnings: string[];
}

interface DataSource {
  source: "learned" | "age-default";
  sampleCount: number;
}

export function calibrate(
  ageMonths: number,
  recentSleeps?: SleepEntry[],
  customNapCount?: number | null,
  tz?: string,
): CalibrationReport {
  const timezone = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const warnings: string[] = [];

  // Count days with data and completed naps
  const daySet = new Set<string>();
  let completedNaps = 0;
  if (recentSleeps) {
    for (const s of recentSleeps) {
      if (!s.end_time) continue;
      daySet.add(isoToDateInTz(s.start_time, timezone));
      if (s.type === "nap") completedNaps++;
    }
  }
  const daysWithData = daySet.size;

  // ── Nap count calibration ──
  const napCountInfo = calibrateNapCount(recentSleeps, customNapCount, timezone, daysWithData);
  if (napCountInfo.source === "age-default" && daysWithData >= 5) {
    warnings.push("Uklart lurtal — mønsteret varierer mykje dei siste dagane");
  }

  // ── Wake window calibration ──
  const wwInfo = calibrateWakeWindows(recentSleeps, timezone);
  if (wwInfo.sampleCount < 4 && daysWithData >= 3) {
    warnings.push("Få vakevindu-målingar — prediksjonane kan vera upresise");
  }

  // ── Bedtime wake window calibration ──
  const bedWWInfo = calibrateBedtimeWW(recentSleeps);

  // ── Nap duration calibration ──
  const napDurInfo = calibrateNapDuration(recentSleeps);

  // ── Overall trust ──
  const sources = [napCountInfo, wwInfo, bedWWInfo, napDurInfo];
  const learnedCount = sources.filter((s) => s.source === "learned").length;

  let trust: CalibrationReport["trust"];
  if (daysWithData < 3) {
    trust = "age-default";
    if (daysWithData === 0) {
      warnings.push("Ingen søvndata — brukar aldersbaserte standardverdiar");
    } else {
      warnings.push("Berre " + daysWithData + " dag(ar) med data — prediksjonane blir betre med meir logging");
    }
  } else if (learnedCount >= 3) {
    trust = "learned";
  } else {
    trust = "partial";
  }

  // ── Age-specific warnings ──
  const ageNapRange = findByAge(NAP_COUNTS, ageMonths);
  if (ageNapRange.range[0] !== ageNapRange.range[1]) {
    // Baby is in an age bracket with variable nap counts (transition zone)
    if (napCountInfo.source === "age-default") {
      warnings.push(`Babyen er i ein overgangsalder (${ageNapRange.range[0]}–${ageNapRange.range[1]} lurar er vanleg) — vurder å setja lurtal manuelt`);
    }
  }

  return {
    trust,
    napCount: napCountInfo,
    wakeWindows: wwInfo,
    bedtimeWakeWindow: bedWWInfo,
    napDuration: napDurInfo,
    daysWithData,
    completedNaps,
    warnings,
  };
}

function calibrateNapCount(
  recentSleeps: SleepEntry[] | undefined,
  customNapCount: number | null | undefined,
  tz: string,
  daysWithData: number,
): DataSource {
  if (customNapCount != null) {
    return { source: "learned", sampleCount: daysWithData }; // Manual override counts as "learned"
  }
  if (!recentSleeps || recentSleeps.length < 4) {
    return { source: "age-default", sampleCount: 0 };
  }

  const napsByDay = new Map<string, number>();
  for (const s of recentSleeps) {
    if (s.type !== "nap" || !s.end_time) continue;
    const day = isoToDateInTz(s.start_time, tz);
    napsByDay.set(day, (napsByDay.get(day) ?? 0) + 1);
  }

  if (napsByDay.size < 3) {
    return { source: "age-default", sampleCount: napsByDay.size };
  }

  // Check if there's a dominant pattern (mirrors getLearnedNapCount logic)
  const freq = new Map<number, number>();
  for (const n of napsByDay.values()) freq.set(n, (freq.get(n) ?? 0) + 1);
  let modeCount = 0;
  for (const c of freq.values()) if (c > modeCount) modeCount = c;

  const dominance = modeCount / napsByDay.size;
  return {
    source: dominance > 0.4 ? "learned" : "age-default",
    sampleCount: napsByDay.size,
  };
}

function calibrateWakeWindows(
  recentSleeps: SleepEntry[] | undefined,
  _tz: string,
): DataSource {
  if (!recentSleeps || recentSleeps.length < 2) {
    return { source: "age-default", sampleCount: 0 };
  }

  const sorted = [...recentSleeps]
    .filter((s) => s.end_time)
    .toSorted((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  let gapCount = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].type !== "nap") continue;
    // Don't count policy-timed (synced) gaps — keep the trust sample count aligned
    // with what the wake-window learners actually learn from.
    if (sorted[i].synced || sorted[i - 1].synced) continue;
    const gapMin = (new Date(sorted[i].start_time).getTime() - new Date(sorted[i - 1].end_time!).getTime()) / 60_000;
    if (gapMin >= 10 && gapMin <= 480) gapCount++;
  }

  return {
    source: gapCount >= 4 ? "learned" : "age-default",
    sampleCount: gapCount,
  };
}

function calibrateBedtimeWW(recentSleeps: SleepEntry[] | undefined): DataSource {
  if (!recentSleeps || recentSleeps.length < 4) {
    return { source: "age-default", sampleCount: 0 };
  }

  const sorted = [...recentSleeps]
    .filter((s) => s.end_time)
    .toSorted((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  let gapCount = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].type !== "night" || sorted[i - 1].type !== "nap") continue;
    if (sorted[i - 1].synced) continue; // policy-timed last nap → not a trust sample
    const gapMin = (new Date(sorted[i].start_time).getTime() - new Date(sorted[i - 1].end_time!).getTime()) / 60_000;
    if (gapMin >= 60 && gapMin <= 600) gapCount++;
  }

  return {
    source: gapCount >= 2 ? "learned" : "age-default",
    sampleCount: gapCount,
  };
}

function calibrateNapDuration(recentSleeps: SleepEntry[] | undefined): DataSource {
  if (!recentSleeps) return { source: "age-default", sampleCount: 0 };

  const naps = recentSleeps.filter((s) => s.type === "nap" && s.end_time);
  const valid = naps.filter((s) => {
    const dur = (new Date(s.end_time!).getTime() - new Date(s.start_time).getTime()) / 60_000;
    return dur >= 10 && dur <= 180;
  });

  return {
    source: valid.length >= 3 ? "learned" : "age-default",
    sampleCount: valid.length,
  };
}
