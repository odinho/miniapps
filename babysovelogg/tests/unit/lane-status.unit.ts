import { test, expect } from "bun:test";
import { getLaneStatus, type LaneView } from "../../src/lib/lane-status.js";

const NOW = new Date("2026-06-14T10:00:00.000Z").getTime();

const pred = (over: Partial<NonNullable<LaneView["prediction"]>> = {}): LaneView["prediction"] => ({
  expectedNapEnd: null,
  expectedNightEnd: null,
  nextNap: null,
  bedtime: null,
  napsAllDone: false,
  ...over,
});

test("stale active sleep wins over everything", () => {
  const b: LaneView = {
    baby: { id: 1, name: "Ada" },
    activeSleep: { start_time: "2026-06-14T09:00:00.000Z", type: "nap", end_time: null },
    staleActiveSleep: { foo: 1 },
    prediction: pred({ nextNap: "2026-06-14T11:00:00.000Z" }),
  };
  expect(getLaneStatus(b, NOW)).toEqual({ kind: "stale" });
});

test("asleep: since + expected wake (nap honours a cap)", () => {
  const b: LaneView = {
    baby: { id: 1, name: "Ada" },
    activeSleep: { start_time: "2026-06-14T09:30:00.000Z", type: "nap", end_time: null },
    prediction: pred({ expectedNapEnd: "2026-06-14T10:45:00.000Z", napBudget: { wakeBy: "2026-06-14T10:30:00.000Z" } }),
  };
  expect(getLaneStatus(b, NOW)).toEqual({
    kind: "asleep",
    sinceMs: 30 * 60_000,
    expectedWake: "2026-06-14T10:30:00.000Z",
  });
});

test("awake: since + next nap; napsAllDone flips next to bedtime", () => {
  const base: LaneView = {
    baby: { id: 1, name: "Ada" },
    activeSleep: null,
    todaySleeps: [{ end_time: "2026-06-14T09:00:00.000Z" }],
    todayWakeUp: { wake_time: "2026-06-14T07:00:00.000Z" },
    prediction: pred({ nextNap: "2026-06-14T11:30:00.000Z", bedtime: "2026-06-14T19:00:00.000Z" }),
  };

  expect(getLaneStatus(base, NOW)).toEqual({
    kind: "awake",
    sinceMs: 60 * 60_000, // since last sleep end 09:00, not wake 07:00
    next: { kind: "nap", at: "2026-06-14T11:30:00.000Z" },
  });

  expect(getLaneStatus({ ...base, prediction: pred({ napsAllDone: true, nextNap: null, bedtime: "2026-06-14T19:00:00.000Z" }) }, NOW)).toEqual({
    kind: "awake",
    sinceMs: 60 * 60_000,
    next: { kind: "bedtime", at: "2026-06-14T19:00:00.000Z" },
  });
});

test("rescue skip-plan keeps a recommended nap even when napsAllDone (matches the Timer + button)", () => {
  const b: LaneView = {
    baby: { id: 1, name: "Ada" },
    activeSleep: null,
    todaySleeps: [{ end_time: "2026-06-14T09:00:00.000Z" }],
    prediction: pred({
      napsAllDone: true,
      nextNap: null,
      bedtime: "2026-06-14T19:00:00.000Z",
      postSkipPlan: { kind: "rescue", recommendedStart: "2026-06-14T10:20:00.000Z" },
    }),
  };
  // Must be the rescue nap, NOT bedtime — otherwise the lane says "leggetid"
  // while its own button starts a rescue nap.
  expect(getLaneStatus(b, NOW)).toEqual({
    kind: "awake",
    sinceMs: 60 * 60_000,
    next: { kind: "nap", at: "2026-06-14T10:20:00.000Z" },
  });
});

test("awake with no completed sleep falls back to today's wake; sub-minute → null", () => {
  const justWoke: LaneView = {
    baby: { id: 1, name: "Ada" },
    activeSleep: null,
    todayWakeUp: { wake_time: "2026-06-14T07:00:00.000Z" },
    prediction: pred(),
  };
  expect(getLaneStatus(justWoke, NOW)).toEqual({ kind: "awake", sinceMs: 3 * 60 * 60_000, next: null });

  const atWake: LaneView = {
    baby: { id: 1, name: "Ada" },
    activeSleep: null,
    todayWakeUp: { wake_time: "2026-06-14T09:59:30.000Z" }, // 30s ago
    prediction: pred(),
  };
  expect(getLaneStatus(atWake, NOW)).toEqual({ kind: "awake", sinceMs: null, next: null });
});
