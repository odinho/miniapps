import { describe, expect, it } from "bun:test";
import {
  calculateAgeMonths,
  getWakeWindow,
  getLearnedNapDuration,
  predictNextNap,
  getExpectedNapCount,
  predictDayNaps,
  recommendBedtime,
  detectNapTransition,
  findByAge,
  WAKE_WINDOWS,
  NAP_COUNTS,
  SLEEP_NEEDS,
} from "$lib/engine/schedule.js";
import type { SleepEntry, BabyContext } from "$lib/types.js";

// --- helpers ---

/** Make a completed sleep entry. Times are ISO strings. */
function sleep(start: string, end: string, type: "nap" | "night" = "nap"): SleepEntry {
  return { start_time: start, end_time: end, type };
}

/** Make an ISO timestamp for a given hour:minute on 2026-03-26 (UTC). */
function t(hour: number, min = 0): string {
  return `2026-03-26T${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:00.000Z`;
}

/** Build a minimal BabyContext for tests. */
function ctx(ageMonths: number, recentSleeps: SleepEntry[] = [], customNapCount: number | null = null): BabyContext {
  return { birthdate: "2025-06-12", ageMonths, tz: "UTC", customNapCount, recentSleeps };
}

// --- calculateAgeMonths ---

describe("calculateAgeMonths", () => {
  const cases: [string, string, Date, number][] = [
    ["same month", "2026-01-15", new Date("2026-01-20"), 0],
    ["one month", "2026-01-15", new Date("2026-02-20"), 1],
    ["day not reached", "2026-01-20", new Date("2026-02-15"), 0],
    ["exactly one year", "2025-03-26", new Date("2026-03-26"), 12],
    ["9 months", "2025-06-12", new Date("2026-03-26"), 9],
    ["newborn", "2026-03-20", new Date("2026-03-26"), 0],
    ["future birthdate clamps to 0", "2026-04-01", new Date("2026-03-26"), 0],
  ];

  for (const [label, birthdate, now, expected] of cases) {
    it(label, () => {
      expect(calculateAgeMonths(birthdate, now)).toBe(expected);
    });
  }
});

// --- findByAge ---

describe("findByAge", () => {
  it("returns correct bracket for each age", () => {
    expect(findByAge(WAKE_WINDOWS, 0).minMinutes).toBe(30);
    expect(findByAge(WAKE_WINDOWS, 5).minMinutes).toBe(105);
    expect(findByAge(WAKE_WINDOWS, 9).minMinutes).toBe(150);
  });

  it("falls back to last bracket for old babies", () => {
    expect(findByAge(WAKE_WINDOWS, 36).minMinutes).toBe(300);
  });

  it("works for nap counts", () => {
    expect(findByAge(NAP_COUNTS, 2).naps).toBe(4);
    expect(findByAge(NAP_COUNTS, 7).naps).toBe(2);
    expect(findByAge(NAP_COUNTS, 14).naps).toBe(1);
  });

  it("works for sleep needs", () => {
    expect(findByAge(SLEEP_NEEDS, 1).totalHours).toBe(15.5);
    expect(findByAge(SLEEP_NEEDS, 20).totalHours).toBe(13);
  });
});

// --- getWakeWindow ---

describe("getWakeWindow", () => {
  it("returns midpoint for age bracket without recent sleeps", () => {
    expect(getWakeWindow(ctx(0))).toBe(45); // (30+60)/2
    expect(getWakeWindow(ctx(5))).toBe(127.5); // (105+150)/2
    expect(getWakeWindow(ctx(10))).toBe(210); // (180+240)/2
  });

  it("adapts to recent sleep patterns", () => {
    const recentSleeps = [
      sleep(t(7, 0), t(8, 0)),
      sleep(t(10, 0), t(11, 0)),
      sleep(t(13, 0), t(14, 0)),
      sleep(t(19, 0), t(7, 0), "night"), // night entry makes the day complete
    ];
    // Wake windows: 10:00-8:00=120min, 13:00-11:00=120min -> avg 120
    const ww = getWakeWindow(ctx(6, recentSleeps));
    // Should be clamped to [120, 180] range for 6 months -> 120
    expect(ww).toBe(120);
  });

  it("ignores recent sleeps with fewer than 2 entries", () => {
    const ww = getWakeWindow(ctx(6, [sleep(t(7, 0), t(8, 0))]));
    expect(ww).toBe(150); // midpoint, no adaptation
  });
});

// --- getExpectedNapCount ---

describe("getExpectedNapCount", () => {
  it("uses age-based default", () => {
    expect(getExpectedNapCount(2)).toBe(4);
    expect(getExpectedNapCount(7)).toBe(2);
    expect(getExpectedNapCount(14)).toBe(1);
  });

  it("uses custom override when set", () => {
    expect(getExpectedNapCount(7, 3)).toBe(3);
    expect(getExpectedNapCount(14, 2)).toBe(2);
  });

  it("ignores null/undefined custom count", () => {
    expect(getExpectedNapCount(7, null)).toBe(2);
    expect(getExpectedNapCount(7, undefined)).toBe(2);
  });
});

// --- predictNextNap ---

describe("predictNextNap", () => {
  it("predicts based on wake window after last wake time", () => {
    const next = predictNextNap(t(7, 0), ctx(6));
    // 6 months -> ww midpoint 150min -> 07:00 + 2h30m = 09:30
    expect(next).toBe(t(9, 30));
  });
});

// --- predictDayNaps ---

