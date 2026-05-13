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
  shineDaytimeSleepMinutes,
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

/** Like `sleep`, but with a wake reason recorded. */
function napWith(start: string, end: string, wokeBy: "self" | "woken"): SleepEntry {
  return { start_time: start, end_time: end, type: "nap", woke_by: wokeBy };
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

// ─── shineDaytimeSleepMinutes ───────────────────────────────────────────────
//
// Direct sanity checks on the SHINE interpolation. The age bands come from
// SHINE 2021 actigraphy medians (1, 6, 12, 24 months); ages between bands are
// linearly interpolated. We pin the band points exactly and confirm that
// in-between ages land on the segment.

describe("shineDaytimeSleepMinutes", () => {
  it("hits SHINE band medians exactly", () => {
    expect(shineDaytimeSleepMinutes(1)).toBeCloseTo(212.3);
    expect(shineDaytimeSleepMinutes(6)).toBeCloseTo(140.5);
    expect(shineDaytimeSleepMinutes(12)).toBeCloseTo(125.5);
    expect(shineDaytimeSleepMinutes(24)).toBeCloseTo(120.3);
  });

  it("interpolates linearly between bands", () => {
    expect(shineDaytimeSleepMinutes(9)).toBeCloseTo(133);   // halfway 6mo → 12mo
    expect(shineDaytimeSleepMinutes(10)).toBeCloseTo(130.5); // 2/3 of the way
  });

  it("clamps below 1mo and above 24mo to nearest band", () => {
    expect(shineDaytimeSleepMinutes(0)).toBeCloseTo(212.3);
    expect(shineDaytimeSleepMinutes(36)).toBeCloseTo(120.3);
  });
});

// ─── nap-count-aware default duration ───────────────────────────────────────
//
// The 1-nap-vs-2-nap distinction is the real bug-driver: a 10mo on a single
// long midday nap should not share a duration prior with a 7mo doing two
// shorter naps. Both helpers below build a 7-day fixture matching the napping
// schedule and verify that getLearnedNapDuration responds to it. We do NOT
// pin the exact prior — that depends on cycle snapping — only the relative
// ordering and the floor/ceiling that protect against earlier regressions.

/** 7 days × `napsPerDay`, each ~`napMinutes` long, plus a night entry per day. */
function buildRoutineFixture(napsPerDay: number, napMinutes: number): SleepEntry[] {
  const sleeps: SleepEntry[] = [];
  for (let d = 19; d <= 25; d++) {
    let napStartHour = 8;
    for (let n = 0; n < napsPerDay; n++) {
      const startMin = napMinutes;
      sleeps.push(sleep(day(d, napStartHour, 0), day(d, napStartHour + Math.floor(startMin / 60), startMin % 60)));
      napStartHour += 4;
    }
    sleeps.push(sleep(day(d, 19, 0), day(d + 1, 6, 0), "night"));
  }
  return sleeps;
}

describe("getLearnedNapDuration: nap-count-aware default", () => {
  it("1-nap baby gets a longer prior than 2-nap baby of the same age", () => {
    const oneNap = ctx(10, []);
    oneNap.customNapCount = 1;
    const twoNap = ctx(10, []);
    twoNap.customNapCount = 2;

    expect(getLearnedNapDuration(oneNap)).toBeGreaterThan(getLearnedNapDuration(twoNap));
  });

  it("a 10mo with no recent data gets a sensible 1-nap prior (≥100 min)", () => {
    // Pre-fix: the hardcoded fallback returned 45 regardless of nap count, which
    // collapsed predictions for transitioned 1-nap babies. SHINE 10mo daytime
    // sleep is ~131 min; per-nap with napCount=1 should be in that ballpark.
    const learnedNapCount1 = ctx(10, []);
    learnedNapCount1.customNapCount = 1;

    expect(getLearnedNapDuration(learnedNapCount1)).toBeGreaterThanOrEqual(100);
  });

  it("respects customNapCount when there's no learned data", () => {
    const c2 = ctx(10, []);
    c2.customNapCount = 2;
    const c1 = ctx(10, []);
    c1.customNapCount = 1;

    // 2-nap default should be roughly half the 1-nap default.
    const ratio = getLearnedNapDuration(c1) / getLearnedNapDuration(c2);
    expect(ratio).toBeGreaterThan(1.5);
    expect(ratio).toBeLessThan(2.5);
  });

  it("learns from real data and blends toward it", () => {
    // 7 days × 1 nap × 110 min: a 10mo whose actual nap length is 110 min
    // should get a learned duration close to that.
    const oneNapCtx = ctx(10, buildRoutineFixture(1, 110));
    oneNapCtx.customNapCount = 1;

    const learned = getLearnedNapDuration(oneNapCtx);
    expect(learned).toBeGreaterThanOrEqual(105);
    expect(learned).toBeLessThanOrEqual(125);
  });

  it("Halldis prod-DB scenario: the bug case lifts above the 77 min ceiling", () => {
    // The exact 7-day window the engine saw on 2026-04-29 (durations in
    // minutes, in chronological order). With the old hardcoded 45 min default
    // and no woke_by plumbing, this produced a 77 min prediction. After fix A
    // alone it should land north of 95 — closer to the natural distribution of
    // self-wake naps (99, 125 min).
    const halldis: SleepEntry[] = [
      sleep(day(23,  7, 25), day(23,  9, 30)),                // 125
      sleep(day(24,  8, 28), day(24,  9,  9)),                // 41
      sleep(day(24, 19,  0), day(25,  6,  0), "night"),
      sleep(day(25,  8,  0), day(25, 10,  0)),                // 120
      sleep(day(25, 19,  0), day(26,  6,  0), "night"),
      sleep(day(26,  8, 42), day(26,  9, 30)),                // 48
      sleep(day(26, 19,  0), day(27,  6,  0), "night"),
      sleep(day(27,  7, 28), day(27,  9,  8)),                // 99 (rounded)
      sleep(day(27, 19,  0), day(28,  6,  0), "night"),
      sleep(day(28,  7, 23), day(28,  9,  8)),                // 104 (rounded)
      sleep(day(28, 19,  0), day(29,  6,  0), "night"),
    ];
    // Add nights for the early days too so all 6 naps qualify as "complete".
    halldis.unshift(sleep(day(22, 19, 0), day(23, 6, 0), "night"));
    halldis.splice(2, 0, sleep(day(23, 19, 0), day(24, 6, 0), "night"));

    const halldisCtx = ctx(10, halldis);
    halldisCtx.customNapCount = 1;

    const learned = getLearnedNapDuration(halldisCtx);
    expect(learned).toBeGreaterThan(95);
  });
});

// ─── right-censoring of cut-short woken naps ────────────────────────────────
//
// "woke_by='woken'" means the parent ended the sleep, not the baby. If the
// nap was clearly cut short (below the baby's own self-wake median) the
// observation is a *lower bound* on natural duration, not a sample of it —
// treating it as a sample shrinks the learned mean. We drop those, but keep
// long parent-ended naps because they were probably done anyway.

describe("getLearnedNapDuration: right-censors cut-short parent-ended naps", () => {
  /** 7 days of one-nap-per-day with given (duration, woke_by) for each day. */
  function napCtx(rows: Array<{ dur: number; wokeBy: "self" | "woken" }>): BabyContext {
    const sleeps: SleepEntry[] = [];
    rows.forEach((r, i) => {
      const d = 19 + i;
      const startH = 8;
      const endH = startH + Math.floor(r.dur / 60);
      const endM = r.dur % 60;
      sleeps.push(napWith(day(d, startH, 0), day(d, endH, endM), r.wokeBy));
      sleeps.push(sleep(day(d, 19, 0), day(d + 1, 6, 0), "night"));
    });
    const c = ctx(10, sleeps);
    c.customNapCount = 1;
    return c;
  }

  it("drops short cut-short naps and lifts the learned duration", () => {
    // Halldis-shaped: 4 self-wakes around 100-125 min, mixed with two
    // obvious cut-shorts at 41 and 48 min (both < the self-wake median).
    const censored = napCtx([
      { dur: 125, wokeBy: "self" },
      { dur: 110, wokeBy: "self" },
      { dur: 41,  wokeBy: "woken" },  // cut short
      { dur: 100, wokeBy: "self" },
      { dur: 48,  wokeBy: "woken" },  // cut short
      { dur: 99,  wokeBy: "self" },
      { dur: 104, wokeBy: "woken" },  // long, kept
    ]);
    // Same data with woke_by stripped — the cut-shorts contaminate the mean.
    const uncensored = napCtx([
      { dur: 125, wokeBy: "self" },
      { dur: 110, wokeBy: "self" },
      { dur: 41,  wokeBy: "self" },
      { dur: 100, wokeBy: "self" },
      { dur: 48,  wokeBy: "self" },
      { dur: 99,  wokeBy: "self" },
      { dur: 104, wokeBy: "self" },
    ]);

    expect(getLearnedNapDuration(censored)).toBeGreaterThan(getLearnedNapDuration(uncensored));
  });

  it("keeps long parent-ended naps (≥ self-median)", () => {
    // 5 self-wakes around 100, plus one 120-min "woken" nap.
    // Self-median = 100. The 120-min woken nap should be kept, so the
    // learned average should exceed 100 (the self-only mean).
    const withLongWoken = napCtx([
      { dur: 100, wokeBy: "self" },
      { dur:  98, wokeBy: "self" },
      { dur: 102, wokeBy: "self" },
      { dur: 100, wokeBy: "self" },
      { dur: 100, wokeBy: "self" },
      { dur: 120, wokeBy: "woken" },  // long, should NOT be censored
    ]);

    expect(getLearnedNapDuration(withLongWoken)).toBeGreaterThan(102);
  });

  it("cap-respect carve-out: keeps last-of-day woken naps on near-trend days", () => {
    // Halldis-flavoured scenario. Self-median is around 100 min from the
    // older long naps, but recent days the parent has been capping at 60.
    // Day total = 60 nap + 13h night = 13.5h, which clears the 9-12mo
    // age-band min of 12h, so those cap-respect naps must NOT be censored.
    // Previously: every cap-respect 60 min nap got dropped, learned stayed
    // at ~120 forever → engine kept recommending cap from the same stale
    // baseline.
    const withCapRespect = napCtx([
      { dur: 125, wokeBy: "self" },
      { dur: 120, wokeBy: "self" },
      { dur: 110, wokeBy: "self" },
      { dur: 100, wokeBy: "self" },
      // 4 cap-respect days — woken, last (only) nap, 60 min, with a
      // 13h night each via napCtx. Day total = 13h + 60 min = 14h → ≥ age
      // band min.
      { dur:  60, wokeBy: "woken" },
      { dur:  60, wokeBy: "woken" },
      { dur:  60, wokeBy: "woken" },
      { dur:  60, wokeBy: "woken" },
    ]);
    // Counterfactual: same data with the cap-respect naps stripped of
    // their woke_by flag. The old behavior censored those 60 min naps and
    // got a high mean. With the carve-out, the woken=cap-respect data is
    // kept, so the learned mean drops to reflect routine duration.
    const naturalOnly = napCtx([
      { dur: 125, wokeBy: "self" },
      { dur: 120, wokeBy: "self" },
      { dur: 110, wokeBy: "self" },
      { dur: 100, wokeBy: "self" },
    ]);
    expect(getLearnedNapDuration(withCapRespect)).toBeLessThan(
      getLearnedNapDuration(naturalOnly),
    );
  });

  it("cap-respect carve-out: drops short woken naps on sleep-deficit days", () => {
    // Same shape as napCtx (one nap + ~13h night), but the 41-min nap
    // means total day sleep ≈ 11h41m which is BELOW the 9-12mo age-band
    // min (12h). Carve-out doesn't apply → still censored as cut-short.
    // This is the original "obvious cut-short" semantic preserved.
    const censored = napCtx([
      { dur: 125, wokeBy: "self" },
      { dur: 120, wokeBy: "self" },
      { dur: 110, wokeBy: "self" },
      { dur: 100, wokeBy: "self" },
      { dur:  41, wokeBy: "woken" },  // car nap on a sleep-deficit day
    ]);
    const uncensored = napCtx([
      { dur: 125, wokeBy: "self" },
      { dur: 120, wokeBy: "self" },
      { dur: 110, wokeBy: "self" },
      { dur: 100, wokeBy: "self" },
      { dur:  41, wokeBy: "self" },
    ]);
    expect(getLearnedNapDuration(censored)).toBeGreaterThan(
      getLearnedNapDuration(uncensored),
    );
  });

  it("does not filter when there are too few self-wakes for a stable median", () => {
    // Only 2 self-wakes — fewer than the 3 needed for a stable median. The
    // censor should bow out and behave identically to having no woke_by data.
    const withFlag = napCtx([
      { dur: 110, wokeBy: "self" },
      { dur:  90, wokeBy: "self" },
      { dur:  40, wokeBy: "woken" },  // would be censored if median were stable
      { dur:  50, wokeBy: "woken" },
    ]);
    // Same data but with no woke_by attached — wraps everything as plain
    // sleep entries so the engine has no flag to act on.
    const stripped = ctx(10, withFlag.recentSleeps.map((s) => ({
      start_time: s.start_time, end_time: s.end_time, type: s.type,
    })));
    stripped.customNapCount = 1;

    expect(getLearnedNapDuration(withFlag)).toBe(getLearnedNapDuration(stripped));
  });
});
