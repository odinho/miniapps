import { test, expect } from "bun:test";
import { getCombinedStatus, type FamilySleepView, type FirstWake } from "../../src/lib/family.js";

const NOW = new Date("2026-06-14T10:00:00.000Z").getTime();

const slice = (id: number, name: string, asleep: boolean): FamilySleepView => ({
  baby: { id, name },
  activeSleep: asleep ? { type: "nap", end_time: null } : null,
  prediction: { expectedNapEnd: null, expectedNightEnd: null },
});

const wake = (name: string, at: string): FirstWake => ({ babyId: 1, name, at });

test("both asleep with a known first wake → both-asleep + countdown", () => {
  expect(
    getCombinedStatus([slice(1, "Ada", true), slice(2, "Bo", true)], wake("Ada", "2026-06-14T10:18:00.000Z"), NOW),
  ).toEqual({ kind: "both-asleep", firstWake: { name: "Ada", inMs: 18 * 60_000 } });
});

test("both asleep, no predicted wake → both-asleep, firstWake null", () => {
  expect(getCombinedStatus([slice(1, "Ada", true), slice(2, "Bo", true)], null, NOW)).toEqual({
    kind: "both-asleep",
    firstWake: null,
  });
});

test("both awake → both-awake", () => {
  expect(getCombinedStatus([slice(1, "Ada", false), slice(2, "Bo", false)], null, NOW)).toEqual({
    kind: "both-awake",
  });
});

test("mixed → names the asleep and awake child", () => {
  expect(getCombinedStatus([slice(1, "Ada", false), slice(2, "Bo", true)], null, NOW)).toEqual({
    kind: "mixed",
    asleepName: "Bo",
    awakeName: "Ada",
  });
});

test("not exactly two children → null (one, or a defensive third)", () => {
  expect(getCombinedStatus([slice(1, "Ada", true)], null, NOW)).toBeNull();
  expect(getCombinedStatus([], null, NOW)).toBeNull();
  expect(
    getCombinedStatus([slice(1, "Ada", true), slice(2, "Bo", true), slice(3, "Cy", true)], null, NOW),
  ).toBeNull();
});

test("a stale (forgotten) sleep suppresses the line so it can't contradict the lane", () => {
  const stale: FamilySleepView = {
    baby: { id: 1, name: "Ada" },
    activeSleep: null, // server hides the stale open sleep from activeSleep
    staleActiveSleep: { foo: 1 },
    prediction: { expectedNapEnd: null, expectedNightEnd: null },
  };
  expect(getCombinedStatus([stale, slice(2, "Bo", true)], null, NOW)).toBeNull();
});

test("overdue first wake → negative inMs (component renders 'når som helst')", () => {
  expect(
    getCombinedStatus([slice(1, "Ada", true), slice(2, "Bo", true)], wake("Ada", "2026-06-14T09:50:00.000Z"), NOW),
  ).toEqual({ kind: "both-asleep", firstWake: { name: "Ada", inMs: -10 * 60_000 } });
});
