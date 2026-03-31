import { describe, expect, it } from "bun:test";
import {
  classifySleepType,
  classifySleepTypeByHour,
  calcPauseMs,
  shouldReclassifyAsNight,
} from "$lib/engine/classification.js";
import type { SleepLogRow, SleepPauseRow } from "$lib/types.js";

function sleepRow(overrides: Partial<SleepLogRow> = {}): SleepLogRow {
  return {
    id: 1,
    baby_id: 1,
    start_time: "2026-03-26T09:00:00.000Z",
    end_time: "2026-03-26T10:00:00.000Z",
    type: "nap",
    notes: null,
    mood: null,
    method: null,
    fall_asleep_time: null,
    woke_by: null,
    wake_notes: null,
    deleted: 0,
    domain_id: "slp_test",
    created_by_event_id: null,
    updated_by_event_id: null,
    ...overrides,
  };
}

// --- classifySleepTypeByHour ---

describe("classifySleepTypeByHour", () => {
  const cases: [number, "nap" | "night"][] = [
    [3, "night"],
    [5, "night"],
    [6, "nap"],
    [12, "nap"],
    [17, "nap"],
    [18, "night"],
    [22, "night"],
    [0, "night"],
  ];

  for (const [hour, expected] of cases) {
    it(`hour ${hour} → ${expected}`, () => {
      expect(classifySleepTypeByHour(hour)).toBe(expected);
    });
  }
});

// --- classifySleepType ---

describe("classifySleepType", () => {
  it("clear night hours", () => {
    expect(classifySleepType([], undefined, undefined, 3)).toBe("night");
    expect(classifySleepType([], undefined, undefined, 21)).toBe("night");
  });

  it("clear daytime hours", () => {
    expect(classifySleepType([], undefined, undefined, 8)).toBe("nap");
    expect(classifySleepType([], undefined, undefined, 15)).toBe("nap");
  });

  it("ambiguous zone: nap quota met → night", () => {
    const todaySleeps = [
      sleepRow({ type: "nap", end_time: "2026-03-26T10:00:00.000Z" }),
      sleepRow({ type: "nap", end_time: "2026-03-26T14:00:00.000Z" }),
    ];
    // 9 months → 2 expected naps, 2 completed → night
    expect(classifySleepType(todaySleeps, 9, null, 17)).toBe("night");
  });

  it("ambiguous zone: nap quota NOT met → nap", () => {
    const todaySleeps = [sleepRow({ type: "nap", end_time: "2026-03-26T10:00:00.000Z" })];
    // 9 months → 2 expected naps, 1 completed → nap (hour 17 < 18)
    expect(classifySleepType(todaySleeps, 9, null, 17)).toBe("nap");
  });

  it("ambiguous zone 18-19: defaults to night without age info", () => {
    expect(classifySleepType([], undefined, undefined, 18)).toBe("night");
    expect(classifySleepType([], undefined, undefined, 19)).toBe("night");
  });

  it("custom nap count overrides age-based count", () => {
    const todaySleeps = [sleepRow({ type: "nap", end_time: "2026-03-26T10:00:00.000Z" })];
    // Custom: 1 nap. 1 completed → quota met → night
    expect(classifySleepType(todaySleeps, 9, 1, 17)).toBe("night");
  });

  it("in-progress naps don't count toward quota", () => {
    const todaySleeps = [
      sleepRow({ type: "nap", end_time: null }), // still sleeping
    ];
    // 9 months → 2 expected, 0 completed (in-progress doesn't count) → nap
    expect(classifySleepType(todaySleeps, 9, null, 17)).toBe("nap");
  });
});

// --- shouldReclassifyAsNight ---

describe("shouldReclassifyAsNight", () => {
  it("14h sleep starting at 19:18 → reclassify", () => {
    expect(shouldReclassifyAsNight("2026-03-27T19:18:00.000Z", "2026-03-28T09:21:00.000Z")).toBe(true);
  });

  it("7h sleep starting at 17:00 → reclassify", () => {
    expect(shouldReclassifyAsNight("2026-03-27T17:00:00.000Z", "2026-03-28T00:00:00.000Z")).toBe(true);
  });

  it("1h nap starting at 19:00 → no reclassify", () => {
    expect(shouldReclassifyAsNight("2026-03-27T19:00:00.000Z", "2026-03-27T20:00:00.000Z")).toBe(false);
  });

  it("7h sleep starting at 10:00 → no reclassify (daytime)", () => {
    expect(shouldReclassifyAsNight("2026-03-27T10:00:00.000Z", "2026-03-27T17:00:00.000Z")).toBe(false);
  });

  it("5h sleep starting at 18:00 → no reclassify (under 6h)", () => {
    expect(shouldReclassifyAsNight("2026-03-27T18:00:00.000Z", "2026-03-27T23:00:00.000Z")).toBe(false);
  });

  it("exactly 6h starting at 17:00 → no reclassify (not > 6h)", () => {
    expect(shouldReclassifyAsNight("2026-03-27T17:00:00.000Z", "2026-03-27T23:00:00.000Z")).toBe(false);
  });
});

// --- calcPauseMs ---

describe("calcPauseMs", () => {
  it("empty pauses", () => {
    expect(calcPauseMs([])).toBe(0);
  });

  it("single completed pause", () => {
    const pauses: SleepPauseRow[] = [
      {
        id: 1,
        sleep_id: 1,
        pause_time: "2026-03-26T09:20:00.000Z",
        resume_time: "2026-03-26T09:30:00.000Z",
        created_by_event_id: null,
      },
    ];
    expect(calcPauseMs(pauses)).toBe(10 * 60 * 1000);
  });

  it("multiple pauses sum up", () => {
    const pauses: SleepPauseRow[] = [
      {
        id: 1,
        sleep_id: 1,
        pause_time: "2026-03-26T09:20:00.000Z",
        resume_time: "2026-03-26T09:30:00.000Z",
        created_by_event_id: null,
      },
      {
        id: 2,
        sleep_id: 1,
        pause_time: "2026-03-26T09:40:00.000Z",
        resume_time: "2026-03-26T09:55:00.000Z",
        created_by_event_id: null,
      },
    ];
    expect(calcPauseMs(pauses)).toBe(25 * 60 * 1000);
  });
});
