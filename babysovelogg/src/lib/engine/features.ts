/**
 * Strategy signal computation for the strategy selector.
 *
 * Pure functions that analyse recent sleep data and produce the signals
 * the selector uses to choose between newborn_guidance, emerging_rhythm,
 * and routine_schedule strategies.
 */
import type { SleepEntry, SleepPause } from "$lib/types.js";
import { isoToDateInTz } from "$lib/tz.js";
import { SLEEP_NEEDS, findByAge } from "./constants.js";
import { sleepDuration as gallandSleepDuration } from "$lib/data/galland2012.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface StrategySignals {
  ageMonths: number;
  ageWeeks: number;
  daysOfUsableData: number;
  /** Days with both nap(s) and a night entry (recognisable day structure) */
  completeDays: number;
  /** Fraction of sleep (by duration) occurring in the 18:00–08:00 window */
  nightDayRatio: number;
  /** SD of longest sleep stretch start time (minutes of day) */
  longestStretchConsistency: number;
  /** SD of first morning nap start time (minutes of day) */
  firstNapConsistency: number;
  /** SD of daily nap count */
  napCountSD: number;
  /** SD of observed wake windows (minutes) */
  wakeWindowSD: number;
  /** Fraction of days in the window that have complete data */
  loggingCompleteness: number;
}

/** 24h rolling sleep summary for newborn/emerging engines. */
export interface RollingSleepStats {
  /** Total asleep minutes in the last 24h — de-duplicated (union of asleep
   *  intervals), so overlapping rows count once and wakings are netted out. */
  totalSleep24h: number;
  /** Longest unbroken sleep segment in the last 24h (minutes), split on wakings */
  longestStretch: number;
  /** Mean sleep episode duration (minutes) — per logged row, NOT de-duplicated */
  meanEpisodeDuration: number;
  /** Number of sleep episodes in last 24h — per logged row, NOT de-duplicated */
  episodeCount: number;
}

/** Longest-stretch trend over the last ~2 weeks. */
export interface LongestStretchTrend {
  currentWeekAvg: number;   // minutes
  priorWeekAvg: number;     // minutes
  direction: "growing" | "stable" | "shrinking";
}

/** Age-appropriate norms from Galland/SHINE research. */
export interface AgeNorms {
  totalSleepHours: { min: number; max: number; typical: number };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface ParsedSleep {
  startMs: number;
  endMs: number;
  durationMin: number;
  /** Longest unbroken segment (minutes) after splitting on pauses. */
  longestSegment: number;
  type: "nap" | "night";
  localDate: string;
  startMinuteOfDay: number;
}

function parseSleeps(sleeps: SleepEntry[], tz: string): ParsedSleep[] {
  const result: ParsedSleep[] = [];
  for (const s of sleeps) {
    if (!s.end_time) continue;
    const startMs = new Date(s.start_time).getTime();
    const endMs = new Date(s.end_time).getTime();
    const durationMin = (endMs - startMs) / 60_000;
    if (durationMin <= 0) continue;
    result.push({
      startMs,
      endMs,
      durationMin,
      longestSegment: longestSegmentMin(startMs, endMs, s.pauses),
      type: s.type,
      localDate: isoToDateInTz(s.start_time, tz),
      startMinuteOfDay: getMinuteOfDay(new Date(startMs), tz),
    });
  }
  result.sort((a, b) => a.startMs - b.startMs);
  return result;
}

const minuteFmts = new Map<string, Intl.DateTimeFormat>();
function getMinuteOfDay(date: Date, tz: string): number {
  let fmt = minuteFmts.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
    });
    minuteFmts.set(tz, fmt);
  }
  const parts = fmt.formatToParts(date);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h * 60 + m;
}

/**
 * Pauses resolved to epoch-ms [pause, resume], clipped to a sleep episode,
 * and merged so overlapping wakings can't double-count. An open waking
 * (`resume_time: null`, baby still awake inside an active sleep) resolves to
 * the episode end — for an active sleep that's `endMs = now`.
 */
