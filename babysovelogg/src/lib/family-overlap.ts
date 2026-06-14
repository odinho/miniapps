import type { BabyState } from "$lib/stores/app.svelte.js";
import type { SleepLogRow } from "$lib/types.js";
import { suggestOverlap, type BabyWindow, type OverlapSuggestion } from "$lib/engine/overlap.js";
import { getSleepCycleMinutes } from "$lib/engine/schedule.js";
import { isoToDateInTz } from "$lib/tz.js";

/** Structural subset of a BabyState slice this reads — keeps it tolerant of the
 *  server slice (activeSleep can be undefined there) and easy to unit-test. A
 *  BabyState satisfies it. */
export interface OverlapBabyInput {
  baby: BabyState["baby"];
  prediction: BabyState["prediction"];
  activeSleep?: SleepLogRow | null;
  staleActiveSleep?: BabyState["staleActiveSleep"];
  offDays: string[];
  ageMonths: number;
}

const minutesBetween = (aIso: string, bIso: string) =>
  (new Date(bIso).getTime() - new Date(aIso).getTime()) / 60_000;

/**
 * Project a per-baby engine slice onto the pure overlap layer's BabyWindow.
 * Reads only the OUTPUTS the engine already produced (prediction + confidence)
 * — it never re-runs or couples the learners. Returns a window with `blocked`
 * set when sync must yield to the baby's real needs: off-day, a forgotten/stale
 * sleep, low prediction confidence, or no prediction at all.
 */
export function buildBabyWindow(b: OverlapBabyInput, now: number): BabyWindow | null {
  if (!b.baby) return null;
  const p = b.prediction;
  const tz = b.baby.timezone || "UTC";
  const today = isoToDateInTz(new Date(now).toISOString(), tz);
  const blocked =
    !p ||
    !!b.staleActiveSleep ||
    b.offDays.includes(today) ||
    p.confidence?.level === "low";

  const asleep = !!(b.activeSleep && !b.activeSleep.end_time);
  let asleepUntil: BabyWindow["asleepUntil"] = null;
  if (asleep) {
    const expected = p?.expectedWakeRange?.point ?? p?.expectedNapEnd ?? p?.expectedNightEnd ?? null;
    asleepUntil = expected ? { expected } : null;
  }

  let next: BabyWindow["next"] = null;
  let window: BabyWindow["window"] = null;
  let sdMinutes: number | null = null;
  if (!asleep && p) {
    if (p.nextNap && !p.napsAllDone) {
      // Duration + ±1σ window come from the matching predicted nap / its range.
      const napIdx = p.predictedNaps?.findIndex((n) => n.startTime === p.nextNap) ?? -1;
      const predNap = napIdx >= 0 ? p.predictedNaps![napIdx] : p.predictedNaps?.[0] ?? null;
      const durationMin = predNap ? Math.round(minutesBetween(predNap.startTime, predNap.endTime)) : 90;
      next = { kind: "nap", plannedStart: p.nextNap, durationMin };
      const range = p.confidence?.napRanges?.find((r) => r.startTime === p.nextNap)?.startRange
        ?? p.confidence?.napRanges?.[napIdx >= 0 ? napIdx : 0]?.startRange
        ?? null;
      if (range) {
        window = { earliest: range.lo, latest: range.hi };
        sdMinutes = range.sdMinutes;
      }
    } else if (p.bedtime) {
      const durationMin = p.expectedNightEnd ? Math.round(minutesBetween(p.bedtime, p.expectedNightEnd)) : 600;
      next = { kind: "bedtime", plannedStart: p.bedtime, durationMin };
      const range = p.confidence?.bedtimeRange ?? null;
      if (range) {
        window = { earliest: range.lo, latest: range.hi };
        sdMinutes = range.sdMinutes;
      }
    }
  }

  return {
    babyId: b.baby.id,
    next,
    window,
    maxNudgeMin: getSleepCycleMinutes(b.ageMonths),
    asleepUntil,
    sdMinutes,
    blocked,
  };
}

/**
 * Family-level overlap suggestion for an opted-in twin pair. Returns null unless
 * there are exactly two children and a worthwhile, in-window nudge exists. The
 * opt-in gate (isTwinMode && syncMode) is the caller's responsibility.
 */
export function computeOverlapSuggestion(babies: OverlapBabyInput[], now: number): OverlapSuggestion | null {
  if (babies.length !== 2) return null;
  const a = buildBabyWindow(babies[0], now);
  const b = buildBabyWindow(babies[1], now);
  if (!a || !b) return null;
  return suggestOverlap(a, b, now);
}
