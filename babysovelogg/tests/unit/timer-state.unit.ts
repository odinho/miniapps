import { describe, it, expect } from "bun:test";
import { getTimerMode, getAwakeSince, type TimerInput } from "$lib/timer-state.js";
import type { Prediction } from "$lib/stores/app.svelte.js";
import type { SleepLogRow } from "$lib/types.js";

function makeSleep(overrides: Partial<SleepLogRow> = {}): SleepLogRow {
  return {
    id: 1,
    baby_id: 1,
    start_time: "2026-03-27T10:00:00.000Z",
    end_time: null,
    type: "nap",
    notes: null,
    mood: null,
    method: null,
    fall_asleep_time: null,
    onset_note: null,
    woke_by: null,
    wake_notes: null,
    wake_mood: null,
    deleted: 0,
    domain_id: "test-1",
    created_by_event_id: null,
    updated_by_event_id: null,
    ...overrides,
  };
}

/** Build a routine_schedule prediction with defaults for test brevity. */
function makePrediction(overrides: Partial<Prediction> = {}): Prediction {
  return {
    strategy: "routine_schedule",
    nextNap: "2026-03-27T14:00:00.000Z",
    bedtime: "2026-03-27T19:00:00.000Z",
    predictedNaps: null,
    expectedNapCount: 2,
    napsAllDone: false,
    expectedNapEnd: null,
    expectedNightEnd: null,
    confidence: null,
    calibration: null,
    sleepWindow: null,
    sleepPressure: null,
    totalSleep24h: null,
    longestStretch: null,
    longestStretchTrend: null,
    longestStretchDetail: null,
    ageNorms: null,
    rolling: null,
    learnedSchedule: null,
    rescueNap: null,
    ...overrides,
  };
}

function makeInput(overrides: Partial<TimerInput> = {}): TimerInput {
  return {
    activeSleep: null,
    prediction: null,
    todayWakeUp: null,
    todaySleeps: [],
    now: new Date("2026-03-27T12:00:00.000Z").getTime(),
    ...overrides,
  };
}