function resolvedBreaks(
  pauses: SleepPause[] | undefined,
  startMs: number,
  endMs: number,
): Array<{ pause: number; resume: number }> {
  if (!pauses || pauses.length === 0) return [];
  const clipped = pauses
    .map((p) => ({
      pause: Math.max(new Date(p.pause_time).getTime(), startMs),
      resume: Math.min(p.resume_time ? new Date(p.resume_time).getTime() : endMs, endMs),
    }))
    .filter((b) => b.resume > b.pause)
    .toSorted((a, b) => a.pause - b.pause);
  const merged: Array<{ pause: number; resume: number }> = [];
  for (const b of clipped) {
    const last = merged[merged.length - 1];
    if (last && b.pause <= last.resume) last.resume = Math.max(last.resume, b.resume);
    else merged.push({ ...b });
  }
  return merged;
}

/**
 * Longest unbroken sleep segment (minutes) within an episode, splitting on
 * `pauses` (night_waking intervals or coalesced awake gaps). Mirrors
 * `stats.ts:getLongestNightStretches` so the newborn card and the stats page
 * agree on what "longest stretch" means. Falls back to full span with no pauses.
 */
function longestSegmentMin(startMs: number, endMs: number, pauses?: SleepPause[]): number {
  const breaks = resolvedBreaks(pauses, startMs, endMs);
  if (breaks.length === 0) return (endMs - startMs) / 60_000;
  let longest = 0;
  let segStart = startMs;
  for (const b of breaks) {
    const seg = (b.pause - segStart) / 60_000;
    if (seg > longest) longest = seg;
    segStart = b.resume;
  }
  const lastSeg = (endMs - segStart) / 60_000;
  if (lastSeg > longest) longest = lastSeg;
  return longest;
}

/** Pause (awake) minutes overlapping the window [winStart, winEnd]. */
function pauseMinInWindow(
  pauses: SleepPause[] | undefined,
  winStart: number,
  winEnd: number,
): number {
  let total = 0;
  for (const b of resolvedBreaks(pauses, winStart, winEnd)) total += b.resume - b.pause;
  return total / 60_000;
}

/**
 * Asleep sub-intervals of one episode within [winStart, winEnd]: the clipped
 * episode minus its pauses (wakings). Used to union sleep across episodes so
 * overlapping rows (e.g. a long night with a duplicate inner night row) don't
 * double-count toward the 24h total.
 */
function asleepIntervals(
  winStart: number,
  winEnd: number,
  pauses: SleepPause[] | undefined,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let cur = winStart;
  for (const b of resolvedBreaks(pauses, winStart, winEnd)) {
    if (b.pause > cur) out.push([cur, b.pause]);
    cur = b.resume;
  }
  if (winEnd > cur) out.push([cur, winEnd]);
  return out;
}

/** Total minutes covered by the union of [start, end] intervals. */
function unionMinutes(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = intervals.toSorted((a, b) => a[0] - b[0]);
  let total = 0;
  let [curStart, curEnd] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s <= curEnd) curEnd = Math.max(curEnd, e);
    else { total += curEnd - curStart; curStart = s; curEnd = e; }
  }
  total += curEnd - curStart;
  return total / 60_000;
}