describe("predictDayNaps", () => {
  it("predicts correct number of naps for age", () => {
    const naps = predictDayNaps(t(7, 0), ctx(7));
    expect(naps).toHaveLength(2); // 7 months -> 2 naps
  });

  it("respects custom nap count", () => {
    const naps = predictDayNaps(t(7, 0), ctx(7, [], 3));
    expect(naps).toHaveLength(3);
  });

  it("each nap starts after wake window and has duration", () => {
    const naps = predictDayNaps(t(7, 0), ctx(14)); // 14 months -> 1 nap
    expect(naps).toHaveLength(1);
    const nap = naps[0];
    expect(new Date(nap.startTime).getTime()).toBeGreaterThan(new Date(t(7, 0)).getTime());
    expect(new Date(nap.endTime).getTime()).toBeGreaterThan(new Date(nap.startTime).getTime());
  });
});

// --- recommendBedtime ---

describe("recommendBedtime", () => {
  it("defaults to 19:00 when no completed sleeps", () => {
    const bt = recommendBedtime([], ctx(9));
    expect(new Date(bt).getHours()).toBe(19);
  });

  it("clamps bedtime to no earlier than 16:00", () => {
    const bt = recommendBedtime([sleep(t(6, 0), t(6, 30))], ctx(9));
    const hour = new Date(bt).getHours();
    expect(hour).toBeGreaterThanOrEqual(16);
  });

  it("clamps bedtime to no later than 23:00", () => {
    const bt = recommendBedtime([sleep(t(17, 0), t(18, 0))], ctx(9));
    const d = new Date(bt);
    expect(d.getHours()).toBeLessThanOrEqual(23);
  });
});

// --- detectNapTransition ---

describe("detectNapTransition", () => {
  it("returns null with fewer than 5 days", () => {
    const days = Array.from({ length: 4 }, () => [sleep(t(9, 0), t(10, 0))]);
    expect(detectNapTransition(days)).toBeNull();
  });

  it("detects dropping trend", () => {
    // 4 days of 3 naps, then 3 days of 2 naps
    const days = [
      ...Array.from({ length: 4 }, () => [
        sleep(t(9, 0), t(10, 0)),
        sleep(t(12, 0), t(13, 0)),
        sleep(t(15, 0), t(16, 0)),
      ]),
      ...Array.from({ length: 3 }, () => [sleep(t(9, 0), t(10, 0)), sleep(t(13, 0), t(14, 0))]),
    ];
    const result = detectNapTransition(days);
    expect(result).not.toBeNull();
    expect(result!.dropping).toBe(true);
    expect(result!.suggestedNaps).toBe(2);
  });

  it("reports stable when not dropping", () => {
    const days = Array.from({ length: 7 }, () => [
      sleep(t(9, 0), t(10, 0)),
      sleep(t(13, 0), t(14, 0)),
    ]);
    const result = detectNapTransition(days);
    expect(result).not.toBeNull();
    expect(result!.dropping).toBe(false);
    expect(result!.suggestedNaps).toBe(2);
  });
});

// --- incomplete day filtering ---

/** Make an ISO timestamp on a specific date. */
function day(d: number, hour: number, min = 0): string {
  return `2026-03-${String(d).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:00.000Z`;
}

function renderNaps(naps: { startTime: string; endTime: string }[]): string {
  return naps.map((n) => `${n.startTime.slice(11, 16)}–${n.endTime.slice(11, 16)}`).join(", ");
}

describe("incomplete days (missing night) excluded from learning", () => {
  // Two complete days (day 24, day 25) with 90-min naps and 120-min wake windows.
  // One incomplete day (day 26) with a bogus 180-min "nap" (really a misclassified
  // overnight fragment) and 300-min gaps. Without the filter, the incomplete day
  // would poison wake window, nap duration, and nap count learning.
  const completeDays: SleepEntry[] = [
    // Day 24: 2 naps + night
    sleep(day(24, 9, 0), day(24, 10, 30)),   // nap 90 min
    sleep(day(24, 12, 30), day(24, 14, 0)),   // nap 90 min
    sleep(day(24, 19, 0), day(25, 7, 0), "night"),

    // Day 25: 2 naps + night
    sleep(day(25, 9, 0), day(25, 10, 30)),
    sleep(day(25, 12, 30), day(25, 14, 0)),
    sleep(day(25, 19, 0), day(26, 7, 0), "night"),
  ];

  const incompleteDay: SleepEntry[] = [
    // Day 26: naps only, no night — e.g. parent forgot to log bedtime.
    // Includes a 180-min "nap" that is really an overnight fragment.
    sleep(day(26, 9, 0), day(26, 10, 30)),
    sleep(day(26, 15, 0), day(26, 18, 0)),   // 180-min bogus "nap"
  ];

  it("wake window ignores gaps from incomplete days", () => {
    const withIncomplete = ctx(8, [...completeDays, ...incompleteDay]);
    const withoutIncomplete = ctx(8, completeDays);

    expect(getWakeWindow(withIncomplete)).toBe(getWakeWindow(withoutIncomplete));
  });

  it("nap duration ignores naps from incomplete days", () => {
    const withIncomplete = ctx(8, [...completeDays, ...incompleteDay]);
    const withoutIncomplete = ctx(8, completeDays);

    expect(getLearnedNapDuration(withIncomplete)).toBe(getLearnedNapDuration(withoutIncomplete));
  });

  it("nap predictions are identical with or without incomplete days", () => {
    const withIncomplete = ctx(8, [...completeDays, ...incompleteDay]);
    const withoutIncomplete = ctx(8, completeDays);

    const predsWith = predictDayNaps(day(27, 7, 0), withIncomplete);
    const predsWithout = predictDayNaps(day(27, 7, 0), withoutIncomplete);

    expect(renderNaps(predsWith)).toBe(renderNaps(predsWithout));
  });
});
