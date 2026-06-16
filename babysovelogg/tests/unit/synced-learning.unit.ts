import { describe, expect, it } from "bun:test";
import { getWakeWindow } from "$lib/engine/schedule.js";
import type { SleepEntry, BabyContext } from "$lib/types.js";

// Parent-policy-not-evidence (Phase 4, guardrail 5): a parent-accepted overlap
// nudge tags the sleep `synced`. Its wake window is policy, not the baby's
// natural rhythm, so WW learning must ignore it — otherwise a week of accepted
// nudges would teach a false wake window. This is the highest-value Phase-4
// correctness test.
//
// NOTE: these exercise the schedule HELPERS with hand-built SleepEntry. The flag
// only protects production if it survives the SleepLogRow→SleepEntry mapper
// (`toSleepEntry`) — which it once didn't, silently killing the whole feature.
// The end-to-end pin through assembleState lives in overlap-simulation.unit.ts.

const T = (h: number, m = 0) =>
  `2026-03-26T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

const ctx = (recentSleeps: SleepEntry[]): BabyContext => ({
  birthdate: "2025-07-26",
  ageMonths: 8,
  tz: "UTC",
  customNapCount: 2,
  recentSleeps,
});

// One complete day, naps spaced 200 min apart (the baby's natural wake window),
// with a night entry so the day counts as complete.
const naturalDay: SleepEntry[] = [
  { start_time: T(19), end_time: T(7), type: "night" },
  { start_time: T(7), end_time: T(8), type: "nap" },
  { start_time: T(11, 20), end_time: T(12, 20), type: "nap" }, // gap 200
  { start_time: T(15, 40), end_time: T(16, 40), type: "nap" }, // gap 200
];

// An extra nap pulled in early (gap 80 from the prior nap) — what an accepted
// overlap nudge looks like.
const nudgedNap = (synced: boolean): SleepEntry => ({
  start_time: T(18),
  end_time: T(18, 30),
  type: "nap",
  ...(synced ? { synced: 1 } : {}),
});

describe("synced nudges are excluded from wake-window learning", () => {
  const wwNatural = getWakeWindow(ctx(naturalDay));

  it("learns the natural wake window from un-nudged days", () => {
    expect(wwNatural).toBe(200);
  });

  it("a synced (nudge-accepted) nap does NOT move the learned wake window", () => {
    expect(getWakeWindow(ctx([...naturalDay, nudgedNap(true)]))).toBe(wwNatural);
  });

  it("the same nap WITHOUT the synced tag DOES drag it down (proves the tag is load-bearing)", () => {
    expect(getWakeWindow(ctx([...naturalDay, nudgedNap(false)]))).toBeLessThan(wwNatural);
  });
});
