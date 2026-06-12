import { describe, it, expect } from "bun:test";
import {
  computeSleepPressure,
  computeSleepWindow,
  computeRollingSleepStats,
  computeLongestStretchTrend,
  coalesceNightFragments,
  getAgeNorms,
} from "$lib/engine/features.js";
import { predictNewborn } from "$lib/engine/newborn.js";
import { getWakeWindow } from "$lib/engine/schedule.js";
import type { SleepEntry, BabyContext } from "$lib/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(start: string, end: string, type: "nap" | "night" = "nap"): SleepEntry {
  return { start_time: start, end_time: end, type };
}

function nightWithPauses(
  start: string,
  end: string,
  pauses: Array<[string, string]>,
): SleepEntry {
  return {
    start_time: start,
    end_time: end,
    type: "night",
    pauses: pauses.map(([pause_time, resume_time]) => ({ pause_time, resume_time })),
  };
}

/** Generate wake windows of a specific duration by creating evenly-spaced sleep pairs. */
function makeWakeWindows(count: number, durationMin: number): number[] {
  return Array.from({ length: count }, () => durationMin);
}

/**
 * Build sleep entries that produce specific wake window gaps across multiple days.
 * Each day gets a night entry (required by the schedule engine's complete-day filter)
 * followed by naps with the specified gaps.
 */
