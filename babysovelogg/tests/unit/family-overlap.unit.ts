import { describe, expect, it } from "bun:test";
import { buildBabyWindow, computeOverlapSuggestion, type OverlapBabyInput } from "$lib/family-overlap.js";
import type { Prediction } from "$lib/stores/app.svelte.js";

const at = (h: number, m = 0) =>
  new Date(`2026-06-14T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`).toISOString();
const NOW = new Date(at(10)).getTime();

const pred = (over: Partial<Prediction>): Prediction => ({ ...over }) as Prediction;

const range = (point: string, lo: string, hi: string, sd = 12) => ({ point, lo, hi, sdMinutes: sd });

const baby = (over: Partial<OverlapBabyInput>): OverlapBabyInput => ({
  baby: { id: 1, name: "Ada", timezone: "UTC" } as OverlapBabyInput["baby"],
  prediction: null,
  activeSleep: null,
  staleActiveSleep: null,
  offDays: [],
  ageMonths: 9,
  ...over,
});

describe("buildBabyWindow", () => {
  it("blocks on off-day, stale sleep, low confidence, or no prediction", () => {
    expect(buildBabyWindow(baby({ prediction: null }), NOW)?.blocked).toBe(true);
    expect(buildBabyWindow(baby({ prediction: pred({}), offDays: ["2026-06-14"] }), NOW)?.blocked).toBe(true);
    expect(
      buildBabyWindow(baby({ prediction: pred({}), staleActiveSleep: {} as OverlapBabyInput["staleActiveSleep"] }), NOW)?.blocked,
    ).toBe(true);
    expect(
      buildBabyWindow(
        baby({ prediction: pred({ confidence: { level: "low", napRanges: [], bedtimeRange: range(at(19), at(18), at(20)), dataPoints: 1 } }) }),
        NOW,
      )?.blocked,
    ).toBe(true);
  });

  it("awake → next nap with duration + ±1σ window from confidence", () => {
    const w = buildBabyWindow(
      baby({
        prediction: pred({
          nextNap: at(12),
          napsAllDone: false,
          predictedNaps: [{ startTime: at(12), endTime: at(13, 30) }],
          confidence: {
            level: "high",
            dataPoints: 7,
            napRanges: [{ startTime: at(12), endTime: at(13, 30), startRange: range(at(12), at(11, 40), at(12, 20), 14) }],
            bedtimeRange: range(at(19), at(18, 40), at(19, 20)),
          },
        }),
      }),
      NOW,
    );
    expect(w?.next).toEqual({ kind: "nap", plannedStart: at(12), durationMin: 90 });
    expect(w?.window).toEqual({ earliest: at(11, 40), latest: at(12, 20) });
    expect(w?.sdMinutes).toBe(14);
    expect(w?.blocked).toBe(false);
  });

  it("asleep → asleepUntil from the wake range, no movable next", () => {
    const w = buildBabyWindow(
      baby({
        activeSleep: { end_time: null } as OverlapBabyInput["activeSleep"],
        prediction: pred({ expectedWakeRange: range(at(11), at(10, 45), at(11, 15)), confidence: { level: "high", dataPoints: 7, napRanges: [], bedtimeRange: range(at(19), at(18), at(20)) } }),
      }),
      NOW,
    );
    expect(w?.next).toBeNull();
    expect(w?.asleepUntil).toEqual({ expected: at(11) });
  });
});

describe("computeOverlapSuggestion", () => {
  it("returns null unless there are exactly two children", () => {
    expect(computeOverlapSuggestion([], NOW)).toBeNull();
    expect(computeOverlapSuggestion([baby({})], NOW)).toBeNull();
  });

  it("suggests nudging the awake twin to overlap the sleeping one (builder + suggest end-to-end)", () => {
    const asleep = baby({
      baby: { id: 1, name: "Ada", timezone: "UTC" } as OverlapBabyInput["baby"],
      activeSleep: { end_time: null } as OverlapBabyInput["activeSleep"],
      prediction: pred({
        expectedWakeRange: range(at(13, 30), at(13, 15), at(13, 45)),
        confidence: { level: "high", dataPoints: 7, napRanges: [], bedtimeRange: range(at(19), at(18), at(20)) },
      }),
    });
    const awake = baby({
      baby: { id: 2, name: "Bo", timezone: "UTC" } as OverlapBabyInput["baby"],
      prediction: pred({
        nextNap: at(13, 30),
        napsAllDone: false,
        predictedNaps: [{ startTime: at(13, 30), endTime: at(15) }],
        confidence: {
          level: "high",
          dataPoints: 7,
          napRanges: [{ startTime: at(13, 30), endTime: at(15), startRange: range(at(13, 30), at(11, 30), at(13, 30)) }],
          bedtimeRange: range(at(19), at(18, 40), at(19, 20)),
        },
      }),
    });
    const s = computeOverlapSuggestion([asleep, awake], NOW);
    expect(s?.babyId).toBe(2);
    expect(s!.deltaMin).toBeLessThan(0);
    expect(s!.projectedOverlapMin).toBeGreaterThanOrEqual(30);
  });
});
