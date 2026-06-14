import type { SleepLogRow, NightWakingRow } from "$lib/types.js";

/** How far back the family handoff timeline looks. */
export const HANDOFF_WINDOW_MS = 6 * 60 * 60 * 1000;

export interface HandoffSegment {
  /** ms, clipped to the [now - window, now] range. */
  startMs: number;
  endMs: number;
  type: "nap" | "night";
  /** Still in progress (no end_time) — ends at `now`. */
  ongoing: boolean;
}

export interface HandoffWaking {
  startMs: number;
  /** null while the waking is still ongoing. */
  endMs: number | null;
}

/** Structural slice of a BabyState the handoff reads. A BabyState satisfies it. */
export interface HandoffInput {
  priorOvernightSleep?: SleepLogRow | null;
  todaySleeps?: SleepLogRow[];
  activeSleep?: SleepLogRow | null;
  todayNightWakings?: NightWakingRow[];
}

/**
 * Sleep blocks intersecting the last `HANDOFF_WINDOW_MS`, clipped to the window
 * and to `now`, sorted by start. Combines the prior overnight (which straddles
 * midnight), today's sleeps, and any open session — deduped by domain_id since
 * the active sleep also appears in todaySleeps once it started today.
 */
export function handoffSegments(b: HandoffInput, now: number): HandoffSegment[] {
  const windowStart = now - HANDOFF_WINDOW_MS;
  const seen = new Set<string>();
  const out: HandoffSegment[] = [];
  const sources = [b.priorOvernightSleep, ...(b.todaySleeps ?? []), b.activeSleep];
  for (const s of sources) {
    if (!s || s.deleted) continue;
    if (seen.has(s.domain_id)) continue;
    seen.add(s.domain_id);
    const start = new Date(s.start_time).getTime();
    const end = s.end_time ? new Date(s.end_time).getTime() : now;
    const clippedStart = Math.max(start, windowStart);
    const clippedEnd = Math.min(end, now);
    if (clippedEnd <= clippedStart) continue;
    out.push({
      startMs: clippedStart,
      endMs: clippedEnd,
      type: s.type as "nap" | "night",
      ongoing: !s.end_time,
    });
  }
  out.sort((x, y) => x.startMs - y.startMs);
  return out;
}

/** Night-wakings intersecting the window, clipped and sorted. */
export function handoffWakings(b: HandoffInput, now: number): HandoffWaking[] {
  const windowStart = now - HANDOFF_WINDOW_MS;
  const out: HandoffWaking[] = [];
  for (const w of b.todayNightWakings ?? []) {
    if (w.deleted) continue;
    const start = new Date(w.start_time).getTime();
    const end = w.end_time ? new Date(w.end_time).getTime() : null;
    const effEnd = end ?? now;
    if (effEnd <= windowStart || start >= now) continue;
    out.push({ startMs: Math.max(start, windowStart), endMs: end });
  }
  out.sort((x, y) => x.startMs - y.startMs);
  return out;
}