function sleepsWithGaps(gaps: number[], baseDate = "2026-03-20"): SleepEntry[] {
  const sleeps: SleepEntry[] = [];
  const gapsPerDay = 3;
  const days = Math.ceil(gaps.length / gapsPerDay);

  let gapIdx = 0;
  for (let d = 0; d < days; d++) {
    const date = new Date(`${baseDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + d);
    const ds = date.toISOString().slice(0, 10);

    // Night entry to make the day "complete"
    sleeps.push(sleep(`${ds}T00:00:00Z`, `${ds}T06:00:00Z`, "night"));

    let cursor = new Date(`${ds}T06:00:00Z`).getTime();
    for (let n = 0; n < gapsPerDay && gapIdx < gaps.length; n++, gapIdx++) {
      cursor += gaps[gapIdx] * 60_000; // wake window gap
      const start = new Date(cursor).toISOString();
      const end = new Date(cursor + 60 * 60_000).toISOString();
      sleeps.push(sleep(start, end, "nap"));
      cursor += 60 * 60_000; // nap duration
    }
  }
  return sleeps;
}

function ctx(overrides: Partial<BabyContext> = {}): BabyContext {
  return {
    birthdate: "2026-01-01",
    ageMonths: 3,
    tz: "UTC",
    customNapCount: null,
    recentSleeps: [],
    ...overrides,
  };
}

// ─── computeSleepPressure: adaptive thresholds ──────────────────────────────

describe("computeSleepPressure — adaptive thresholds", () => {
  const base = new Date("2026-03-25T12:00:00Z").getTime();

  it("uses age defaults when no wake windows provided", () => {
    // Age <1mo: low < 25, high >= 50
    expect(computeSleepPressure(base, 0, base + 10 * 60_000)).toBe("low");
    expect(computeSleepPressure(base, 0, base + 30 * 60_000)).toBe("rising");
    expect(computeSleepPressure(base, 0, base + 55 * 60_000)).toBe("high");
  });

  it("uses age defaults with fewer than 5 wake windows", () => {
    const fewWWs = [40, 50, 60, 70]; // only 4
    expect(computeSleepPressure(base, 0, base + 55 * 60_000, fewWWs)).toBe("high");
  });

  it("blends in baby data with 5+ wake windows", () => {
    // Baby consistently has 80-100 min wake windows — much longer than age <1mo default
    const longWWs = [80, 85, 90, 95, 100];
    // At 5 samples, blend = 0. Still age-based.
    expect(computeSleepPressure(base, 0, base + 55 * 60_000, longWWs)).toBe("high");
  });

  it("fully uses baby data at 15+ samples", () => {
    // Baby consistently has 80-100 min wake windows
    const longWWs = makeWakeWindows(15, 90).map((v, i) => v + (i % 3 - 1) * 10);
    // p25 = ~80, p75 = ~100. At 60min → should be "low" (below baby's own p25)
    expect(computeSleepPressure(base, 0, base + 60 * 60_000, longWWs)).toBe("low");
    // At 95min → "rising" (between p25 and p75)
    expect(computeSleepPressure(base, 0, base + 95 * 60_000, longWWs)).toBe("rising");
    // At 110min → "high" (above p75)
    expect(computeSleepPressure(base, 0, base + 110 * 60_000, longWWs)).toBe("high");
  });

  it("adapts to a short-window baby", () => {
    // Baby who consistently sleeps after just 20-30 min awake
    const shortWWs = Array.from({ length: 15 }, (_, i) => 20 + (i % 3) * 5);
    // p25 ≈ 20, p75 ≈ 30. At 15 samples blend = 1.0
    // At 15min → "low"
    expect(computeSleepPressure(base, 0, base + 15 * 60_000, shortWWs)).toBe("low");
    // At 25min → "rising"
    expect(computeSleepPressure(base, 0, base + 25 * 60_000, shortWWs)).toBe("rising");
    // At 35min → "high"
    expect(computeSleepPressure(base, 0, base + 35 * 60_000, shortWWs)).toBe("high");
  });

  const blendCases: [string, number, number][] = [
    ["5 samples → blend=0 (pure age)", 5, 0],
    ["8 samples → blend=0.3", 8, 0.3],
    ["10 samples → blend=0.5", 10, 0.5],
    ["15 samples → blend=1.0", 15, 1.0],
    ["20 samples → blend=1.0 (capped)", 20, 1.0],
  ];

  for (const [label, n, expectedBlend] of blendCases) {
    it(`blend ramp: ${label}`, () => {
      // Age <1mo: ageLow=25, ageHigh=50
      // Baby: all 80 min → p25=80, p75=80
      const wws = makeWakeWindows(n, 80);
      const low = 25 * (1 - expectedBlend) + 80 * expectedBlend;
      const high = 50 * (1 - expectedBlend) + 80 * expectedBlend;

      // Just below low threshold → low
      if (low > 1) {
        expect(computeSleepPressure(base, 0, base + (low - 1) * 60_000, wws)).toBe("low");
      }
      // Above high threshold → high
      expect(computeSleepPressure(base, 0, base + (high + 1) * 60_000, wws)).toBe("high");
    });
  }
});

// ─── computeSleepWindow: gradual blend ──────────────────────────────────────

describe("computeSleepWindow — gradual blend", () => {
  const base = new Date("2026-03-25T12:00:00Z").getTime();

  it("uses age fallback with 0-2 wake windows", () => {
    // Age <1mo: min=25, max=60
    const result = computeSleepWindow(base, [40, 50], 0);
    expect(result.earliestMs).toBe(base + 25 * 60_000);
    expect(result.latestMs).toBe(base + 60 * 60_000);
  });

  it("at 3 samples uses pure age defaults (blend=0)", () => {
    const result = computeSleepWindow(base, [80, 90, 100], 0);
    // blend = (3-3)/5 = 0, so pure age defaults: min=25, max=60
    expect(result.earliestMs).toBe(base + 25 * 60_000);
    expect(result.latestMs).toBe(base + 60 * 60_000);
  });

  it("at 8 samples fully uses baby data (blend=1.0)", () => {
    const wws = [80, 85, 90, 95, 100, 105, 110, 115];
    const result = computeSleepWindow(base, wws, 0);
    // blend = (8-3)/5 = 1.0
    // sorted: [80,85,90,95,100,105,110,115]
    // p25 = sorted[2] = 90 → babyMin = max(15, 90-10) = 80
    // p75 = sorted[6] = 110 → babyMax = 110+15 = 125
    expect(result.earliestMs).toBe(base + 80 * 60_000);
    expect(result.latestMs).toBe(base + 125 * 60_000);
  });

  it("at 5 samples partially blends (blend=0.4)", () => {
    const wws = [80, 85, 90, 95, 100];
    const result = computeSleepWindow(base, wws, 0);
    // blend = (5-3)/5 = 0.4
    // sorted: [80,85,90,95,100], p25=sorted[1]=85 → babyMin=75, p75=sorted[3]=95 → babyMax=110
    // min = 25*(0.6) + 75*(0.4) = 15 + 30 = 45
    // max = 60*(0.6) + 110*(0.4) = 36 + 44 = 80
    expect(Math.round((result.earliestMs - base) / 60_000)).toBe(45);
    expect(Math.round((result.latestMs - base) / 60_000)).toBe(80);
  });

  it("respects age-appropriate defaults for different ages", () => {
    // 3-month-old age defaults: min=50, max=90
    const result = computeSleepWindow(base, [], 3);
    expect(result.earliestMs).toBe(base + 60 * 60_000); // ageMonths 3 → min=60
    expect(result.latestMs).toBe(base + 120 * 60_000);  // ageMonths 3 → max=120
  });
});

// ─── getAgeNorms: Galland wide ranges ───────────────────────────────────────

describe("getAgeNorms — Galland ranges for display", () => {
  const cases: [string, number, { min: number; max: number; typical: number }][] = [
    ["0-2 months", 0, { min: 9.3, max: 20.0, typical: 16.5 }],
    ["0-2 months (1mo)", 1, { min: 9.3, max: 20.0, typical: 15.5 }],
    ["3 months", 3, { min: 9.4, max: 17.8, typical: 15 }],
    ["6 months", 6, { min: 8.8, max: 17.0, typical: 14 }],
    ["9 months", 9, { min: 9.4, max: 15.8, typical: 14 }],
    ["12 months", 12, { min: 10.1, max: 15.8, typical: 13.5 }],
  ];

  for (const [label, age, expected] of cases) {
    it(label, () => {
      const norms = getAgeNorms(age);
      expect(norms.totalSleepHours.min).toBe(expected.min);
      expect(norms.totalSleepHours.max).toBe(expected.max);
      expect(norms.totalSleepHours.typical).toBe(expected.typical);
    });
  }

  it("uses wider Galland range than SLEEP_NEEDS", () => {
    const norms = getAgeNorms(0);
    // Galland 0-2mo: 9.3-20.0 is much wider than SLEEP_NEEDS 0-1mo: 14-18
    expect(norms.totalSleepHours.min).toBeLessThan(14);
    expect(norms.totalSleepHours.max).toBeGreaterThan(18);
  });
});

// ─── computeExpectedDuration: gradual blend ─────────────────────────────────

describe("predictNewborn expectedDuration — gradual blend", () => {
  it("returns age fallback with fewer than 3 episodes", () => {
    const result = predictNewborn({
      ageMonths: 0, tz: "UTC",
      recentSleeps: [sleep("2026-03-25T10:00:00Z", "2026-03-25T11:00:00Z")],
      lastSleepEndMs: new Date("2026-03-25T11:00:00Z").getTime(),
      now: new Date("2026-03-25T12:00:00Z").getTime(),
    });
    expect(result.expectedDuration.min).toBe(30);
    expect(result.expectedDuration.max).toBe(240); // 0-1 month fallback
  });

  it("blends age and baby data at 3-7 episodes", () => {
    // 4 episodes of ~120 min each
    const sleeps = [
      sleep("2026-03-25T01:00:00Z", "2026-03-25T03:00:00Z"),
      sleep("2026-03-25T04:00:00Z", "2026-03-25T06:00:00Z"),
      sleep("2026-03-25T07:00:00Z", "2026-03-25T09:00:00Z"),
      sleep("2026-03-25T10:00:00Z", "2026-03-25T12:00:00Z"),
    ];
    const result = predictNewborn({
      ageMonths: 0, tz: "UTC", recentSleeps: sleeps,
      lastSleepEndMs: new Date("2026-03-25T12:00:00Z").getTime(),
      now: new Date("2026-03-25T13:00:00Z").getTime(),
    });

    // 4 episodes → blend = (4-3)/5 = 0.2
    // Baby data: all ~120min, so p15≈p85≈120
    // babyMin = max(10, 120-10) = 110, babyMax = 120+15 = 135
    // min = 30*0.8 + 110*0.2 = 24+22 = 46
    // max = 240*0.8 + 135*0.2 = 192+27 = 219
    // These are blended — not pure age defaults, not pure baby data
    expect(result.expectedDuration.min).toBeGreaterThan(30); // moved toward baby
    expect(result.expectedDuration.max).toBeLessThan(240);   // moved toward baby
  });

  it("fully uses baby data at 8+ episodes", () => {
    // 9 episodes of ~45 min each
    const sleeps = Array.from({ length: 9 }, (_, i) => {
      const h = 1 + i * 2;
      const start = `2026-03-25T${String(h).padStart(2, "0")}:00:00Z`;
      const end = `2026-03-25T${String(h).padStart(2, "0")}:45:00Z`;
      return sleep(start, end);
    });
    const result = predictNewborn({
      ageMonths: 0, tz: "UTC", recentSleeps: sleeps,
      lastSleepEndMs: new Date("2026-03-25T17:45:00Z").getTime(),
      now: new Date("2026-03-25T18:30:00Z").getTime(),
    });

    // 9 episodes → blend = (9-3)/5 = 1.0
    // All ~45min → babyMin ≈ max(10, 45-10)=35, babyMax ≈ 45+15=60
    expect(result.expectedDuration.min).toBeGreaterThanOrEqual(30);
    expect(result.expectedDuration.min).toBeLessThan(50);
    expect(result.expectedDuration.max).toBeLessThan(80);
  });
});

// ─── Wake window clamp: emerging_rhythm widens ──────────────────────────────

describe("getWakeWindow — emerging_rhythm clamp widening", () => {
  it("routine_schedule uses standard clamp range", () => {
    // 3-month-old age range: 75-120 min
    const c = ctx({
      ageMonths: 3,
      strategy: "routine_schedule",
      recentSleeps: sleepsWithGaps(
        // Wake windows consistently at 130 min (above age max of 120)
        [130, 130, 130, 130, 130, 130, 130],
      ),
    });
    const ww = getWakeWindow(c);
    // Should be clamped to 120 (age max)
    expect(ww).toBeLessThanOrEqual(120);
  });

  it("emerging_rhythm widens clamp for above-range babies", () => {
    const c = ctx({
      ageMonths: 3,
      strategy: "emerging_rhythm",
      recentSleeps: sleepsWithGaps(
        [130, 130, 130, 130, 130, 130, 130],
      ),
    });
    const ww = getWakeWindow(c);
    // Should allow above 120 due to widened clamp
    expect(ww).toBeGreaterThan(120);
  });

  it("emerging_rhythm widens clamp for below-range babies", () => {
    const c = ctx({
      ageMonths: 3,
      strategy: "emerging_rhythm",
      recentSleeps: sleepsWithGaps(
        // Wake windows at 65 min (below age min of 75)
        [65, 65, 65, 65, 65, 65, 65],
      ),
    });
    const ww = getWakeWindow(c);
    // Should allow below 75 due to widened clamp
    expect(ww).toBeLessThan(75);
  });
});

// ─── Integration: adaptive newborn for different baby types ─────────────────

describe("adaptive newborn — different baby types", () => {
  it("long-wake baby gets appropriate pressure thresholds", () => {
    // A newborn who stays awake 70-90 min between sleeps
    const sleeps = sleepsWithGaps(
      Array.from({ length: 16 }, (_, i) => 70 + (i % 3) * 10),
    );
    const lastEnd = new Date(sleeps[sleeps.length - 1].end_time!).getTime();
    const result = predictNewborn({
      ageMonths: 0, tz: "UTC", recentSleeps: sleeps,
      lastSleepEndMs: lastEnd,
      now: lastEnd + 60 * 60_000, // 60 min awake
    });

    // With age-only defaults, 60 min = "high" for a newborn
    // But this baby's pattern says 60 min is normal → should be "low" or "rising"
    expect(result.sleepPressure).not.toBe("high");
  });

  it("short-wake baby gets earlier pressure signals", () => {
    // A newborn who needs sleep after just 25-35 min
    const sleeps = sleepsWithGaps(
      Array.from({ length: 16 }, (_, i) => 25 + (i % 3) * 5),
    );
    const lastEnd = new Date(sleeps[sleeps.length - 1].end_time!).getTime();
    const result = predictNewborn({
      ageMonths: 0, tz: "UTC", recentSleeps: sleeps,
      lastSleepEndMs: lastEnd,
      now: lastEnd + 40 * 60_000, // 40 min awake
    });

    // With age-only defaults, 40min would be "rising" for a newborn
    // But this baby's p75 ≈ 35min → 40 min should be "high"
    expect(result.sleepPressure).toBe("high");
  });

  it("sleep window narrows as baby data accumulates", () => {
    const base = new Date("2026-03-25T12:00:00Z").getTime();

    // With only 2 observations: pure age fallback
    const narrow2 = computeSleepWindow(base, [50, 55], 0);
    const range2 = (narrow2.latestMs - narrow2.earliestMs) / 60_000;

    // With 8 consistent observations: fully baby-driven
    const narrow8 = computeSleepWindow(base, [50, 52, 48, 55, 50, 53, 49, 51], 0);
    const range8 = (narrow8.latestMs - narrow8.earliestMs) / 60_000;

    // Baby with consistent 50min windows should have a narrower window than age defaults
    expect(range8).toBeLessThan(range2);
  });
});

// ─── pause-aware newborn metrics ────────────────────────────────────────────

describe("computeRollingSleepStats — pause-aware", () => {
  // One consolidated night with a 60-min waking in the middle.
  const night = nightWithPauses(
    "2026-03-20T23:00:00Z",
    "2026-03-21T07:00:00Z",
    [["2026-03-21T02:00:00Z", "2026-03-21T03:00:00Z"]],
  );
  const now = new Date("2026-03-21T08:00:00Z").getTime();

  it("nets the waking out of the 24h total", () => {
    const stats = computeRollingSleepStats([night], "UTC", now);
    // 480 min span − 60 min awake = 420 min asleep
    expect(stats.totalSleep24h).toBe(420);
  });

  it("longest stretch is the longest segment between wakings, not the full span", () => {
    const stats = computeRollingSleepStats([night], "UTC", now);
    // segments are 23:00–02:00 (180) and 03:00–07:00 (240) → 240, not 480
    expect(stats.longestStretch).toBe(240);
  });

  it("falls back to full duration when there are no pauses", () => {
    const plain = sleep("2026-03-21T01:00:00Z", "2026-03-21T05:00:00Z", "night");
    const stats = computeRollingSleepStats([plain], "UTC", now);
    expect(stats.longestStretch).toBe(240);
    expect(stats.totalSleep24h).toBe(240);
  });

  it("treats an open waking on an active night as awake until now", () => {
    // Active night 22:00 → (now 23:00), baby woke at 22:30 and is still up.
    const refNow = new Date("2026-03-21T23:00:00Z").getTime();
    const active: SleepEntry = {
      start_time: "2026-03-21T22:00:00Z",
      end_time: null,
      type: "night",
      pauses: [{ pause_time: "2026-03-21T22:30:00Z", resume_time: null }],
    };
    const stats = computeRollingSleepStats([active], "UTC", refNow);
    // 22:00–22:30 asleep = 30, the open waking 22:30→now is awake.
    expect(stats.totalSleep24h).toBe(30);
    expect(stats.longestStretch).toBe(30);
  });

  it("does not double-count overlapping wakings", () => {
    const overlapped = nightWithPauses(
      "2026-03-21T00:00:00Z",
      "2026-03-21T02:00:00Z",
      [
        ["2026-03-21T00:30:00Z", "2026-03-21T01:15:00Z"],
        ["2026-03-21T01:00:00Z", "2026-03-21T01:30:00Z"],
      ],
    );
    const stats = computeRollingSleepStats([overlapped], "UTC", now);
    // Union of the two wakings is 00:30–01:30 = 60 awake; 120 − 60 = 60 asleep.
    expect(stats.totalSleep24h).toBe(60);
    // Longest segment is the post-waking tail 01:30–02:00 = 30.
    expect(stats.longestStretch).toBe(30);
  });

  it("does not double-count two overlapping night episodes in the 24h total", () => {
    // Umi's id5/id7 noise: a long night that fully contains a second night row.
    const long = sleep("2026-03-20T23:00:00Z", "2026-03-21T07:00:00Z", "night");
    const contained = sleep("2026-03-21T05:00:00Z", "2026-03-21T07:00:00Z", "night");
    const stats = computeRollingSleepStats([long, contained], "UTC", now);
    // Union is the 480m night, not 480 + 120.
    expect(stats.totalSleep24h).toBe(480);
    expect(stats.episodeCount).toBe(2);
    expect(stats.longestStretch).toBe(480);
  });

  it("unions partially overlapping episodes in the 24h total", () => {
    const a = sleep("2026-03-20T23:00:00Z", "2026-03-21T02:00:00Z", "night");
    const b = sleep("2026-03-21T01:00:00Z", "2026-03-21T04:00:00Z", "night");
    const stats = computeRollingSleepStats([a, b], "UTC", now);
    // 23:00–04:00 union = 300, not 180 + 180.
    expect(stats.totalSleep24h).toBe(300);
  });

  it("keeps episodeCount/mean as raw per-row metrics even when rows overlap", () => {
    // The total is de-duplicated (union), but episodeCount and mean stay
    // per-logged-row — two overlapping rows read as 2 episodes whose mean is
    // their gross average. Pinned so the mixed semantic is explicit.
    const long = sleep("2026-03-20T23:00:00Z", "2026-03-21T07:00:00Z", "night");
    const contained = sleep("2026-03-21T05:00:00Z", "2026-03-21T07:00:00Z", "night");
    const stats = computeRollingSleepStats([long, contained], "UTC", now);
    expect(stats.episodeCount).toBe(2);
    expect(stats.meanEpisodeDuration).toBe(300); // (480 + 120) / 2
  });

  it("drops a fully-paused episode (no asleep time) from total and count", () => {
    const allAwake = nightWithPauses(
      "2026-03-21T00:00:00Z",
      "2026-03-21T02:00:00Z",
      [["2026-03-21T00:00:00Z", "2026-03-21T02:00:00Z"]],
    );
    const stats = computeRollingSleepStats([allAwake], "UTC", now);
    expect(stats.totalSleep24h).toBe(0);
    expect(stats.episodeCount).toBe(0);
  });

  it("unions exactly-touching episodes without gap or overlap", () => {
    const a = sleep("2026-03-20T23:00:00Z", "2026-03-21T01:00:00Z", "night");
    const b = sleep("2026-03-21T01:00:00Z", "2026-03-21T02:00:00Z", "night");
    const stats = computeRollingSleepStats([a, b], "UTC", now);
    expect(stats.totalSleep24h).toBe(180);
  });

  it("resolves a duplicate row covering an open waking's gap as asleep", () => {
    // Contradictory data: an active night says awake 22:30→now, a separate
    // completed row says asleep 22:30→23:00. The union trusts the explicit
    // sleep row and fills the gap — documented, not a silent bug.
    const refNow = new Date("2026-03-21T23:00:00Z").getTime();
    const active: SleepEntry = {
      start_time: "2026-03-21T22:00:00Z",
      end_time: null,
      type: "night",
      pauses: [{ pause_time: "2026-03-21T22:30:00Z", resume_time: null }],
    };
    const dup = sleep("2026-03-21T22:30:00Z", "2026-03-21T23:00:00Z", "night");
    const stats = computeRollingSleepStats([active, dup], "UTC", refNow);
    expect(stats.totalSleep24h).toBe(60);
  });

  it("nets a waking that straddles the 24h window boundary", () => {
    // 24h cutoff is 2026-03-20T10:00Z. Night 09:30→11:00 straddles it, with a
    // waking 09:45→10:15 that also straddles the cutoff.
    const refNow = new Date("2026-03-21T10:00:00Z").getTime();
    const straddleNight = nightWithPauses(
      "2026-03-20T09:30:00Z",
      "2026-03-20T11:00:00Z",
      [["2026-03-20T09:45:00Z", "2026-03-20T10:15:00Z"]],
    );
    const stats = computeRollingSleepStats([straddleNight], "UTC", refNow);
    // Clipped span 10:00–11:00 = 60. Waking overlap inside window 10:00–10:15
    // = 15. Net = 45.
    expect(stats.totalSleep24h).toBe(45);
  });
});

describe("computeLongestStretchTrend — pause-aware", () => {
  it("uses the longest segment between wakings for the daily longest", () => {
    // Two recent nights, each one long span broken by a 60-min waking.
    const nights = [
      nightWithPauses("2026-03-20T23:00:00Z", "2026-03-21T07:00:00Z",
        [["2026-03-21T02:00:00Z", "2026-03-21T03:00:00Z"]]),
      nightWithPauses("2026-03-21T23:00:00Z", "2026-03-22T07:00:00Z",
        [["2026-03-22T02:00:00Z", "2026-03-22T03:00:00Z"]]),
    ];
    const now = new Date("2026-03-22T08:00:00Z").getTime();
    const trend = computeLongestStretchTrend(nights, "UTC", now);
    // Each night's longest segment is 240 (03:00–07:00), not 480.
    expect(trend.currentWeekAvg).toBe(240);
  });
});

// ─── read-side coalescing of fragmented nights ──────────────────────────────

describe("coalesceNightFragments", () => {
  it("merges adjacent night fragments into one logical night with derived pauses", () => {
    const fragmented = [
      sleep("2026-03-20T23:00:00Z", "2026-03-21T02:00:00Z", "night"),
      sleep("2026-03-21T02:45:00Z", "2026-03-21T07:00:00Z", "night"),
    ];
    const out = coalesceNightFragments(fragmented);
    expect(out).toHaveLength(1);
    expect(out[0].start_time).toBe("2026-03-20T23:00:00Z");
    expect(out[0].end_time).toBe("2026-03-21T07:00:00Z");
    expect(out[0].pauses).toEqual([
      { pause_time: "2026-03-21T02:00:00Z", resume_time: "2026-03-21T02:45:00Z" },
    ]);
  });

  it("does not merge when the awake gap exceeds the threshold", () => {
    const separate = [
      sleep("2026-03-20T23:00:00Z", "2026-03-21T01:00:00Z", "night"),
      sleep("2026-03-21T03:30:00Z", "2026-03-21T07:00:00Z", "night"), // 2.5h gap
    ];
    expect(coalesceNightFragments(separate)).toHaveLength(2);
  });

  it("does not merge across an intervening nap", () => {
    const withNap = [
      sleep("2026-03-21T01:00:00Z", "2026-03-21T02:00:00Z", "night"),
      sleep("2026-03-21T02:10:00Z", "2026-03-21T02:40:00Z", "nap"),
      sleep("2026-03-21T02:50:00Z", "2026-03-21T05:00:00Z", "night"),
    ];
    expect(coalesceNightFragments(withNap)).toHaveLength(3);
  });

  it("chains three or more consecutive fragments into one night", () => {
    const fragmented = [
      sleep("2026-03-20T21:00:00Z", "2026-03-20T23:30:00Z", "night"),
      sleep("2026-03-20T23:50:00Z", "2026-03-21T03:00:00Z", "night"), // 20m gap
      sleep("2026-03-21T03:30:00Z", "2026-03-21T06:30:00Z", "night"), // 30m gap
    ];
    const out = coalesceNightFragments(fragmented);
    expect(out).toHaveLength(1);
    expect(out[0].start_time).toBe("2026-03-20T21:00:00Z");
    expect(out[0].end_time).toBe("2026-03-21T06:30:00Z");
    expect(out[0].pauses).toEqual([
      { pause_time: "2026-03-20T23:30:00Z", resume_time: "2026-03-20T23:50:00Z" },
      { pause_time: "2026-03-21T03:00:00Z", resume_time: "2026-03-21T03:30:00Z" },
    ]);
  });

  it("merges a closed fragment into a following open one without chaining past it", () => {
    // Active night is always the latest by start in valid data, so an open
    // fragment ends the chain: merge into it, then stop.
    const entries: SleepEntry[] = [
      sleep("2026-03-21T21:00:00Z", "2026-03-21T23:30:00Z", "night"),
      { start_time: "2026-03-21T23:50:00Z", end_time: null, type: "night" },
    ];
    const out = coalesceNightFragments(entries);
    expect(out).toHaveLength(1);
    expect(out[0].start_time).toBe("2026-03-21T21:00:00Z");
    expect(out[0].end_time).toBeNull();
    expect(out[0].pauses).toEqual([
      { pause_time: "2026-03-21T23:30:00Z", resume_time: "2026-03-21T23:50:00Z" },
    ]);
  });

  it("keeps a trailing open fragment open", () => {
    const fragmented: SleepEntry[] = [
      sleep("2026-03-21T23:00:00Z", "2026-03-22T00:25:00Z", "night"),
      { start_time: "2026-03-22T00:56:00Z", end_time: null, type: "night" },
    ];
    const out = coalesceNightFragments(fragmented);
    expect(out).toHaveLength(1);
    expect(out[0].end_time).toBeNull();
  });

  it("leaves overlapping night rows alone (handled by the union total)", () => {
    const overlapping = [
      sleep("2026-03-20T23:00:00Z", "2026-03-21T07:00:00Z", "night"),
      sleep("2026-03-21T05:00:00Z", "2026-03-21T07:00:00Z", "night"),
    ];
    expect(coalesceNightFragments(overlapping)).toHaveLength(2);
  });

  it("INVARIANT: fragmented and consolidated nights yield identical metrics", () => {
    const now = new Date("2026-03-21T08:00:00Z").getTime();
    // Consolidated: one night with a 45-min night_waking.
    const consolidated = [
      nightWithPauses("2026-03-20T23:00:00Z", "2026-03-21T07:00:00Z",
        [["2026-03-21T02:00:00Z", "2026-03-21T02:45:00Z"]]),
    ];
    // Fragmented: same night logged as two rows split by that 45-min gap.
    const fragmented = [
      sleep("2026-03-20T23:00:00Z", "2026-03-21T02:00:00Z", "night"),
      sleep("2026-03-21T02:45:00Z", "2026-03-21T07:00:00Z", "night"),
    ];

    const a = computeRollingSleepStats(consolidated, "UTC", now);
    const b = computeRollingSleepStats(coalesceNightFragments(fragmented), "UTC", now);
    expect(b.totalSleep24h).toBe(a.totalSleep24h);
    expect(b.longestStretch).toBe(a.longestStretch);
  });
});