describe("getTimerMode", () => {
  describe("sleeping states", () => {
    it("returns sleeping/Lurar for active nap", () => {
      const input = makeInput({
        activeSleep: makeSleep({ start_time: "2026-03-27T11:30:00.000Z", type: "nap" }),
      });
      const mode = getTimerMode(input);
      expect(mode.kind).toBe("sleeping");
      if (mode.kind === "sleeping") {
        expect(mode.label).toBe("😴 Lurar");
        // 30 min elapsed
        expect(mode.elapsed).toBeCloseTo(30 * 60 * 1000, -2);
      }
    });

    it("returns sleeping/Søv for active night sleep", () => {
      const input = makeInput({
        activeSleep: makeSleep({ start_time: "2026-03-27T20:00:00.000Z", type: "night" }),
        now: new Date("2026-03-27T22:00:00.000Z").getTime(),
      });
      const mode = getTimerMode(input);
      expect(mode.kind).toBe("sleeping");
      if (mode.kind === "sleeping") {
        expect(mode.label).toBe("💤 Søv");
        expect(mode.elapsed).toBeCloseTo(2 * 60 * 60 * 1000, -2);
      }
    });

    it("returns Pause when sleep is paused", () => {
      const input = makeInput({
        activeSleep: makeSleep({
          start_time: "2026-03-27T11:00:00.000Z",
          pauses: [
            { id: 1, sleep_id: 1, pause_time: "2026-03-27T11:30:00.000Z", resume_time: null, created_by_event_id: null },
          ],
        }),
      });
      const mode = getTimerMode(input);
      expect(mode.kind).toBe("sleeping");
      if (mode.kind === "sleeping") {
        expect(mode.label).toBe("⏸️ Pause");
      }
    });

    it("subtracts resumed pause from elapsed", () => {
      const input = makeInput({
        activeSleep: makeSleep({
          start_time: "2026-03-27T11:00:00.000Z",
          pauses: [
            {
              id: 1, sleep_id: 1,
              pause_time: "2026-03-27T11:10:00.000Z",
              resume_time: "2026-03-27T11:20:00.000Z",
              created_by_event_id: null,
            },
          ],
        }),
      });
      const mode = getTimerMode(input);
      expect(mode.kind).toBe("sleeping");
      if (mode.kind === "sleeping") {
        // 60 min total - 10 min pause = 50 min
        expect(mode.elapsed).toBeCloseTo(50 * 60 * 1000, -2);
      }
    });

    it("shows expected wake countdown for active nap", () => {
      const input = makeInput({
        activeSleep: makeSleep({ start_time: "2026-03-27T10:00:00.000Z", type: "nap" }),
        prediction: makePrediction({ expectedNapEnd: "2026-03-27T11:00:00.000Z" }),
        now: new Date("2026-03-27T10:30:00.000Z").getTime(),
      });
      const mode = getTimerMode(input);
      expect(mode.kind).toBe("sleeping");
      if (mode.kind === "sleeping") {
        expect(mode.expectedWake).toBe("2026-03-27T11:00:00.000Z");
        expect(mode.expectedWakeCountdown).toBe(30 * 60 * 1000);
      }
    });

    it("F2: shows negative countdown when nap exceeds expected duration", () => {
      const input = makeInput({
        activeSleep: makeSleep({ start_time: "2026-03-27T10:00:00.000Z", type: "nap" }),
        prediction: makePrediction({ expectedNapEnd: "2026-03-27T11:00:00.000Z" }),
        now: new Date("2026-03-27T11:25:00.000Z").getTime(),
      });
      const mode = getTimerMode(input);
      expect(mode.kind).toBe("sleeping");
      if (mode.kind === "sleeping") {
        expect(mode.expectedWake).toBe("2026-03-27T11:00:00.000Z");
        // 25 minutes overtime = negative countdown
        expect(mode.expectedWakeCountdown).toBe(-25 * 60 * 1000);
      }
    });

    it("does not treat ended sleep as sleeping", () => {
      const input = makeInput({
        activeSleep: makeSleep({
          start_time: "2026-03-27T10:00:00.000Z",
          end_time: "2026-03-27T11:00:00.000Z",
        }),
      });
      const mode = getTimerMode(input);
      expect(mode.kind).not.toBe("sleeping");
    });
  });

  describe("deep night (0-5am)", () => {
    it("shows deep-night between midnight and 5am", () => {
      // 2am local — use a time that gives hour 2 in local timezone
      const d = new Date("2026-03-27T12:00:00.000Z");
      d.setHours(2, 0, 0, 0);
      const input = makeInput({ now: d.getTime() });
      const mode = getTimerMode(input);
      expect(mode.kind).toBe("deep-night");
    });

    it("includes wake countdown when set and in future", () => {
      const d = new Date("2026-03-27T12:00:00.000Z");
      d.setHours(2, 0, 0, 0);
      const wakeTime = new Date(d);
      wakeTime.setHours(7, 0, 0, 0);
      const input = makeInput({
        now: d.getTime(),
        todayWakeUp: { wake_time: wakeTime.toISOString() },
      });
      const mode = getTimerMode(input);
      expect(mode.kind).toBe("deep-night");
      if (mode.kind === "deep-night") {
        expect(mode.wakeCountdown).toBeCloseTo(5 * 60 * 60 * 1000, -2);
      }
    });
  });

  describe("next nap countdown", () => {
    it("shows next-nap when prediction has future nextNap", () => {
      const input = makeInput({
        prediction: makePrediction(),
      });
      const mode = getTimerMode(input);
      expect(mode.kind).toBe("next-nap");
      if (mode.kind === "next-nap") {
        // 2 hours countdown
        expect(mode.countdown).toBeCloseTo(2 * 60 * 60 * 1000, -2);
      }
    });
  });

  describe("overtime", () => {
    it("shows overtime when nextNap is in the past and naps not done", () => {
      const input = makeInput({
        prediction: makePrediction({ nextNap: "2026-03-27T11:00:00.000Z" }),
      });
      const mode = getTimerMode(input);
      expect(mode.kind).toBe("overtime");
      if (mode.kind === "overtime") {
        // 1 hour overtime
        expect(mode.overtime).toBeCloseTo(60 * 60 * 1000, -2);
      }
    });
  });

  describe("bedtime", () => {
    it("shows bedtime countdown when naps are all done", () => {
      const input = makeInput({
        prediction: makePrediction({ napsAllDone: true }),
      });
      const mode = getTimerMode(input);
      expect(mode.kind).toBe("bedtime");
      if (mode.kind === "bedtime") {
        expect(mode.countdown).toBeCloseTo(7 * 60 * 60 * 1000, -2);
      }
    });

    it("shows after-bedtime when bedtime has passed", () => {
      const input = makeInput({
        now: new Date("2026-03-27T20:00:00.000Z").getTime(),
        prediction: makePrediction({ napsAllDone: true }),
      });
      const mode = getTimerMode(input);
      // At 20:00 (evening), napsAllDone, bedtime in past
      expect(mode.kind).toBe("after-bedtime");
      if (mode.kind === "after-bedtime") {
        expect(mode.bedtime).toBe("2026-03-27T19:00:00.000Z");
      }
    });

    it("shows bedtime in evening even if naps not done", () => {
      // 21:00 local
      const d = new Date("2026-03-27T12:00:00.000Z");
      d.setHours(21, 0, 0, 0);
      const bedtime = new Date(d);
      bedtime.setHours(22, 0, 0, 0);
      const nextNap = new Date(d);
      nextNap.setHours(14, 0, 0, 0);
      const input = makeInput({
        now: d.getTime(),
        prediction: makePrediction({ nextNap: nextNap.toISOString(), bedtime: bedtime.toISOString() }),
      });
      const mode = getTimerMode(input);
      expect(mode.kind).toBe("bedtime");
    });
  });

  describe("idle", () => {
    it("returns idle when no active sleep and no prediction", () => {
      const input = makeInput();
      const mode = getTimerMode(input);
      expect(mode.kind).toBe("idle");
    });
  });
});

