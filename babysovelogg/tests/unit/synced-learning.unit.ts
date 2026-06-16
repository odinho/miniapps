import { describe, expect, it } from "bun:test";
import { getWakeWindow, getLearnedBedtimeWakeWindow } from "$lib/engine/schedule.js";
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

// Distinct-date variant for multi-day fixtures (each day a separate complete day).
const Td = (day: number, h: number) =>
  `2026-03-${String(day).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00.000Z`;

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

describe("synced nudges are excluded from bedtime-wake-window learning", () => {
  // A synced LAST nap was moved by policy, so its (shifted) end → bedtime gap is
  // not a natural bedtime-wake-window sample. Days carry distinct dates so the
  // learner sees them as separate complete days.
  const lastNapDay = (day: number, napStart: number, synced: boolean): SleepEntry[] => [
    { start_time: Td(day, napStart), end_time: Td(day, napStart + 1), type: "nap", ...(synced ? { synced: 1 } : {}) },
    { start_time: Td(day, 19), end_time: Td(day + 1, 7), type: "night" },
  ];

  // Baseline: last nap 16:00–17:00, bedtime 19:00 → a steady 120-min gap.
  const baseline = [10, 11, 12].flatMap((d) => lastNapDay(d, 16, false));
  const wwBaseline = getLearnedBedtimeWakeWindow(ctx(baseline));
  // An extra day whose last nap was pulled to 13:00–14:00 (a 300-min gap) — what
  // an accepted overlap nudge looks like.
  const withAnomaly = (synced: boolean) => [...baseline, ...lastNapDay(13, 13, synced)];

  it("learns the natural bedtime wake window from un-nudged days", () => {
    expect(wwBaseline).toBe(120);
  });

  it("a synced last nap does NOT pull the learned bedtime wake window", () => {
    expect(getLearnedBedtimeWakeWindow(ctx(withAnomaly(true)))).toBe(wwBaseline);
  });

  it("the same nap WITHOUT the tag DOES inflate it (proves the tag is load-bearing)", () => {
    expect(getLearnedBedtimeWakeWindow(ctx(withAnomaly(false)))).toBeGreaterThan(wwBaseline);
  });
});
