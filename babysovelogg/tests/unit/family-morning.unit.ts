import { describe, expect, it } from "bun:test";
import { babyNeedsMorningWake } from "$lib/family-morning.js";
import type { BabyState } from "$lib/stores/app.svelte.js";

// Minimal BabyState shape — babyNeedsMorningWake only reads baby, todayWakeUp,
// todaySleeps, activeSleep.
const make = (over: Partial<BabyState>): BabyState =>
  ({
    baby: { id: 1, name: "Ada" },
    todayWakeUp: null,
    todaySleeps: [],
    activeSleep: null,
    ...over,
  }) as BabyState;

const wake = (wake_time: string | null) => ({ wake_time }) as BabyState["todayWakeUp"];
const openSleep = { end_time: null } as BabyState["activeSleep"];
const doneSleep = { end_time: "2026-06-14T10:30:00Z" } as BabyState["activeSleep"];
const aNap = { type: "nap" } as BabyState["todaySleeps"][number];

describe("babyNeedsMorningWake", () => {
  const cases: Array<[string, BabyState, boolean]> = [
    ["fresh day: no wake, no sleeps, no session", make({}), true],
    ["real wake logged", make({ todayWakeUp: wake("2026-06-14T07:00:00Z") }), false],
    ["marker-only off-day row (wake_time null) still needs a wake", make({ todayWakeUp: wake(null) }), true],
    ["mid-night-sleep (open session)", make({ activeSleep: openSleep }), false],
    ["nap already logged today", make({ todaySleeps: [aNap] }), false],
    ["a completed session today (day under way)", make({ activeSleep: doneSleep, todaySleeps: [aNap] }), false],
    ["no baby in this slice", make({ baby: null }), false],
  ];

  for (const [name, state, expected] of cases) {
    it(name, () => {
      expect(babyNeedsMorningWake(state)).toBe(expected);
    });
  }
});
