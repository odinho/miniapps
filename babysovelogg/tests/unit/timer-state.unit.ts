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
    feasible: true,
    nextNap: "2026-03-27T14:00:00.000Z",
    bedtime: "2026-03-27T19:00:00.000Z",
    predictedNaps: null,
    expectedNapCount: 2,
    napsAllDone: false,
    expectedNapEnd: null,
    expectedNightEnd: null,
    expectedWakeRange: null,
    skippedNap: null,
    postSkipPlan: null,
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
    continuationWindow: null,
    napBudget: null,
    dailyTrendTotalMin: null,
    trendTargets: null,
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

    it("shows Vakning label when a night sleep has an open night_waking", () => {
      // `now` defaults to 12:00 UTC in makeInput.
      const input = makeInput({
        activeSleep: makeSleep({
          start_time: "2026-03-27T08:00:00.000Z",
          type: "night",
        }),
        todayNightWakings: [
          {
            id: 1,
            baby_id: 1,
            domain_id: "nwk_1",
            start_time: "2026-03-27T11:30:00.000Z",
            end_time: null,
            notes: null,
            mood: null,
            deleted: 0,
            created_by_event_id: null,
            updated_by_event_id: null,
          },
        ],
      });
      const mode = getTimerMode(input);
      expect(mode.kind).toBe("sleeping");
      if (mode.kind === "sleeping") {
        expect(mode.label).toMatch(/^🌙 Vakning sidan/);
      }
    });

    it("subtracts closed night_waking interval from elapsed", () => {
      const input = makeInput({
        activeSleep: makeSleep({
          start_time: "2026-03-27T11:00:00.000Z",
          type: "night",
        }),
        todayNightWakings: [
          {
            id: 1,
            baby_id: 1,
            domain_id: "nwk_1",
            start_time: "2026-03-27T11:10:00.000Z",
            end_time: "2026-03-27T11:20:00.000Z",
            notes: null,
            mood: null,
            deleted: 0,
            created_by_event_id: null,
            updated_by_event_id: null,
          },
        ],
      });
      const mode = getTimerMode(input);
      expect(mode.kind).toBe("sleeping");
      if (mode.kind === "sleeping") {
        // start=11:00, now=12:00 → 60 min total. Waking 11:10–11:20 = 10 min.
        // 60 − 10 = 50 min elapsed.
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

    it("expected wake points at the napBudget cap, not the natural nap-end", () => {
      const input = makeInput({
        activeSleep: makeSleep({ start_time: "2026-03-27T10:00:00.000Z", type: "nap" }),
        prediction: makePrediction({
          expectedNapEnd: "2026-03-27T11:30:00.000Z",
          napBudget: {
            wakeBy: "2026-03-27T10:55:00.000Z",
            recommendedDurationMin: 55,
            reason: "over_trend",
            mode: "first-contact",
            urgency: "firm",
            context: { blendedTrendMin: 780, bankedMin: 740, toleranceMin: 20, sourceLabel: "x" },
            cycleNudge: null,
          },
        }),
        now: new Date("2026-03-27T10:30:00.000Z").getTime(),
      });
      const mode = getTimerMode(input);
      expect(mode.kind).toBe("sleeping");
      if (mode.kind === "sleeping") {
        // Cap (10:55), not the natural end (11:30) — matches the banner/arc.
        expect(mode.expectedWake).toBe("2026-03-27T10:55:00.000Z");
        expect(mode.expectedWakeCountdown).toBe(25 * 60 * 1000);
      }
    });

    it("expected wake falls back to rescueNap cap when no napBudget", () => {
      const input = makeInput({
        activeSleep: makeSleep({ start_time: "2026-03-27T10:00:00.000Z", type: "nap" }),
        prediction: makePrediction({
          expectedNapEnd: "2026-03-27T11:30:00.000Z",
          rescueNap: { recommendedWakeTime: "2026-03-27T10:50:00.000Z", reason: "short_prior_nap" },
        }),
        now: new Date("2026-03-27T10:30:00.000Z").getTime(),
      });
      const mode = getTimerMode(input);
      if (mode.kind === "sleeping") {
        expect(mode.expectedWake).toBe("2026-03-27T10:50:00.000Z");
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

  describe("skipped nap", () => {
    const skipPrediction = (overrides: Partial<Prediction> = {}) =>
      makePrediction({
        skippedNap: { plannedAt: "2026-03-27T10:00:00.000Z" },
        postSkipPlan: {
          kind: "earlier-bedtime",
          suggestedBedtime: "2026-03-27T19:00:00.000Z",
          minutesEarlier: 0,
        },
        ...overrides,
      });

    it("shows skipped-nap while bedtime is still ahead", () => {
      const input = makeInput({
        prediction: skipPrediction(),
        now: new Date("2026-03-27T12:00:00.000Z").getTime(),
      });
      expect(getTimerMode(input).kind).toBe("skipped-nap");
    });

    it("yields to after-bedtime once the planned bedtime has passed", () => {
      const input = makeInput({
        prediction: skipPrediction(),
        now: new Date("2026-03-27T20:00:00.000Z").getTime(),
      });
      // Past 19:00 bedtime: no longer "Hoppa over lur" + stale earlier-bedtime tip.
      expect(getTimerMode(input).kind).toBe("after-bedtime");
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

describe("getTimerMode — skipped-nap state", () => {
  it("returns skipped-nap mode when prediction has skippedNap and no active sleep", () => {
    const input = makeInput({
      prediction: makePrediction({
        nextNap: "2026-03-27T19:00:00.000Z",
        bedtime: "2026-03-27T19:00:00.000Z",
        napsAllDone: true,
        skippedNap: { plannedAt: "2026-03-27T10:00:00.000Z" },
        postSkipPlan: {
          kind: "rescue",
          recommendedStart: "2026-03-27T12:30:00.000Z",
          latestStart: "2026-03-27T14:30:00.000Z",
          wakeBy: "2026-03-27T13:30:00.000Z",
        },
      }),
      now: new Date("2026-03-27T12:00:00.000Z").getTime(),
    });
    const mode = getTimerMode(input);
    expect(mode.kind).toBe("skipped-nap");
    if (mode.kind === "skipped-nap") {
      expect(mode.plannedAt).toBe("2026-03-27T10:00:00.000Z");
      expect(mode.plannedAgoMs).toBeCloseTo(2 * 60 * 60 * 1000, -2);
      expect(mode.postSkipPlan?.kind).toBe("rescue");
      expect(mode.bedtime).toBe("2026-03-27T19:00:00.000Z");
      expect(mode.bedtimeCountdown).toBeCloseTo(7 * 60 * 60 * 1000, -2);
    }
  });

  it("skipped-nap takes precedence over bedtime mode (the bug we're fixing)", () => {
    // Before the fix: napSkipped → napsAllDone → nextNap = bedtime → Timer
    // silently shows "bedtime in 7h". Now we should see skipped-nap first.
    const input = makeInput({
      prediction: makePrediction({
        nextNap: "2026-03-27T19:00:00.000Z",
        bedtime: "2026-03-27T19:00:00.000Z",
        napsAllDone: true,
        skippedNap: { plannedAt: "2026-03-27T10:00:00.000Z" },
        postSkipPlan: null,
      }),
      now: new Date("2026-03-27T12:00:00.000Z").getTime(),
    });
    const mode = getTimerMode(input);
    expect(mode.kind).toBe("skipped-nap");
  });

  it("active sleep wins over skipped-nap (parent finally put baby down)", () => {
    const input = makeInput({
      activeSleep: makeSleep({ start_time: "2026-03-27T12:30:00.000Z", type: "nap" }),
      prediction: makePrediction({
        skippedNap: { plannedAt: "2026-03-27T10:00:00.000Z" },
      }),
      now: new Date("2026-03-27T13:00:00.000Z").getTime(),
    });
    const mode = getTimerMode(input);
    expect(mode.kind).toBe("sleeping");
  });

  it("earlier-bedtime plan never has negative minutesEarlier", () => {
    // Regression: when now lands inside the [bedtime - shiftMin, bedtime]
    // window, naive math produced a "suggestedBedtime" *later* than the
    // planned bedtime with minutesEarlier = -15 (rendered as "-15m før
    // normalt"). Clamp must keep the shift non-negative.
    const input = makeInput({
      prediction: makePrediction({
        nextNap: "2026-03-27T19:30:00.000Z",
        bedtime: "2026-03-27T19:30:00.000Z",
        napsAllDone: true,
        skippedNap: { plannedAt: "2026-03-27T15:00:00.000Z" },
        postSkipPlan: {
          kind: "earlier-bedtime",
          suggestedBedtime: "2026-03-27T19:30:00.000Z",
          minutesEarlier: 0,
        },
      }),
      now: new Date("2026-03-27T19:15:00.000Z").getTime(),
    });
    const mode = getTimerMode(input);
    if (mode.kind === "skipped-nap" && mode.postSkipPlan?.kind === "earlier-bedtime") {
      expect(mode.postSkipPlan.minutesEarlier).toBeGreaterThanOrEqual(0);
    }
  });
});

// ── Timeline regression suite ─────────────────────────────────────────
//
// The shape every other test in this file leans on is "single point in
// time, single prediction". That left a class of bugs (transitions
// between modes across a day) silently uncovered — the 2026-05-17
// screenshot was exactly that: at 17:44 with bedtime at 18:17, an
// emerging-rhythm prediction whose next-nap got filtered out flipped
// the Timer into 'sleep-window' instead of the bedtime countdown a
// parent would expect.
//
// What this suite does: pin the timer mode at many timestamps across
// the day for several baby archetypes. Adding a regression here is
// cheap and the failure messages name the exact transition that
// broke.
describe("timer-mode timeline", () => {
  type TimerMode = ReturnType<typeof getTimerMode>;
  interface TimelinePoint {
    /** Local time-of-day for the assertion, "HH:MM". */
    at: string;
    expectedKind: TimerMode["kind"];
    /** Optional per-moment overrides on the base input. Real days have
     *  predictions that mutate as events fire — this lets a single
     *  timeline describe that progression. */
    inputOverrides?: (base: TimerInput) => TimerInput;
    /** Optional extra assertion against the resolved mode. */
    check?: (mode: TimerMode) => void;
  }

  function runTimeline(
    label: string,
    date: string,
    baseInput: () => TimerInput,
    points: TimelinePoint[],
  ): void {
    it(label, () => {
      for (const p of points) {
        const at = new Date(`${date}T${p.at}:00.000Z`).getTime();
        const base: TimerInput = { ...baseInput(), now: at };
        const input = p.inputOverrides ? p.inputOverrides(base) : base;
        const mode = getTimerMode({ ...input, now: at });
        expect(mode.kind, `${label} @ ${p.at}: expected ${p.expectedKind}, got ${mode.kind}`)
          .toBe(p.expectedKind);
        if (p.check) p.check(mode);
      }
    });
  }

  // Archetype 1 — Halldis-shaped 11mo on emerging_rhythm whose 2nd nap
  // is the one that gets filtered out near bedtime. Reproduces the
  // 2026-05-17 screenshot.
  runTimeline(
    "emerging 11mo + no 2nd-nap prediction + bedtime ~18:17: never falls into sleep-window in the final ~90 min",
    "2026-05-17",
    () => {
      const pred = makePrediction({
        strategy: "emerging_rhythm",
        // Emerging emits a sleep window even when nextNap is also set;
        // the original bug was sleep-window winning over bedtime here.
        sleepWindow: { earliest: "2026-05-17T17:30:00.000Z", latest: "2026-05-17T18:30:00.000Z" },
        sleepPressure: "high",
        nextNap: null,             // 2nd nap filtered out
        napsAllDone: false,
        bedtime: "2026-05-17T18:17:00.000Z",
        expectedNapCount: 2,
        learnedSchedule: {
          napDurationMin: 90, nightDurationMin: 720, wakeWindowMin: 240,
          bedtimeWakeWindowMin: 240, expectedNapCount: 2, sleepCycleMin: 50,
          sleepCycle: { minutes: 50, source: "age-default", confidence: "low", sampleCount: 0, scoreMargin: 0, candidateRange: [45, 62] },
        },
      });
      return makeInput({ prediction: pred });
    },
    [
      // Well before bedtime → sleep-window allowed (no other countdown to anchor on).
      { at: "14:00", expectedKind: "sleep-window" },
      // 90+ min before bedtime → still sleep-window territory.
      { at: "16:30", expectedKind: "sleep-window" },
      // 33 min before bedtime — the screenshot moment. Must NOT be
      // sleep-window; the parent's mental model is bedtime now.
      { at: "17:44", expectedKind: "bedtime", check: (m) => {
        if (m.kind === "bedtime") expect(m.bedtime).toBe("2026-05-17T18:17:00.000Z");
      } },
      // Past bedtime — second screenshot moment. Show after-bedtime
      // with a cycle target so the parent knows when to try again.
      { at: "18:39", expectedKind: "after-bedtime", check: (m) => {
        if (m.kind === "after-bedtime") {
          expect(m.nextCycleTarget).not.toBeNull();
          expect(m.cycleMin).toBe(50);
          // First cycle target past 18:39 is 18:17 + 50min = 19:07.
          expect(m.nextCycleTarget).toBe("2026-05-17T19:07:00.000Z");
        }
      } },
    ],
  );

  // Archetype 2 — routine_schedule, normal day with prediction
  // overrides for the evening (after the nap is logged).
  runTimeline(
    "routine 11mo: deep-night → next-nap → overtime → bedtime → after-bedtime",
    "2026-05-17",
    () => {
      const pred = makePrediction({
        strategy: "routine_schedule",
        nextNap: "2026-05-17T10:30:00.000Z",
        bedtime: "2026-05-17T18:30:00.000Z",
        napsAllDone: false,
        expectedNapCount: 1,
        learnedSchedule: {
          napDurationMin: 90, nightDurationMin: 720, wakeWindowMin: 240,
          bedtimeWakeWindowMin: 240, expectedNapCount: 1, sleepCycleMin: 45,
          sleepCycle: { minutes: 45, source: "age-default", confidence: "low", sampleCount: 0, scoreMargin: 0, candidateRange: [40, 60] },
        },
      });
      return makeInput({
        prediction: pred,
        todayWakeUp: { wake_time: "2026-05-17T05:30:00.000Z" },
      });
    },
    [
      { at: "02:30", expectedKind: "deep-night" },
      { at: "07:00", expectedKind: "next-nap" },
      { at: "11:00", expectedKind: "overtime" }, // 30 min past predicted nap, not yet skipped
      // After nap completed, prediction collapses napsAllDone → bedtime.
      { at: "17:00", expectedKind: "bedtime", inputOverrides: (base) => ({
        ...base,
        prediction: makePrediction({
          ...base.prediction!,
          nextNap: "2026-05-17T18:30:00.000Z",
          napsAllDone: true,
        }),
      }) },
      { at: "18:35", expectedKind: "after-bedtime", inputOverrides: (base) => ({
        ...base,
        prediction: makePrediction({
          ...base.prediction!,
          nextNap: "2026-05-17T18:30:00.000Z",
          napsAllDone: true,
        }),
      }) },
    ],
  );

  // Archetype 3 — the user's "post-bedtime" UX request. Past bedtime,
  // cycle target should be the *next* boundary, not a stale one.
  runTimeline(
    "after-bedtime cycle target advances as cycles pass",
    "2026-05-17",
    () => {
      const pred = makePrediction({
        strategy: "routine_schedule",
        nextNap: "2026-05-17T18:00:00.000Z", // collapsed
        napsAllDone: true,
        bedtime: "2026-05-17T18:00:00.000Z",
        learnedSchedule: {
          napDurationMin: 90, nightDurationMin: 720, wakeWindowMin: 240,
          bedtimeWakeWindowMin: 240, expectedNapCount: 1, sleepCycleMin: 50,
          sleepCycle: { minutes: 50, source: "age-default", confidence: "low", sampleCount: 0, scoreMargin: 0, candidateRange: [45, 62] },
        },
      });
      return makeInput({ prediction: pred });
    },
    [
      // 10 min after bedtime → next cycle target = 18:50.
      { at: "18:10", expectedKind: "after-bedtime", check: (m) => {
        if (m.kind === "after-bedtime") expect(m.nextCycleTarget).toBe("2026-05-17T18:50:00.000Z");
      } },
      // 55 min after bedtime → first cycle already past → next = 19:40.
      { at: "18:55", expectedKind: "after-bedtime", check: (m) => {
        if (m.kind === "after-bedtime") expect(m.nextCycleTarget).toBe("2026-05-17T19:40:00.000Z");
      } },
    ],
  );
});
