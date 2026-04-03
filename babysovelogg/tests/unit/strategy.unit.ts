import { describe, it, expect } from "bun:test";
import { selectStrategy, type Strategy } from "$lib/engine/strategy.js";
import { computeStrategySignals, type StrategySignals } from "$lib/engine/features.js";
import { predictNewborn } from "$lib/engine/newborn.js";
import type { SleepEntry } from "$lib/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function signals(overrides: Partial<StrategySignals> = {}): StrategySignals {
  return {
    ageMonths: 3,
    ageWeeks: 12,
    daysOfUsableData: 10,
    completeDays: 8,
    nightDayRatio: 0.5,
    longestStretchConsistency: 40,
    firstNapConsistency: 35,
    napCountSD: 1.2,
    wakeWindowSD: 20,
    loggingCompleteness: 0.8,
    ...overrides,
  };
}

function sleep(start: string, end: string, type: "nap" | "night" = "nap"): SleepEntry {
  return { start_time: start, end_time: end, type };
}

/** Generate a day of newborn-style sleep: many short episodes. */
function newbornDay(dateStr: string): SleepEntry[] {
  return [
    sleep(`${dateStr}T01:00:00Z`, `${dateStr}T03:30:00Z`, "night"),
    sleep(`${dateStr}T04:15:00Z`, `${dateStr}T06:00:00Z`, "nap"),
    sleep(`${dateStr}T07:00:00Z`, `${dateStr}T08:30:00Z`, "nap"),
    sleep(`${dateStr}T09:30:00Z`, `${dateStr}T11:00:00Z`, "nap"),
    sleep(`${dateStr}T12:00:00Z`, `${dateStr}T13:15:00Z`, "nap"),
    sleep(`${dateStr}T14:30:00Z`, `${dateStr}T15:45:00Z`, "nap"),
    sleep(`${dateStr}T17:00:00Z`, `${dateStr}T18:30:00Z`, "nap"),
    sleep(`${dateStr}T20:00:00Z`, `${dateStr}T23:00:00Z`, "night"),
  ];
}

/** Generate a day of schedule-mode sleep: 2 naps + night. */
function scheduleDay(dateStr: string): SleepEntry[] {
  return [
    sleep(`${dateStr}T06:00:00Z`, `${dateStr}T06:30:00Z`, "night"), // night end
    sleep(`${dateStr}T09:30:00Z`, `${dateStr}T11:00:00Z`, "nap"),
    sleep(`${dateStr}T14:00:00Z`, `${dateStr}T15:30:00Z`, "nap"),
    sleep(`${dateStr}T19:30:00Z`, `${dateStr}T23:59:00Z`, "night"),
  ];
}

// ─── Strategy selection ───────────────────────────────────────────────────────

describe("selectStrategy", () => {
  const cases: [string, Partial<StrategySignals>, Strategy][] = [
    ["newborn at 3 weeks", { ageWeeks: 3, ageMonths: 0 }, "newborn_guidance"],
    ["newborn at 5 weeks", { ageWeeks: 5, ageMonths: 1 }, "newborn_guidance"],
    ["emerging at 8 weeks (default)", { ageWeeks: 8, ageMonths: 2 }, "emerging_rhythm"],
    ["emerging at 4 months", { ageWeeks: 16, ageMonths: 4 }, "emerging_rhythm"],
    [
      "routine at 6 months with good data",
      { ageWeeks: 26, ageMonths: 6, completeDays: 10, nightDayRatio: 0.6 },
      "routine_schedule",
    ],
    [
      "routine demoted to emerging with poor data",
      { ageWeeks: 26, ageMonths: 6, completeDays: 3, nightDayRatio: 0.6 },
      "emerging_rhythm",
    ],
    [
      "early promotion at 11 weeks with consistent data",
      { ageWeeks: 11, ageMonths: 2, nightDayRatio: 0.65, firstNapConsistency: 20, completeDays: 6 },
      "routine_schedule",
    ],
    [
      "no early promotion without consistent first nap",
      { ageWeeks: 11, ageMonths: 2, nightDayRatio: 0.65, firstNapConsistency: 45, completeDays: 6 },
      "emerging_rhythm",
    ],
  ];

  for (const [label, overrides, expected] of cases) {
    it(label, () => {
      expect(selectStrategy(signals(overrides))).toBe(expected);
    });
  }
});

// ─── Signal computation ───────────────────────────────────────────────────────

describe("computeStrategySignals", () => {
  it("computes correct age for a 2-week-old", () => {
    const birthdate = "2026-03-20";
    const now = new Date("2026-04-03T12:00:00Z").getTime();
    const result = computeStrategySignals([], birthdate, "UTC", now);
    expect(result.ageWeeks).toBe(2);
    expect(result.ageMonths).toBe(0);
  });

  it("returns zero/infinity defaults for empty data", () => {
    const result = computeStrategySignals([], "2026-01-01", "UTC");
    expect(result.daysOfUsableData).toBe(0);
    expect(result.completeDays).toBe(0);
    expect(result.loggingCompleteness).toBe(0);
  });

  it("computes night-day ratio from newborn data", () => {
    const sleeps = newbornDay("2026-03-25");
    const result = computeStrategySignals(sleeps, "2026-03-01", "UTC",
      new Date("2026-03-26T12:00:00Z").getTime());

    // Newborn: lots of sleep spread across 24h, but nights do exist
    expect(result.nightDayRatio).toBeGreaterThan(0.3);
    expect(result.nightDayRatio).toBeLessThan(0.8);
  });

  it("computes high night-day ratio from schedule data", () => {
    const sleeps = [
      ...scheduleDay("2026-03-24"),
      ...scheduleDay("2026-03-25"),
    ];
    const result = computeStrategySignals(sleeps, "2025-06-01", "UTC",
      new Date("2026-03-26T12:00:00Z").getTime());

    expect(result.nightDayRatio).toBeGreaterThan(0.5);
  });

  it("computes logging completeness", () => {
    // 3 days of data over 5 calendar days
    const sleeps = [
      ...newbornDay("2026-03-21"),
      ...newbornDay("2026-03-23"),
      ...newbornDay("2026-03-25"),
    ];
    const result = computeStrategySignals(sleeps, "2026-03-01", "UTC",
      new Date("2026-03-26T12:00:00Z").getTime());

    expect(result.daysOfUsableData).toBe(3);
    expect(result.loggingCompleteness).toBe(3 / 5);
  });
});

