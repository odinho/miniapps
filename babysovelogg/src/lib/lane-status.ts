import { expectedWakeFor, type FamilySleepView } from "$lib/family.js";

// Compact per-baby status for a family-home lane: asleep (since + expected
// wake), awake (since + next nap/bedtime), or a stale-sleep warning. Pure so
// it's unit-tested directly; FamilyHome just renders the result.

/** Structural subset of a BabyState slice this needs — keeps the helper
 *  testable with small fixtures and free of an app-store import. A `BabyState`
 *  satisfies it. */
export interface LaneView extends FamilySleepView {
  activeSleep?: { start_time: string; type: string; end_time: string | null } | null;
  staleActiveSleep?: unknown | null;
  prediction?:
    | (FamilySleepView["prediction"] & {
        nextNap?: string | null;
        bedtime?: string | null;
        napsAllDone?: boolean;
        // Structural subset of PostSkipPlan — a rescue keeps a recommended nap
        // alive even when napsAllDone is true (mirrors the SleepButton guard),
        // so the lane mustn't collapse straight to bedtime.
        postSkipPlan?: { kind: string; recommendedStart?: string; suggestedBedtime?: string } | null;
      })
    | null;
  todaySleeps?: { end_time: string | null }[];
  todayWakeUp?: { wake_time: string | null } | null;
}

export type LaneNext = { kind: "nap" | "bedtime"; at: string };

export type LaneStatus =
  | { kind: "stale" }
  | { kind: "asleep"; sinceMs: number; expectedWake: string | null }
  | { kind: "awake"; sinceMs: number | null; next: LaneNext | null };

/** Minimum awake duration worth showing (mirrors getAwakeSince). */
const AWAKE_FLOOR_MS = 60_000;

function awakeSinceMs(b: LaneView, now: number): number | null {
  const lastEnd = b.todaySleeps?.find((s) => s.end_time)?.end_time;
  const since = lastEnd ?? b.todayWakeUp?.wake_time ?? null;
  if (!since) return null;
  const ms = now - new Date(since).getTime();
  return ms > AWAKE_FLOOR_MS ? ms : null;
}

function nextAction(b: LaneView): LaneNext | null {
  const p = b.prediction;
  if (!p) return null;
  // A skip-recovery plan overrides the napsAllDone→bedtime collapse, matching
  // the focused Timer and the lane's own SleepButton.
  const skip = p.postSkipPlan;
  if (skip?.kind === "rescue" && skip.recommendedStart) return { kind: "nap", at: skip.recommendedStart };
  if (skip?.kind === "earlier-bedtime" && skip.suggestedBedtime) return { kind: "bedtime", at: skip.suggestedBedtime };
  if (p.napsAllDone && p.bedtime) return { kind: "bedtime", at: p.bedtime };
  if (p.nextNap) return { kind: "nap", at: p.nextNap };
  if (p.bedtime) return { kind: "bedtime", at: p.bedtime };
  return null;
}

export function getLaneStatus(b: LaneView, now: number): LaneStatus {
  if (b.staleActiveSleep) return { kind: "stale" };
  if (b.activeSleep && !b.activeSleep.end_time) {
    return {
      kind: "asleep",
      sinceMs: now - new Date(b.activeSleep.start_time).getTime(),
      expectedWake: expectedWakeFor(b),
    };
  }
  return { kind: "awake", sinceMs: awakeSinceMs(b, now), next: nextAction(b) };
}
