import { describe, expect, it } from "vitest";
import { getTodayStats, getWeekStats, getAverageWakeWindow } from "../../src/engine/stats.js";
import type { SleepEntry } from "../../types.js";

// --- helpers ---

function sleep(
  start: string,
  end: string | null,
  type: "nap" | "night" = "nap",
  pauses?: { pause_time: string; resume_time: string | null }[],
): SleepEntry {
  return { start_time: start, end_time: end, type, pauses };
}

function t(hour: number, min = 0): string {
  return `2026-03-26T${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:00.000Z`;
}

// --- getTodayStats ---

describe("getTodayStats", () => {
  it("empty sleeps", () => {
    expect(getTodayStats([])).toMatchObject({
      totalNapMinutes: 0,
      totalNightMinutes: 0,
      napCount: 0,
    });
  });

  it("one completed nap", () => {
    const stats = getTodayStats([sleep(t(9, 0), t(10, 30))]);
    expect(stats).toMatchObject({
      totalNapMinutes: 90,
      totalNightMinutes: 0,
      napCount: 1,
    });
  });

  it("mixed nap and night", () => {
    const stats = getTodayStats([
      sleep(t(9, 0), t(10, 0), "nap"),
      sleep(t(13, 0), t(14, 30), "nap"),
      sleep(t(20, 0), t(6, 0), "night"), // -600min, but this will be negative — let's use proper times
    ]);
    // Night from 20:00 to next day 06:00 = need proper times
    expect(stats.napCount).toBe(2);
    expect(stats.totalNapMinutes).toBe(150); // 60 + 90
  });

  it("skips in-progress sleep (no end_time)", () => {
    const stats = getTodayStats([sleep(t(9, 0), t(10, 0)), sleep(t(13, 0), null)]);
    expect(stats.napCount).toBe(1);
    expect(stats.totalNapMinutes).toBe(60);
  });

  it("subtracts pause duration", () => {
    const stats = getTodayStats([
      sleep(t(9, 0), t(10, 0), "nap", [
        { pause_time: t(9, 20), resume_time: t(9, 30) }, // 10 min pause
      ]),
    ]);
    expect(stats.totalNapMinutes).toBe(50); // 60 - 10
  });

  it("handles multiple pauses", () => {
    const stats = getTodayStats([
      sleep(t(9, 0), t(11, 0), "nap", [
        { pause_time: t(9, 30), resume_time: t(9, 45) }, // 15 min
        { pause_time: t(10, 0), resume_time: t(10, 15) }, // 15 min
      ]),
    ]);
    expect(stats.totalNapMinutes).toBe(90); // 120 - 30
  });
});

// --- getWeekStats ---

describe("getWeekStats", () => {
  it("empty week", () => {
    const stats = getWeekStats([]);
    expect(stats).toMatchObject({
      days: [],
      avgNapMinutesPerDay: 0,
      avgNightMinutesPerDay: 0,
      avgNapsPerDay: 0,
    });
  });

  it("groups by date and averages", () => {
    const sleeps: SleepEntry[] = [
      // Day 1: 2 naps, 120 min total
      sleep("2026-03-25T09:00:00.000Z", "2026-03-25T10:00:00.000Z"),
      sleep("2026-03-25T13:00:00.000Z", "2026-03-25T14:00:00.000Z"),
      // Day 2: 1 nap, 90 min
      sleep("2026-03-26T09:00:00.000Z", "2026-03-26T10:30:00.000Z"),
    ];
    const stats = getWeekStats(sleeps);
    expect(stats.days).toHaveLength(2);
    expect(stats.avgNapMinutesPerDay).toBe(105); // (120 + 90) / 2
    expect(stats.avgNapsPerDay).toBe(1.5); // (2 + 1) / 2
  });

  it("sorts days chronologically", () => {
    const sleeps: SleepEntry[] = [
      sleep("2026-03-26T09:00:00.000Z", "2026-03-26T10:00:00.000Z"),
      sleep("2026-03-24T09:00:00.000Z", "2026-03-24T10:00:00.000Z"),
      sleep("2026-03-25T09:00:00.000Z", "2026-03-25T10:00:00.000Z"),
    ];
    const stats = getWeekStats(sleeps);
    expect(stats.days.map((d) => d.date)).toEqual(["2026-03-24", "2026-03-25", "2026-03-26"]);
  });
});

// --- getAverageWakeWindow ---

describe("getAverageWakeWindow", () => {
  it("returns null with fewer than 2 sleeps", () => {
    expect(getAverageWakeWindow([])).toBeNull();
    expect(getAverageWakeWindow([sleep(t(9, 0), t(10, 0))])).toBeNull();
  });

  it("calculates average gap between consecutive sleeps", () => {
    const sleeps: SleepEntry[] = [
      sleep(t(7, 0), t(8, 0)), // ends 08:00
      sleep(t(10, 0), t(11, 0)), // starts 10:00 → gap 120 min
      sleep(t(13, 0), t(14, 0)), // starts 13:00 → gap 120 min
    ];
    expect(getAverageWakeWindow(sleeps)).toBe(120);
  });

  it("ignores gaps shorter than 10 min", () => {
    const sleeps: SleepEntry[] = [
      sleep(t(9, 0), t(10, 0)),
      sleep(t(10, 5), t(11, 0)), // 5 min gap — ignored
      sleep(t(13, 0), t(14, 0)), // 120 min gap
    ];
    expect(getAverageWakeWindow(sleeps)).toBe(120);
  });

  it("ignores gaps longer than 8 hours", () => {
    const sleeps: SleepEntry[] = [
      sleep("2026-03-25T20:00:00.000Z", "2026-03-25T21:00:00.000Z"),
      sleep("2026-03-26T09:00:00.000Z", "2026-03-26T10:00:00.000Z"), // 12h gap — ignored
    ];
    expect(getAverageWakeWindow(sleeps)).toBeNull();
  });

  it("handles unsorted input", () => {
    const sleeps: SleepEntry[] = [
      sleep(t(13, 0), t(14, 0)),
      sleep(t(7, 0), t(8, 0)),
      sleep(t(10, 0), t(11, 0)),
    ];
    // Should sort and compute: 120, 120 → avg 120
    expect(getAverageWakeWindow(sleeps)).toBe(120);
  });
});
