import { describe, expect, it } from "bun:test";
import { buildTwinArcProps } from "$lib/arc-props.js";
import type { BabyState } from "$lib/stores/app.svelte.js";

// Minimal BabyState — buildArcProps reads baby, activeSleep, todaySleeps,
// prediction, todayWakeUp, todayNightWakings, priorOvernightSleep.
const make = (over: Partial<BabyState>): BabyState =>
  ({
    baby: { id: 1, name: "A", timezone: "Europe/Oslo" },
    todayWakeUp: null,
    todaySleeps: [],
    activeSleep: null,
    prediction: null,
    todayNightWakings: [],
    priorOvernightSleep: null,
    ...over,
  }) as BabyState;

const baby = (id: number, name: string) =>
  ({ id, name, timezone: "Europe/Oslo" }) as BabyState["baby"];
const wake = (t: string) => ({ wake_time: t }) as BabyState["todayWakeUp"];
const openNight = { start_time: "2026-06-14T20:00:00Z", type: "night", end_time: null } as BabyState["activeSleep"];

const NOW = Date.UTC(2026, 5, 14, 10, 0, 0); // 12:00 Oslo

describe("buildTwinArcProps", () => {
  it("shares a domain when both babies are in day mode", () => {
    const a = make({ baby: baby(1, "A"), todayWakeUp: wake("2026-06-14T05:00:00Z") }); // 07:00 Oslo
    const b = make({ baby: baby(2, "B"), todayWakeUp: wake("2026-06-14T05:30:00Z") }); // 07:30 Oslo
    const r = buildTwinArcProps(a, b, NOW);
    expect(r.shared).toBe(true);
    if (r.shared) {
      expect(r.a.isNightMode).toBe(false);
      expect(r.b.isNightMode).toBe(false);
      // Union start = earliest wake (07:00), not the later 07:30.
      expect(r.config.arcStartHour).toBeCloseTo(7, 5);
      expect(r.config.tz).toBe("Europe/Oslo");
    }
  });

  it("falls back to separate when the two babies are in different modes", () => {
    const a = make({ baby: baby(1, "A"), activeSleep: openNight }); // night
    const b = make({ baby: baby(2, "B"), todayWakeUp: wake("2026-06-14T05:30:00Z") }); // day
    expect(buildTwinArcProps(a, b, NOW).shared).toBe(false);
  });

  it("returns separate when a baby slice is missing data", () => {
    const a = make({ baby: null });
    const b = make({ baby: baby(2, "B") });
    expect(buildTwinArcProps(a, b, NOW).shared).toBe(false);
  });
});
