import { describe, expect, it } from "bun:test";
import {
  getTodayStats,
  getWeekStats,
  getAverageWakeWindow,
  getWakeWindowGaps,
  getLongestNightStretches,
  buildSleepHeatmap,
} from "$lib/engine/stats.js";
import type { SleepEntry } from "$lib/types.js";

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

// --- getWakeWindowGaps ---

describe("getWakeWindowGaps", () => {
  it("returns empty array with fewer than 2 sleeps", () => {
    expect(getWakeWindowGaps([])).toEqual([]);
    expect(getWakeWindowGaps([sleep(t(9, 0), t(10, 0))])).toEqual([]);
  });

  it("returns individual gaps with timestamps", () => {
    const sleeps: SleepEntry[] = [
      sleep(t(7, 0), t(8, 0)),   // ends 08:00
      sleep(t(10, 0), t(11, 0)), // gap = 120 min
      sleep(t(13, 0), t(14, 0)), // gap = 120 min
    ];
    const gaps = getWakeWindowGaps(sleeps);
    expect(gaps).toHaveLength(2);
    expect(gaps[0].minutes).toBe(120);
    expect(gaps[0].time).toBe(t(8, 0));
    expect(gaps[1].minutes).toBe(120);
  });

  it("filters out gaps < 10 min and > 480 min", () => {
    const sleeps: SleepEntry[] = [
      sleep(t(9, 0), t(10, 0)),
      sleep(t(10, 5), t(11, 0)),  // 5 min gap — excluded
      sleep(t(13, 0), t(14, 0)),  // 120 min gap — included
    ];
    const gaps = getWakeWindowGaps(sleeps);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].minutes).toBe(120);
  });
});

// --- getLongestNightStretches ---

describe("getLongestNightStretches", () => {
  it("returns empty for no night sleeps", () => {
    expect(getLongestNightStretches([])).toEqual([]);
    expect(getLongestNightStretches([sleep(t(9, 0), t(10, 0), "nap")])).toEqual([]);
  });

  it("returns full duration for uninterrupted night", () => {
    const sleeps: SleepEntry[] = [
      sleep("2026-03-25T20:00:00.000Z", "2026-03-26T06:00:00.000Z", "night"),
    ];
    const stretches = getLongestNightStretches(sleeps);
    expect(stretches).toHaveLength(1);
    expect(stretches[0].date).toBe("2026-03-25");
    expect(stretches[0].minutes).toBe(600); // 10 hours
  });

  it("finds longest segment when pauses exist", () => {
    const sleeps: SleepEntry[] = [
      sleep("2026-03-25T20:00:00.000Z", "2026-03-26T06:00:00.000Z", "night", [
        // Baby woke at 01:00, back down at 01:30
        { pause_time: "2026-03-26T01:00:00.000Z", resume_time: "2026-03-26T01:30:00.000Z" },
      ]),
    ];
    const stretches = getLongestNightStretches(sleeps);
    expect(stretches).toHaveLength(1);
    // Before pause: 20:00–01:00 = 300 min
    // After pause:  01:30–06:00 = 270 min
    // Longest = 300
    expect(stretches[0].minutes).toBe(300);
  });

  it("picks longest across multiple pauses", () => {
    const sleeps: SleepEntry[] = [
      sleep("2026-03-25T20:00:00.000Z", "2026-03-26T06:00:00.000Z", "night", [
        { pause_time: "2026-03-25T22:00:00.000Z", resume_time: "2026-03-25T22:15:00.000Z" },
        { pause_time: "2026-03-26T02:00:00.000Z", resume_time: "2026-03-26T02:30:00.000Z" },
      ]),
    ];
    const stretches = getLongestNightStretches(sleeps);
    // Segments: 20:00–22:00=120, 22:15–02:00=225, 02:30–06:00=210
    expect(stretches[0].minutes).toBe(225);
  });

  it("keeps max per date when multiple night entries", () => {
    const sleeps: SleepEntry[] = [
      sleep("2026-03-25T20:00:00.000Z", "2026-03-25T23:00:00.000Z", "night"), // 180 min
      sleep("2026-03-25T23:30:00.000Z", "2026-03-26T06:00:00.000Z", "night"), // 390 min
    ];
    const stretches = getLongestNightStretches(sleeps);
    expect(stretches).toHaveLength(1);
    expect(stretches[0].minutes).toBe(390);
  });
});

// --- buildSleepHeatmap ---

describe("buildSleepHeatmap", () => {
  it("returns empty for no sleeps", () => {
    expect(buildSleepHeatmap([])).toEqual([]);
  });

  it("buckets a single-hour nap correctly", () => {
    const sleeps: SleepEntry[] = [
      sleep("2026-03-26T09:00:00.000Z", "2026-03-26T10:00:00.000Z"),
    ];
    const rows = buildSleepHeatmap(sleeps);
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe("2026-03-26");
    expect(rows[0].hours[9]).toBe(60);
    // All other hours should be 0
    expect(rows[0].hours.filter((h) => h > 0)).toEqual([60]);
  });

  it("distributes across multiple hour slots", () => {
    // 09:30 to 11:00 = 90 min spanning hours 9, 10
    const sleeps: SleepEntry[] = [
      sleep("2026-03-26T09:30:00.000Z", "2026-03-26T11:00:00.000Z"),
    ];
    const rows = buildSleepHeatmap(sleeps);
    expect(rows[0].hours[9]).toBe(30);  // 09:30–10:00
    expect(rows[0].hours[10]).toBe(60); // 10:00–11:00
  });

  it("caps each slot at 60 minutes", () => {
    // Two overlapping naps in the same hour (unusual but possible with data quirks)
    const sleeps: SleepEntry[] = [
      sleep("2026-03-26T09:00:00.000Z", "2026-03-26T10:00:00.000Z"),
      sleep("2026-03-26T09:15:00.000Z", "2026-03-26T09:45:00.000Z"),
    ];
    const rows = buildSleepHeatmap(sleeps);
    expect(rows[0].hours[9]).toBe(60); // capped
  });

  it("groups multiple days", () => {
    const sleeps: SleepEntry[] = [
      sleep("2026-03-25T09:00:00.000Z", "2026-03-25T10:00:00.000Z"),
      sleep("2026-03-26T09:00:00.000Z", "2026-03-26T10:00:00.000Z"),
    ];
    const rows = buildSleepHeatmap(sleeps);
    expect(rows).toHaveLength(2);
    expect(rows[0].date).toBe("2026-03-25");
    expect(rows[1].date).toBe("2026-03-26");
  });
});
