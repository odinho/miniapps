import { describe, it, expect } from "bun:test";
import { computeSharedSleepByDay, avgSharedSleepPerDay } from "$lib/stats/shared-sleep.js";
import type { SleepEntry } from "$lib/types.js";

const NOW = new Date("2026-03-25T12:00:00.000Z").getTime();
const sleep = (start: string, end: string, type: "nap" | "night" = "night"): SleepEntry => ({
  start_time: start,
  end_time: end,
  type,
});

describe("computeSharedSleepByDay", () => {
  it("counts the both-asleep window and splits it across local midnight", () => {
    const a = [sleep("2026-03-20T22:00:00.000Z", "2026-03-21T06:00:00.000Z")];
    const b = [sleep("2026-03-20T23:00:00.000Z", "2026-03-21T05:00:00.000Z")];
    // Overlap 23:00→05:00 = 6h, split: 60 min on the 20th, 300 min on the 21st.
    expect(computeSharedSleepByDay(a, b, "UTC", NOW)).toEqual([
      { date: "2026-03-20", minutes: 60 },
      { date: "2026-03-21", minutes: 300 },
    ]);
  });

  it("returns nothing when the children are never asleep together", () => {
    const a = [sleep("2026-03-20T10:00:00.000Z", "2026-03-20T11:00:00.000Z", "nap")];
    const b = [sleep("2026-03-20T11:30:00.000Z", "2026-03-20T12:30:00.000Z", "nap")];
    expect(computeSharedSleepByDay(a, b, "UTC", NOW)).toEqual([]);
  });

  it("intersects overlapping naps on the same day", () => {
    const a = [sleep("2026-03-20T09:00:00.000Z", "2026-03-20T10:30:00.000Z", "nap")];
    const b = [sleep("2026-03-20T10:00:00.000Z", "2026-03-20T11:00:00.000Z", "nap")];
    // Overlap 10:00→10:30 = 30 min.
    expect(computeSharedSleepByDay(a, b, "UTC", NOW)).toEqual([{ date: "2026-03-20", minutes: 30 }]);
  });

  it("splits at the real local midnight across a DST spring-forward (23h day)", () => {
    // Europe/Oslo springs forward 2026-03-29 02:00 → that day is 23h long.
    // An overlap from 03-29 01:00 (UTC+1 = 00:00Z) to 03-30 01:00 (UTC+2 = 23:00Z)
    // must split at the TRUE 03-30 midnight (22:00Z): 22h on the 29th, 1h on the
    // 30th — not 23h dumped on the 29th (the old 1440-min assumption).
    const a = [sleep("2026-03-29T00:00:00.000Z", "2026-03-29T23:00:00.000Z")];
    const b = [sleep("2026-03-29T00:00:00.000Z", "2026-03-29T23:00:00.000Z")];
    expect(computeSharedSleepByDay(a, b, "Europe/Oslo", new Date("2026-04-05T12:00:00.000Z").getTime())).toEqual([
      { date: "2026-03-29", minutes: 1320 },
      { date: "2026-03-30", minutes: 60 },
    ]);
  });

  it("excludes today (incomplete)", () => {
    const a = [sleep("2026-03-25T01:00:00.000Z", "2026-03-25T03:00:00.000Z")];
    const b = [sleep("2026-03-25T01:00:00.000Z", "2026-03-25T03:00:00.000Z")];
    expect(computeSharedSleepByDay(a, b, "UTC", NOW)).toEqual([]);
  });
});

describe("avgSharedSleepPerDay", () => {
  it("averages over the days present", () => {
    expect(avgSharedSleepPerDay([{ date: "a", minutes: 60 }, { date: "b", minutes: 300 }])).toBe(180);
    expect(avgSharedSleepPerDay([])).toBe(0);
  });
});