describe("sleep-window mode", () => {
  it("newborn strategy uses sleep-window mode", () => {
    const input = makeInput({
      prediction: makePrediction({
        strategy: "newborn_guidance",
        nextNap: null,
        bedtime: null,
        sleepWindow: { earliest: "2026-03-27T12:30:00.000Z", latest: "2026-03-27T13:00:00.000Z" },
        sleepPressure: "rising",
      }),
    });
    const mode = getTimerMode(input);
    expect(mode.kind).toBe("sleep-window");
    if (mode.kind === "sleep-window") {
      expect(mode.pressure).toBe("rising");
    }
  });

  it("emerging without nextNap uses sleep-window mode", () => {
    const input = makeInput({
      prediction: makePrediction({
        strategy: "emerging_rhythm",
        nextNap: null,
        bedtime: null,
        sleepWindow: { earliest: "2026-03-27T12:30:00.000Z", latest: "2026-03-27T13:00:00.000Z" },
        sleepPressure: "low",
      }),
    });
    const mode = getTimerMode(input);
    expect(mode.kind).toBe("sleep-window");
  });

  it("emerging with nextNap uses schedule countdown", () => {
    const input = makeInput({
      prediction: makePrediction({
        strategy: "emerging_rhythm",
        nextNap: "2026-03-27T14:00:00.000Z",
        bedtime: "2026-03-27T19:00:00.000Z",
        sleepWindow: { earliest: "2026-03-27T12:30:00.000Z", latest: "2026-03-27T13:00:00.000Z" },
        sleepPressure: "rising",
      }),
    });
    const mode = getTimerMode(input);
    expect(mode.kind).toBe("next-nap");
  });
});

describe("getAwakeSince", () => {
  it("returns null with no sleeps and no wake-up", () => {
    expect(getAwakeSince(makeInput())).toBeNull();
  });

  it("uses last sleep end_time when available", () => {
    const input = makeInput({
      todaySleeps: [
        makeSleep({
          start_time: "2026-03-27T09:00:00.000Z",
          end_time: "2026-03-27T10:00:00.000Z",
        }),
      ],
    });
    const result = getAwakeSince(input);
    expect(result).toBeCloseTo(2 * 60 * 60 * 1000, -2);
  });

  it("falls back to todayWakeUp when no completed sleeps", () => {
    const input = makeInput({
      todayWakeUp: { wake_time: "2026-03-27T07:00:00.000Z" },
    });
    const result = getAwakeSince(input);
    expect(result).toBeCloseTo(5 * 60 * 60 * 1000, -2);
  });

  it("returns null when awake less than 1 minute", () => {
    const input = makeInput({
      todaySleeps: [
        makeSleep({
          start_time: "2026-03-27T11:00:00.000Z",
          end_time: "2026-03-27T11:59:30.000Z",
        }),
      ],
    });
    const result = getAwakeSince(input);
    expect(result).toBeNull();
  });
});