function sd(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// ─── Signal computation ───────────────────────────────────────────────────────

/**
 * Compute strategy signals from recent sleep data.
 *
 * @param sleeps - All available recent sleep entries (typically 14-30 days)
 * @param birthdate - Baby's birthdate (ISO date string)
 * @param tz - IANA timezone
 * @param now - Optional override for "now" (epoch ms), defaults to Date.now()
 */
export function computeStrategySignals(
  sleeps: SleepEntry[],
  birthdate: string,
  tz: string,
  now?: number,
): StrategySignals {
  const refDate = new Date(now ?? Date.now());
  const birth = new Date(birthdate);
  const ageMs = refDate.getTime() - birth.getTime();
  const ageWeeks = Math.max(0, Math.floor(ageMs / (7 * 24 * 60 * 60 * 1000)));
  const ageMonths = Math.max(0,
    (refDate.getFullYear() - birth.getFullYear()) * 12
    + (refDate.getMonth() - birth.getMonth())
    - (refDate.getDate() < birth.getDate() ? 1 : 0),
  );

  const parsed = parseSleeps(sleeps, tz);
  if (parsed.length === 0) {
    return {
      ageMonths, ageWeeks,
      daysOfUsableData: 0, completeDays: 0,
      nightDayRatio: 0, longestStretchConsistency: Infinity,
      firstNapConsistency: Infinity, napCountSD: Infinity,
      wakeWindowSD: Infinity, loggingCompleteness: 0,
    };
  }

  // Group by local date
  const byDay = new Map<string, ParsedSleep[]>();
  for (const s of parsed) {
    let day = byDay.get(s.localDate);
    if (!day) { day = []; byDay.set(s.localDate, day); }
    day.push(s);
  }

  const daysOfUsableData = byDay.size;

  // Complete days: have at least one nap AND one night
  const completeDayKeys: string[] = [];
  for (const [key, daySleeps] of byDay) {
    const hasNap = daySleeps.some((s) => s.type === "nap");
    const hasNight = daySleeps.some((s) => s.type === "night");
    if (hasNap && hasNight) completeDayKeys.push(key);
  }
  const completeDays = completeDayKeys.length;

  // Night-day ratio: fraction of total sleep duration that's "night" sleep.
  //
  // The earlier heuristic used a hard-coded 18:00-08:00 start window to
  // decide what counted as a night. That mis-classified anyone with an
  // early bedtime — a Norwegian-style 17:30-18:00 baby (1-nap transition,
  // big nap deficit forcing earlier bed) had real `type="night"` sleeps
  // sitting just outside the window. The engine then computed a ratio
  // below the 0.55 routine-schedule threshold and demoted them to
  // emerging-rhythm despite being firmly on a stable 1-nap schedule.
  //
  // Trust the explicit `type` tag when present (it's been required on the
  // sleep schema for ages). Fall back to the clock-time heuristic only for
  // entries that lack a type — defensive against legacy/imported data, not
  // something we'd hit on real prod records.
  let nightWindowMin = 0;
  let totalMin = 0;
  for (const s of parsed) {
    totalMin += s.durationMin;
    if (s.type === "night") {
      nightWindowMin += s.durationMin;
      continue;
    }
    if (s.type === "nap") continue;
    // Untyped: fall back to start-hour window.
    const startHour = s.startMinuteOfDay / 60;
    if (startHour >= 18 || startHour < 8) nightWindowMin += s.durationMin;
  }
  const nightDayRatio = totalMin > 0 ? nightWindowMin / totalMin : 0;

  // Longest stretch per day — consistency of its start time
  const longestStretchStarts: number[] = [];
  for (const daySleeps of byDay.values()) {
    let longest: ParsedSleep | null = null;
    for (const s of daySleeps) {
      if (!longest || s.durationMin > longest.durationMin) longest = s;
    }
    if (longest) longestStretchStarts.push(longest.startMinuteOfDay);
  }
  const longestStretchConsistency = sd(longestStretchStarts);

  // First nap consistency: SD of first nap start time across days
  const firstNapStarts: number[] = [];
  for (const daySleeps of byDay.values()) {
    const firstNap = daySleeps.find((s) => s.type === "nap");
    if (firstNap) firstNapStarts.push(firstNap.startMinuteOfDay);
  }
  const firstNapConsistency = sd(firstNapStarts);

  // Nap count SD
  const napCounts: number[] = [];
  for (const daySleeps of byDay.values()) {
    napCounts.push(daySleeps.filter((s) => s.type === "nap").length);
  }
  const napCountSD = sd(napCounts);

  // Wake window SD: gaps between consecutive sleeps
  const wakeWindows: number[] = [];
  for (let i = 1; i < parsed.length; i++) {
    const gapMin = (parsed[i].startMs - parsed[i - 1].endMs) / 60_000;
    if (gapMin >= 5 && gapMin <= 480) wakeWindows.push(gapMin);
  }
  const wakeWindowSD = sd(wakeWindows);

  // Logging completeness: fraction of calendar days in the data range that have entries
  const sortedDates = [...byDay.keys()].toSorted();
  let calendarDays = 1;
  if (sortedDates.length >= 2) {
    const firstDay = new Date(sortedDates[0] + "T12:00:00Z").getTime();
    const lastDay = new Date(sortedDates[sortedDates.length - 1] + "T12:00:00Z").getTime();
    calendarDays = Math.max(1, Math.round((lastDay - firstDay) / (24 * 60 * 60 * 1000)) + 1);
  }
  const loggingCompleteness = daysOfUsableData / calendarDays;

  return {
    ageMonths,
    ageWeeks,
    daysOfUsableData,
    completeDays,
    nightDayRatio,
    longestStretchConsistency,
    firstNapConsistency,
    napCountSD,
    wakeWindowSD,
    loggingCompleteness,
  };
}

// ─── Newborn engine helpers ───────────────────────────────────────────────────

/**
 * Compute rolling 24h sleep statistics.
 *
 * @param sleeps - All recent sleep entries
 * @param tz - IANA timezone
 * @param now - Reference time (epoch ms), defaults to Date.now()
 */
export function computeRollingSleepStats(
  sleeps: SleepEntry[],
  tz: string,
  now?: number,
): RollingSleepStats {
  const refMs = now ?? Date.now();
  const window24h = 24 * 60 * 60 * 1000;
  const cutoff = refMs - window24h;

  let longestStretch = 0;
  let episodeCount = 0;
  let totalDuration = 0;
  // Asleep sub-intervals across all episodes, unioned at the end so two
  // overlapping rows (e.g. Umi's long night fully containing a duplicate
  // inner night row) count once toward the 24h total instead of summing.
  const asleep: Array<[number, number]> = [];

  for (const s of sleeps) {
    const startMs = new Date(s.start_time).getTime();
    // An active sleep (no end_time yet) counts toward 24h with effective
    // end = now. Skipping active sleeps made "Søvn siste 24t" look
    // wildly under-reported for parents staring at a running timer —
    // e.g. an 11mo mid-nap saw 8.6 h while she'd actually slept ~16 h
    // including the active nap.
    const endMs = s.end_time ? new Date(s.end_time).getTime() : refMs;
    // Include episodes that overlap with the 24h window
    if (endMs < cutoff) continue;
    if (startMs > refMs) continue;

    const effectiveStart = Math.max(startMs, cutoff);
    const effectiveEnd = Math.min(endMs, refMs);
    const spanMin = (effectiveEnd - effectiveStart) / 60_000;
    if (spanMin <= 0) continue;

    // Net out wakings (night_waking pauses / coalesced awake gaps) so the
    // "one long night + waking" model doesn't overstate sleep vs a baby
    // whose night is logged as separate segments.
    const durationMin = spanMin - pauseMinInWindow(s.pauses, effectiveStart, effectiveEnd);
    if (durationMin <= 0) continue;

    episodeCount++;
    asleep.push(...asleepIntervals(effectiveStart, effectiveEnd, s.pauses));

    const fullDuration = (endMs - startMs) / 60_000 - pauseMinInWindow(s.pauses, startMs, endMs);
    totalDuration += fullDuration;
    const segment = longestSegmentMin(startMs, endMs, s.pauses);
    if (segment > longestStretch) longestStretch = segment;
  }

  return {
    totalSleep24h: Math.round(unionMinutes(asleep)),
    longestStretch: Math.round(longestStretch),
    meanEpisodeDuration: episodeCount > 0 ? Math.round(totalDuration / episodeCount) : 0,
    episodeCount,
  };
}

/**
 * Compute the longest-stretch trend by comparing the most recent 7 days
 * to the prior 7 days.
 */
export function computeLongestStretchTrend(
  sleeps: SleepEntry[],
  tz: string,
  now?: number,
): LongestStretchTrend {
  const parsed = parseSleeps(sleeps, tz);
  const byDay = new Map<string, ParsedSleep[]>();
  for (const s of parsed) {
    let day = byDay.get(s.localDate);
    if (!day) { day = []; byDay.set(s.localDate, day); }
    day.push(s);
  }

  const sortedDates = [...byDay.keys()].toSorted();
  const refMs = now ?? Date.now();
  const refDate = isoToDateInTz(new Date(refMs).toISOString(), tz);

  // Split into current week (last 7 days) and prior week (7-14 days ago)
  const currentWeekLongest: number[] = [];
  const priorWeekLongest: number[] = [];

  for (const dateStr of sortedDates) {
    const dayMs = new Date(dateStr + "T12:00:00Z").getTime();
    const refDayMs = new Date(refDate + "T12:00:00Z").getTime();
    const daysAgo = (refDayMs - dayMs) / (24 * 60 * 60 * 1000);

    const daySleeps = byDay.get(dateStr)!;
    let longest = 0;
    for (const s of daySleeps) {
      if (s.longestSegment > longest) longest = s.longestSegment;
    }

    if (daysAgo >= 0 && daysAgo < 7) {
      currentWeekLongest.push(longest);
    } else if (daysAgo >= 7 && daysAgo < 14) {
      priorWeekLongest.push(longest);
    }
  }

  const currentWeekAvg = currentWeekLongest.length > 0
    ? Math.round(currentWeekLongest.reduce((a, b) => a + b, 0) / currentWeekLongest.length)
    : 0;
  const priorWeekAvg = priorWeekLongest.length > 0
    ? Math.round(priorWeekLongest.reduce((a, b) => a + b, 0) / priorWeekLongest.length)
    : 0;

  let direction: LongestStretchTrend["direction"];
  if (priorWeekAvg === 0 || currentWeekLongest.length < 2) {
    direction = "stable";
  } else {
    const changePct = (currentWeekAvg - priorWeekAvg) / priorWeekAvg;
    if (changePct > 0.1) direction = "growing";
    else if (changePct < -0.1) direction = "shrinking";
    else direction = "stable";
  }

  return { currentWeekAvg, priorWeekAvg, direction };
}

/**
 * Get age-appropriate sleep norms for parent-facing display.
 *
 * Uses the wide Galland 2012 population ranges (mean ± 1.96 SD = 95% CI)
 * so parents of normal outlier babies don't get false "below/above normal"
 * warnings. The narrower SLEEP_NEEDS ranges remain for internal engine use.
 */
export function getAgeNorms(ageMonths: number): AgeNorms {
  const need = findByAge(SLEEP_NEEDS, ageMonths);

  // Find the best-matching Galland age band (skip "All ..." summary rows)
  const gallandBand = gallandSleepDuration.ageBands.find((b) => {
    if ("note" in b) return false; // skip summary rows
    const [lo, hi] = b.ageMonths;
    return ageMonths >= lo && ageMonths <= hi;
  });

  if (gallandBand) {
    return {
      totalSleepHours: {
        min: gallandBand.lower,
        max: gallandBand.upper,
        typical: need.totalHours,
      },
    };
  }

  // Fallback to SLEEP_NEEDS if no Galland band matches (unlikely for infants)
  return {
    totalSleepHours: {
      min: need.range[0],
      max: need.range[1],
      typical: need.totalHours,
    },
  };
}

/**
 * Compute sleep pressure level based on time since last sleep.
 *
 * When enough observed wake windows are available (≥5), thresholds are derived
 * from the baby's own distribution (p25 = low→rising, p75 = rising→high),
 * blended with age-based defaults proportional to sample count.
 * This avoids prescribing population-level norms to babies with different patterns.
 *
 * @param lastSleepEndMs - When the last sleep ended (epoch ms)
 * @param ageMonths - Baby's age in months
 * @param now - Reference time (epoch ms)
 * @param recentWakeWindows - Observed wake windows (minutes), optional
 */
export function computeSleepPressure(
  lastSleepEndMs: number,
  ageMonths: number,
  now?: number,
  recentWakeWindows?: number[],
): "low" | "rising" | "high" {
  const refMs = now ?? Date.now();
  const awakeMin = (refMs - lastSleepEndMs) / 60_000;

  // Age-based defaults
  const ageLow = ageMonths < 1 ? 25
    : ageMonths < 2 ? 35
    : ageMonths < 3 ? 45
    : ageMonths < 4 ? 60 : 75;
  const ageHigh = ageMonths < 1 ? 50
    : ageMonths < 2 ? 65
    : ageMonths < 3 ? 80
    : ageMonths < 4 ? 100 : 120;

  let lowThreshold = ageLow;
  let highThreshold = ageHigh;

  // Blend in baby's own wake windows when we have enough data
  const wws = recentWakeWindows ?? [];
  if (wws.length >= 5) {
    const sorted = [...wws].toSorted((a, b) => a - b);
    const babyLow = sorted[Math.floor(sorted.length * 0.25)];
    const babyHigh = sorted[Math.floor(sorted.length * 0.75)];
    // Ramp blend from 0 at 5 samples to 1 at 15 samples
    const blend = Math.min(1, (wws.length - 5) / 10);
    lowThreshold = ageLow * (1 - blend) + babyLow * blend;
    highThreshold = ageHigh * (1 - blend) + babyHigh * blend;
  }

  if (awakeMin < lowThreshold) return "low";
  if (awakeMin >= highThreshold) return "high";
  return "rising";
}

/**
 * Compute a sleep window (earliest–latest likely sleep time) for newborn/emerging mode.
 *
 * @param lastSleepEndMs - When the last sleep ended (epoch ms)
 * @param recentWakeWindows - Recent observed wake windows (minutes)
 * @param ageMonths - Baby's age in months
 */
export function computeSleepWindow(
  lastSleepEndMs: number,
  recentWakeWindows: number[],
  ageMonths: number,
): { earliestMs: number; latestMs: number } {
  // Age-based fallback ranges
  const ageMin = ageMonths < 1 ? 25 : ageMonths < 2 ? 35 : ageMonths < 3 ? 50 : ageMonths < 4 ? 60 : 75;
  const ageMax = ageMonths < 1 ? 60 : ageMonths < 2 ? 75 : ageMonths < 3 ? 90 : ageMonths < 4 ? 120 : 150;

  let minWW = ageMin;
  let maxWW = ageMax;

  if (recentWakeWindows.length >= 3) {
    const sorted = [...recentWakeWindows].toSorted((a, b) => a - b);
    const babyMin = Math.max(15, sorted[Math.floor(sorted.length * 0.25)] - 10);
    const babyMax = sorted[Math.floor(sorted.length * 0.75)] + 15;
    // Ramp blend: 0 at 3 samples, 1 at 8+ samples
    const blend = Math.min(1, (recentWakeWindows.length - 3) / 5);
    minWW = ageMin * (1 - blend) + babyMin * blend;
    maxWW = ageMax * (1 - blend) + babyMax * blend;
  }

  return {
    earliestMs: lastSleepEndMs + minWW * 60_000,
    latestMs: lastSleepEndMs + maxWW * 60_000,
  };
}

/**
 * Extract recent wake windows from sleep data (all episodes, ignoring nap/night labels).
 * Used by the newborn engine where the nap/night distinction is unreliable.
 */
export function extractWakeWindows(sleeps: SleepEntry[]): number[] {
  const completed = sleeps
    .filter((s) => s.end_time)
    .map((s) => ({ startMs: new Date(s.start_time).getTime(), endMs: new Date(s.end_time!).getTime() }))
    .toSorted((a, b) => a.startMs - b.startMs);

  const gaps: number[] = [];
  for (let i = 1; i < completed.length; i++) {
    const gapMin = (completed[i].startMs - completed[i - 1].endMs) / 60_000;
    if (gapMin >= 5 && gapMin <= 480) gaps.push(gapMin);
  }
  return gaps;
}
