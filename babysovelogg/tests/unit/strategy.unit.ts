import { describe, it, expect } from "bun:test";
import { selectStrategy, type Strategy } from "$lib/engine/strategy.js";
import { computeStrategySignals, type StrategySignals } from "$lib/engine/features.js";
import { predictNewborn } from "$lib/engine/newborn.js";
import { predictEmerging } from "$lib/engine/emerging.js";
import type { SleepEntry, BabyContext } from "$lib/types.js";

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

  it("nightDayRatio respects type tag for early bedtimes (Halldis regression)", () => {
    // Halldis-shape: 1-nap 11mo with bedtimes ranging 17:30-18:55. The
    // earlier 18:00 start-hour heuristic dropped ~30% of her nights from
    // the night-window count, sinking nightDayRatio to 0.53 and demoting
    // her to emerging_rhythm even though every sleep was correctly typed.
    // With the type-tag fix, all `type=night` entries count regardless
    // of clock time.
    const sleeps: SleepEntry[] = [];
    for (let d = 1; d <= 14; d++) {
      const day = `2026-03-${String(d).padStart(2, "0")}`;
      // Nap mid-morning
      sleeps.push({
        start_time: `${day}T08:30:00Z`,
        end_time: `${day}T10:00:00Z`,
        type: "nap",
        woke_by: "woken",
      });
      // Night starting before 18:00 — would have failed the old gate.
      sleeps.push({
        start_time: `${day}T15:45:00Z`,
        end_time: `2026-03-${String(d + 1).padStart(2, "0")}T03:00:00Z`,
        type: "night",
        woke_by: "self",
      });
    }
    const result = computeStrategySignals(sleeps, "2025-06-01", "UTC",
      new Date("2026-03-15T12:00:00Z").getTime());
    expect(result.nightDayRatio).toBeGreaterThan(0.55);
  });

  it("nightDayRatio falls back to clock-hour heuristic when type is missing", () => {
    // Defensive: a legacy/imported entry without a type field still gets
    // bucketed by the 18:00-08:00 window. Constructed by casting around
    // SleepEntry's required type — we're simulating data that survived
    // through pre-type schema days.
    const sleeps = [
      {
        start_time: "2026-03-25T19:00:00Z", // 19:00 = night window
        end_time: "2026-03-26T06:00:00Z",
        type: undefined as unknown as "night",
        woke_by: "self" as const,
      },
      {
        start_time: "2026-03-25T10:00:00Z", // 10:00 = day window
        end_time: "2026-03-25T11:30:00Z",
        type: undefined as unknown as "nap",
        woke_by: "self" as const,
      },
    ];
    const result = computeStrategySignals(sleeps, "2025-06-01", "UTC",
      new Date("2026-03-26T12:00:00Z").getTime());
    // Night entry counted via fallback heuristic.
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

    // Been awake 90 min — high pressure (above baby's observed p75)
    const high = predictNewborn({
      ageMonths: 0, tz: "UTC", recentSleeps,
      lastSleepEndMs,
      now: lastSleepEndMs + 90 * 60_000,
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

    // 0-1 month: Galland 95% CI range (9.3-20.0h), typical from SLEEP_NEEDS
    expect(result.ageNorms.totalSleepHours.min).toBe(9.3);
    expect(result.ageNorms.totalSleepHours.max).toBe(20.0);
    expect(result.ageNorms.totalSleepHours.typical).toBe(16.5);
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

// ─── Emerging engine ──────────────────────────────────────────────────────────

/** Generate emerging-phase sleep: 3-4 naps with some structure. */
function emergingDay(dateStr: string): SleepEntry[] {
  return [
    sleep(`${dateStr}T06:00:00Z`, `${dateStr}T06:30:00Z`, "night"),
    sleep(`${dateStr}T08:30:00Z`, `${dateStr}T10:00:00Z`, "nap"),
    sleep(`${dateStr}T12:00:00Z`, `${dateStr}T13:00:00Z`, "nap"),
    sleep(`${dateStr}T15:00:00Z`, `${dateStr}T16:00:00Z`, "nap"),
    sleep(`${dateStr}T19:00:00Z`, `${dateStr}T23:59:00Z`, "night"),
  ];
}

function emergingCtx(recentSleeps: SleepEntry[]): BabyContext {
  return {
    birthdate: "2026-01-01",
    ageMonths: 3,
    tz: "UTC",
    customNapCount: null,
    recentSleeps,
  };
}

describe("predictEmerging", () => {
  const recentSleeps = [
    ...emergingDay("2026-03-22"),
    ...emergingDay("2026-03-23"),
    ...emergingDay("2026-03-24"),
    ...emergingDay("2026-03-25"),
  ];

  it("returns schedule-derived nap predictions with wake time", () => {
    const result = predictEmerging({
      ctx: emergingCtx(recentSleeps),
      todaySleeps: [],
      wakeUpTime: "2026-03-26T07:00:00Z",
      lastSleepEndMs: new Date("2026-03-25T23:59:00Z").getTime(),
      now: new Date("2026-03-26T08:00:00Z").getTime(),
    });

    expect(result.strategy).toBe("emerging_rhythm");
    expect(result.predictedNaps).not.toBeNull();
    expect(result.predictedNaps!.length).toBeGreaterThan(0);
    expect(result.bedtime).not.toBeNull();
  });

  it("assigns per-nap confidence from start time consistency", () => {
    const result = predictEmerging({
      ctx: emergingCtx(recentSleeps),
      todaySleeps: [],
      wakeUpTime: "2026-03-26T07:00:00Z",
      lastSleepEndMs: new Date("2026-03-25T23:59:00Z").getTime(),
      now: new Date("2026-03-26T08:00:00Z").getTime(),
    });

    // With 4 identical days, first nap should be highly consistent
    expect(result.napConfidence.length).toBeGreaterThan(0);
    expect(result.napConfidence[0]).toBe("high");
  });

  it("provides sleep window fallback", () => {
    const result = predictEmerging({
      ctx: emergingCtx(recentSleeps),
      todaySleeps: [],
      wakeUpTime: "2026-03-26T07:00:00Z",
      lastSleepEndMs: new Date("2026-03-25T23:59:00Z").getTime(),
      now: new Date("2026-03-26T08:00:00Z").getTime(),
    });

    expect(result.sleepWindow).not.toBeNull();
    expect(result.sleepPressure).not.toBeNull();
  });

  it("provides rolling stats and age norms", () => {
    const result = predictEmerging({
      ctx: emergingCtx(recentSleeps),
      todaySleeps: [],
      wakeUpTime: null,
      lastSleepEndMs: null,
      now: new Date("2026-03-26T08:00:00Z").getTime(),
    });

    expect(result.rolling.totalSleep24h).toBeGreaterThan(0);
    expect(result.ageNorms.totalSleepHours.typical).toBe(15); // 3mo falls in 3-6mo bracket
  });

  it("handles no wake time gracefully", () => {
    const result = predictEmerging({
      ctx: emergingCtx(recentSleeps),
      todaySleeps: [],
      wakeUpTime: null,
      lastSleepEndMs: null,
      now: new Date("2026-03-26T08:00:00Z").getTime(),
    });

    expect(result.strategy).toBe("emerging_rhythm");
    expect(result.predictedNaps).toBeNull();
    expect(result.nextNap).toBeNull();
  });
});

// ─── Hysteresis ───────────────────────────────────────────────────────────────

describe("selectStrategy hysteresis", () => {
  const emergingSignals = signals({ ageWeeks: 12, ageMonths: 3 }); // raw = emerging
  const scheduleSignals = signals({ ageWeeks: 26, ageMonths: 6, completeDays: 10, nightDayRatio: 0.6 }); // raw = routine

  it("forward transition requires 3 consecutive days", () => {
    // Day 1-2: raw says schedule, but hysteresis holds on emerging
    expect(selectStrategy(scheduleSignals, {
      previous: "emerging_rhythm", consecutiveDaysAtCandidate: 1, override: null,
    })).toBe("emerging_rhythm");

    expect(selectStrategy(scheduleSignals, {
      previous: "emerging_rhythm", consecutiveDaysAtCandidate: 2, override: null,
    })).toBe("emerging_rhythm");

    // Day 3: transition happens
    expect(selectStrategy(scheduleSignals, {
      previous: "emerging_rhythm", consecutiveDaysAtCandidate: 3, override: null,
    })).toBe("routine_schedule");
  });

  it("regression requires 5 consecutive days", () => {
    // Days 1-4: raw says emerging, but hysteresis holds on routine
    for (let d = 1; d <= 4; d++) {
      expect(selectStrategy(emergingSignals, {
        previous: "routine_schedule", consecutiveDaysAtCandidate: d, override: null,
      })).toBe("routine_schedule");
    }

    // Day 5: regression happens
    expect(selectStrategy(emergingSignals, {
      previous: "routine_schedule", consecutiveDaysAtCandidate: 5, override: null,
    })).toBe("emerging_rhythm");
  });

  it("newborn age gate bypasses hysteresis", () => {
    const newbornSignals = signals({ ageWeeks: 3, ageMonths: 0 });
    // Even with previous = emerging and 0 consecutive days
    expect(selectStrategy(newbornSignals, {
      previous: "emerging_rhythm", consecutiveDaysAtCandidate: 0, override: null,
    })).toBe("newborn_guidance");
  });

  it("manual override bypasses all rules", () => {
    expect(selectStrategy(emergingSignals, {
      previous: "emerging_rhythm", consecutiveDaysAtCandidate: 0, override: "routine_schedule",
    })).toBe("routine_schedule");

    expect(selectStrategy(scheduleSignals, {
      previous: "routine_schedule", consecutiveDaysAtCandidate: 0, override: "newborn_guidance",
    })).toBe("newborn_guidance");
  });

  it("no context = stateless selection", () => {
    expect(selectStrategy(scheduleSignals)).toBe("routine_schedule");
    expect(selectStrategy(emergingSignals)).toBe("emerging_rhythm");
  });
});
