import { test, expect } from "bun:test";
import { computeFamilyStatus, expectedWakeFor, type FamilySleepView } from "../../src/lib/family.js";

const baby = (id: number, name: string): { id: number; name: string } => ({ id, name });

const asleep = (
  id: number,
  name: string,
  type: "nap" | "night",
  prediction: FamilySleepView["prediction"],
): FamilySleepView => ({
  baby: baby(id, name),
  activeSleep: { type, end_time: null },
  prediction,
});

const awake = (id: number, name: string): FamilySleepView => ({
  baby: baby(id, name),
  activeSleep: null,
  prediction: { expectedNapEnd: null, expectedNightEnd: null },
});

test("expectedWakeFor: nap-cap and rescue win over the natural nap end; night uses night-end", () => {
  const napNatural = asleep(1, "Ada", "nap", { expectedNapEnd: "2026-06-14T11:00:00.000Z", expectedNightEnd: null });
  const napCapped = asleep(1, "Ada", "nap", {
    expectedNapEnd: "2026-06-14T11:00:00.000Z",
    expectedNightEnd: null,
    napBudget: { wakeBy: "2026-06-14T10:30:00.000Z" },
  });
  const napRescue = asleep(1, "Ada", "nap", {
    expectedNapEnd: "2026-06-14T11:00:00.000Z",
    expectedNightEnd: null,
    rescueNap: { recommendedWakeTime: "2026-06-14T10:15:00.000Z" },
  });
  const night = asleep(2, "Bo", "night", { expectedNapEnd: null, expectedNightEnd: "2026-06-14T06:30:00.000Z" });

  expect([
    expectedWakeFor(napNatural),
    expectedWakeFor(napCapped),
    expectedWakeFor(napRescue),
    expectedWakeFor(night),
    expectedWakeFor(awake(3, "Cy")),
  ]).toEqual([
    "2026-06-14T11:00:00.000Z",
    "2026-06-14T10:30:00.000Z",
    "2026-06-14T10:15:00.000Z",
    "2026-06-14T06:30:00.000Z",
    null,
  ]);
});

test("computeFamilyStatus: bothAsleep needs two down; firstWake is the soonest", () => {
  const ada = asleep(1, "Ada", "nap", { expectedNapEnd: "2026-06-14T11:00:00.000Z", expectedNightEnd: null });
  const bo = asleep(2, "Bo", "nap", { expectedNapEnd: "2026-06-14T10:20:00.000Z", expectedNightEnd: null });

  expect(computeFamilyStatus([ada, bo])).toEqual({
    bothAsleep: true,
    firstWake: { babyId: 2, name: "Bo", at: "2026-06-14T10:20:00.000Z" },
  });

  expect(computeFamilyStatus([ada, awake(2, "Bo")])).toEqual({
    bothAsleep: false,
    firstWake: { babyId: 1, name: "Ada", at: "2026-06-14T11:00:00.000Z" },
  });

  expect(computeFamilyStatus([awake(1, "Ada"), awake(2, "Bo")])).toEqual({
    bothAsleep: false,
    firstWake: null,
  });

  expect(computeFamilyStatus([ada])).toEqual({
    bothAsleep: false,
    firstWake: { babyId: 1, name: "Ada", at: "2026-06-14T11:00:00.000Z" },
  });
});

test("computeFamilyStatus: an asleep baby with no predicted wake doesn't crash firstWake", () => {
  const adaUnknown = asleep(1, "Ada", "nap", { expectedNapEnd: null, expectedNightEnd: null });
  const bo = asleep(2, "Bo", "night", { expectedNapEnd: null, expectedNightEnd: "2026-06-14T06:30:00.000Z" });

  expect(computeFamilyStatus([adaUnknown, bo])).toEqual({
    bothAsleep: true,
    firstWake: { babyId: 2, name: "Bo", at: "2026-06-14T06:30:00.000Z" },
  });
});