// ─── Newborn engine ───────────────────────────────────────────────────────────

describe("predictNewborn", () => {
  const recentSleeps = [
    ...newbornDay("2026-03-24"),
    ...newbornDay("2026-03-25"),
  ];

  it("returns sleep window after last sleep end", () => {
    const lastSleepEndMs = new Date("2026-03-25T23:00:00Z").getTime();
    const now = new Date("2026-03-25T23:30:00Z").getTime();

    const result = predictNewborn({
      ageMonths: 0,
      tz: "UTC",
      recentSleeps,
      lastSleepEndMs,
      now,
    });

    expect(result.strategy).toBe("newborn_guidance");
    const earliest = new Date(result.sleepWindow.earliest).getTime();
    const latest = new Date(result.sleepWindow.latest).getTime();

    // Earliest should be after last sleep end
    expect(earliest).toBeGreaterThan(lastSleepEndMs);
    // Latest should be after earliest
    expect(latest).toBeGreaterThan(earliest);
    // Window shouldn't be absurdly wide (< 2 hours)
    expect((latest - earliest) / 60_000).toBeLessThan(120);
  });

  it("returns sleep pressure based on awake time", () => {
    const lastSleepEndMs = new Date("2026-03-25T23:00:00Z").getTime();

    // Just woke up — low pressure
    const low = predictNewborn({
      ageMonths: 0, tz: "UTC", recentSleeps,
      lastSleepEndMs,
      now: lastSleepEndMs + 10 * 60_000, // 10 min awake
    });
    expect(low.sleepPressure).toBe("low");

    // Been awake 60 min — high pressure for a newborn
    const high = predictNewborn({
      ageMonths: 0, tz: "UTC", recentSleeps,
      lastSleepEndMs,
      now: lastSleepEndMs + 60 * 60_000,
    });
    expect(high.sleepPressure).toBe("high");
  });

  it("returns 24h rolling sleep stats", () => {
    const now = new Date("2026-03-26T00:00:00Z").getTime();
    const result = predictNewborn({
      ageMonths: 0, tz: "UTC", recentSleeps,
      lastSleepEndMs: new Date("2026-03-25T23:00:00Z").getTime(),
      now,
    });

    // Should have counted sleep from the last 24h
    expect(result.rolling.totalSleep24h).toBeGreaterThan(0);
    expect(result.rolling.episodeCount).toBeGreaterThan(0);
    expect(result.rolling.longestStretch).toBeGreaterThan(0);
  });

  it("returns age norms", () => {
    const result = predictNewborn({
      ageMonths: 0, tz: "UTC", recentSleeps,
      lastSleepEndMs: new Date("2026-03-25T23:00:00Z").getTime(),
      now: new Date("2026-03-26T00:00:00Z").getTime(),
    });

    // 0-1 month: 14-18 hours typical
    expect(result.ageNorms.totalSleepHours.min).toBe(14);
    expect(result.ageNorms.totalSleepHours.max).toBe(18);
  });

  it("handles no prior sleep data gracefully", () => {
    const result = predictNewborn({
      ageMonths: 0, tz: "UTC", recentSleeps: [],
      lastSleepEndMs: null,
      now: Date.now(),
    });

    expect(result.strategy).toBe("newborn_guidance");
    expect(result.sleepPressure).toBe("rising");
    expect(result.rolling.totalSleep24h).toBe(0);
  });
});

// ─── Integration: strategy flows through assembleState ────────────────────────

describe("strategy integration", () => {
  it("9-month baby with data gets routine_schedule", () => {
    const sleeps = [
      ...scheduleDay("2026-03-20"),
      ...scheduleDay("2026-03-21"),
      ...scheduleDay("2026-03-22"),
      ...scheduleDay("2026-03-23"),
      ...scheduleDay("2026-03-24"),
      ...scheduleDay("2026-03-25"),
      ...scheduleDay("2026-03-26"),
    ];
    const s9mo = computeStrategySignals(sleeps, "2025-06-01", "UTC",
      new Date("2026-03-27T12:00:00Z").getTime());

    expect(selectStrategy(s9mo)).toBe("routine_schedule");
  });

  it("2-week baby always gets newborn_guidance", () => {
    const s2wk = computeStrategySignals([], "2026-03-17", "UTC",
      new Date("2026-04-01T12:00:00Z").getTime());

    expect(selectStrategy(s2wk)).toBe("newborn_guidance");
  });

  it("3-month baby with sparse data gets emerging_rhythm", () => {
    const sleeps = newbornDay("2026-03-25");
    const s3mo = computeStrategySignals(sleeps, "2026-01-01", "UTC",
      new Date("2026-04-01T12:00:00Z").getTime());

    expect(selectStrategy(s3mo)).toBe("emerging_rhythm");
  });
});
