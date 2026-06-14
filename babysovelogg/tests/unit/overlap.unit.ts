import { describe, expect, it } from "bun:test";
import { suggestOverlap, MIN_OVERLAP_GAIN_MIN, type BabyWindow } from "$lib/engine/overlap.js";

const NOW = new Date("2026-06-14T10:00:00.000Z").getTime();
const at = (h: number, m = 0) =>
  new Date(`2026-06-14T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`).toISOString();

const win = (over: Partial<BabyWindow>): BabyWindow => ({
  babyId: 1,
  next: { kind: "nap", plannedStart: at(12), durationMin: 90 },
  window: { earliest: at(11), latest: at(13) },
  maxNudgeMin: 90,
  asleepUntil: null,
  sdMinutes: 15,
  blocked: false,
  ...over,
});

describe("suggestOverlap", () => {
  it("nudges the awake twin's nap to overlap the sleeping twin (≥30 min gain)", () => {
    // Ada asleep until 12:30. Bo's nap planned 13:00–14:30 → no overlap.
    // Pull Bo earlier (within 12:00–13:00 window) so the nap starts during Ada's
    // remaining sleep → real overlap gain.
    const ada = win({ babyId: 1, next: null, asleepUntil: { expected: at(12, 30) } });
    const bo = win({
      babyId: 2,
      next: { kind: "nap", plannedStart: at(13), durationMin: 90 },
      window: { earliest: at(12), latest: at(13, 30) },
    });

    const s = suggestOverlap(ada, bo, NOW);
    expect(s?.babyId).toBe(2);
    expect(s!.deltaMin).toBeLessThan(0); // earlier
    expect(s!.projectedOverlapMin).toBeGreaterThanOrEqual(MIN_OVERLAP_GAIN_MIN);
    expect(new Date(s!.to).getTime()).toBeLessThanOrEqual(new Date(at(12, 30)).getTime());
  });

  it("returns null when no nudge clears the gain threshold", () => {
    // Two naps already nearly aligned — only a few minutes of possible gain.
    const ada = win({ babyId: 1, next: { kind: "nap", plannedStart: at(12), durationMin: 90 } });
    const bo = win({ babyId: 2, next: { kind: "nap", plannedStart: at(12, 5), durationMin: 90 } });
    expect(suggestOverlap(ada, bo, NOW)).toBeNull();
  });

  it("never nudges outside the acceptable window", () => {
    // Ada asleep until 14:00. Bo's nap planned 13:00 but window only allows
    // 12:45–13:15 — the nudge must stay within that even if earlier would help.
    const ada = win({ babyId: 1, next: null, asleepUntil: { expected: at(14) } });
    const bo = win({
      babyId: 2,
      next: { kind: "nap", plannedStart: at(13), durationMin: 90 },
      window: { earliest: at(12, 45), latest: at(13, 15) },
      maxNudgeMin: 90,
    });
    const s = suggestOverlap(ada, bo, NOW);
    if (s) {
      const to = new Date(s.to).getTime();
      expect(to).toBeGreaterThanOrEqual(new Date(at(12, 45)).getTime());
      expect(to).toBeLessThanOrEqual(new Date(at(13, 15)).getTime());
    }
  });

  it("respects the max-nudge (one cycle) bound", () => {
    const ada = win({ babyId: 1, next: null, asleepUntil: { expected: at(11) } });
    const bo = win({
      babyId: 2,
      next: { kind: "nap", plannedStart: at(13), durationMin: 90 },
      window: { earliest: at(9), latest: at(13) },
      maxNudgeMin: 30, // can only move 30 min even though window is wider
    });
    const s = suggestOverlap(ada, bo, NOW);
    if (s) expect(Math.abs(s.deltaMin)).toBeLessThanOrEqual(30);
  });

  it("never suggests when either baby is blocked", () => {
    const ada = win({ babyId: 1, next: null, asleepUntil: { expected: at(13) } });
    const bo = win({ babyId: 2, blocked: true, next: { kind: "nap", plannedStart: at(13), durationMin: 90 } });
    expect(suggestOverlap(ada, bo, NOW)).toBeNull();
    expect(suggestOverlap({ ...ada, blocked: true }, { ...bo, blocked: false }, NOW)).toBeNull();
  });

  it("never moves a sleeping baby (both asleep → null)", () => {
    const ada = win({ babyId: 1, next: null, asleepUntil: { expected: at(12) } });
    const bo = win({ babyId: 2, next: null, asleepUntil: { expected: at(13) } });
    expect(suggestOverlap(ada, bo, NOW)).toBeNull();
  });

  it("never nudges a start into the past", () => {
    // Bo's window opens at 09:00 (before now=10:00) but the nudge can't put the
    // nap before now.
    const ada = win({ babyId: 1, next: null, asleepUntil: { expected: at(11) } });
    const bo = win({
      babyId: 2,
      next: { kind: "nap", plannedStart: at(12), durationMin: 90 },
      window: { earliest: at(9), latest: at(12, 30) },
    });
    const s = suggestOverlap(ada, bo, NOW);
    if (s) expect(new Date(s.to).getTime()).toBeGreaterThanOrEqual(NOW);
  });

  it("on a tie, the more-flexible (larger SD) baby yields", () => {
    // Both awake, symmetric naps that can each move to the same overlap. Bo has
    // the noisier rhythm (larger SD / wider window), so Bo is the one nudged —
    // Ada's steadier rhythm is left undisturbed.
    const ada = win({
      babyId: 1,
      next: { kind: "nap", plannedStart: at(12), durationMin: 90 },
      window: { earliest: at(11), latest: at(13, 30) },
      sdMinutes: 8,
    });
    const bo = win({
      babyId: 2,
      next: { kind: "nap", plannedStart: at(13), durationMin: 90 },
      window: { earliest: at(11, 30), latest: at(14) },
      sdMinutes: 25,
    });
    const s = suggestOverlap(ada, bo, NOW);
    expect(s?.babyId).toBe(2);
  });
});
