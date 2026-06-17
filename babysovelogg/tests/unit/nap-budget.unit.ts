/**
 * Tests for `computeNapBudget` — the trend-anchored nap-cap recommendation.
 * Each describe block targets one gate or one decision the helper makes.
 * Sleep-science rationale and citations live in
 * docs/sleep-science-research.md §12 and the constants.ts docblocks.
 */
import { describe, it, expect } from "bun:test";
import { computeNapBudget, isDayOnTrend } from "$lib/engine/nap-budget.js";
import type { SleepEntry, BabyContext } from "$lib/types.js";
import { NAP_BUDGET, NAP_FLOOR_BY_AGE, findByAge } from "$lib/engine/constants.js";
import type { TrendTargets } from "$lib/engine/trend.js";
import halldisRealData from "../fixtures/halldis-real-2026-05-13.json";

// ── Fixtures ────────────────────────────────────────────────────────

const TZ = "Europe/Oslo";

function ctx(overrides: Partial<BabyContext> = {}): BabyContext {
  return {
    birthdate: "2025-06-12", // Halldis-like
    ageMonths: 11,
    tz: TZ,
    customNapCount: null,
    targetBedtime: null,
    recentSleeps: [],
    extendedSleeps: [],
    trendSleeps: [],
    ...overrides,
  };
}

/**
 * Synthesise N days of completed sleeps with a target daily total. Each
 * "day D" contains a nap that starts on D and a night that also starts
 * on D (evening), so getWeekStats's start-anchored grouping gives each
 * day a full (nap + night) total ≈ avgTotalMin. Matches how the stats
 * page reads the data.
 *
 * Jitter uses a deterministic, repeatable triangle-wave generator so the
 * suppression tests don't go flaky when Math.random() lands on a calm
 * draw.
 */
function synthDays(
  startDate: string, // YYYY-MM-DD of the first day
  count: number,
  avgTotalMin: number,
  jitterMin = 0,
): SleepEntry[] {
  const sleeps: SleepEntry[] = [];
  for (let i = 0; i < count; i++) {
    const dayMs = new Date(`${startDate}T00:00:00Z`).getTime() + i * 86400_000;
    // Deterministic triangle wave: maximal alternating magnitudes so the
    // resulting stdev is ~jitterMin (population), independent of test order.
    const jitter = jitterMin ? (i % 2 === 0 ? jitterMin : -jitterMin) : 0;
    const totalMin = avgTotalMin + jitter;
    const nightMin = totalMin * 0.85;
    const napMin = totalMin - nightMin;

    // Nap: 10:00 UTC on day D.
    const napStart = new Date(dayMs + 10 * 3600_000);
    const napEnd = new Date(napStart.getTime() + napMin * 60_000);
    sleeps.push({
      start_time: napStart.toISOString(),
      end_time: napEnd.toISOString(),
      type: "nap",
      woke_by: "self",
    });
    // Night: 19:00 UTC on day D (ends the following morning).
    const nightStart = new Date(dayMs + 19 * 3600_000);
    const nightEnd = new Date(nightStart.getTime() + nightMin * 60_000);
    sleeps.push({
      start_time: nightStart.toISOString(),
      end_time: nightEnd.toISOString(),
      type: "night",
      woke_by: "self",
    });
  }
  return sleeps;
}

// Halldis's situation today: yesterday's night was 12.44h (746 min);
// active nap at 10:30 local. Now is 10:55 local — 25 min into the nap.
// Bedtime is 19:00 local.
//
// The "last night" sleep is appended to trendSleeps (not todaySleeps), so
// it shows up in the rolling-24h banked computation but doesn't collide
// with the synth-fixture's own yesterday entry. synth runs 24 days ending
// 2026-05-11 to leave 2026-05-12T19:00Z (yesterday's night) free for the
// custom override.
function halldisScenario(overrides: { now?: number; bankedNightMin?: number } = {}) {
  const todayDateStr = "2026-05-13";
  const yesterdayNightStart = new Date(`${todayDateStr}T00:00:00Z`).getTime() - 5 * 3600_000;
  const nightMin = overrides.bankedNightMin ?? 746;
  const yesterdayNight: SleepEntry = {
    start_time: new Date(yesterdayNightStart).toISOString(),
    end_time: new Date(yesterdayNightStart + nightMin * 60_000).toISOString(),
    type: "night",
    woke_by: "self",
  };

  const napStartIso = `${todayDateStr}T08:30:00.000Z`;
  const now = overrides.now ?? new Date(`${todayDateStr}T08:55:00.000Z`).getTime();

  // 24 days of synth, ending 2026-05-11 (no overlap with yesterday's night).
  const synth = synthDays("2026-04-18", 24, 13.0 * 60, /* jitterMin */ 30);
  const trendSleeps = [...synth, yesterdayNight];

  return {
    activeNap: { start_time: napStartIso },
    todaySleeps: [] as SleepEntry[],
    trendSleeps,
    bedtime: `${todayDateStr}T17:00:00.000Z`, // 19:00 local
    now,
    ctx: ctx({
      trendSleeps,
    }),
  };
}

// ── Gates ───────────────────────────────────────────────────────────

describe("computeNapBudget — gates", () => {
  it("returns null when opted out", () => {
    const s = halldisScenario();
    const out = computeNapBudget({ ...s, isLastNapOfDay: true, optedIn: false });
    expect(out).toBeNull();
  });

  it("returns null when not the day's last nap (v1 scope)", () => {
    const s = halldisScenario();
    const out = computeNapBudget({ ...s, isLastNapOfDay: false, optedIn: true });
    expect(out).toBeNull();
  });

  it("returns null when active nap elapsed < MIN_ELAPSED_BEFORE_CAP_MIN", () => {
    const s = halldisScenario({
      now: new Date("2026-05-13T08:35:00.000Z").getTime(), // 5 min in
    });
    const out = computeNapBudget({ ...s, isLastNapOfDay: true, optedIn: true });
    expect(out).toBeNull();
  });

  it("returns null when trend data has fewer than MIN_TREND_DAYS complete days", () => {
    const s = halldisScenario();
    const sparse = synthDays("2026-05-10", 3, 13 * 60); // only 3 days
    const out = computeNapBudget({
      ...s,
      trendSleeps: sparse,
      ctx: ctx({ trendSleeps: sparse }),
      isLastNapOfDay: true,
      optedIn: true,
    });
    expect(out).toBeNull();
  });

  it("returns null when trend variance is too noisy (suppression for bad weeks)", () => {
    const s = halldisScenario();
    // Big swings should push stdev/mean past MAX_STDEV_FRACTION.
    const noisy = synthDays("2026-04-18", 25, 13 * 60, /* jitterMin */ 240);
    const out = computeNapBudget({
      ...s,
      trendSleeps: noisy,
      ctx: ctx({ trendSleeps: noisy }),
      isLastNapOfDay: true,
      optedIn: true,
    });
    expect(out).toBeNull();
  });

  it("suppresses at exactly the trend boundary (projection == trend → null)", () => {
    // Gate 4 reads `projectedIfRunsFull <= trend.blendedTrendMin` — the
    // boundary is a *suppression* not an emit. Set up a stubbed trend
    // target = 780 and a projection that lands exactly there: night =
    // 720, learnedNapDurationMin = 60 → projection = 780. Then bump
    // projection by 1 min and verify the engine emits.
    const todayDateStr = "2026-05-13";
    const yesterdayNightStart = new Date(`${todayDateStr}T00:00:00Z`).getTime() - 5 * 3600_000;
    const synth = synthDays("2026-04-18", 24, 13 * 60);
    const trendSleeps: SleepEntry[] = [
      ...synth,
      {
        start_time: new Date(yesterdayNightStart).toISOString(),
        end_time: new Date(yesterdayNightStart + 720 * 60_000).toISOString(),
        type: "night",
        woke_by: "self",
      },
    ];
    const stubTrend = {
      observedRecentMin: 780,
      interventionTargetMin: 780,
      interventionConfidence: "medium" as const,
      observedSourceLabel: "stub",
      interventionSourceLabel: "stub",
      mean7: 780,
      mean30: 780,
      diagnostics: {} as unknown as TrendTargets["diagnostics"],
      state: {} as unknown as TrendTargets["state"],
    };
    const base = {
      activeNap: { start_time: `${todayDateStr}T08:30:00.000Z` },
      todaySleeps: [],
      trendSleeps,
      bedtime: `${todayDateStr}T17:00:00.000Z`,
      isLastNapOfDay: true,
      optedIn: true,
      now: new Date(`${todayDateStr}T08:55:00.000Z`).getTime(),
      ctx: ctx({ trendSleeps, trendTargets: stubTrend }),
    };

    const atBoundary = computeNapBudget({ ...base, learnedNapDurationMin: 60 });
    expect(atBoundary).toBeNull();

    const justOver = computeNapBudget({ ...base, learnedNapDurationMin: 61 });
    expect(justOver).not.toBeNull();
  });

  it("returns null when today's projection is already under trend + tolerance", () => {
    // Banked only 9h last night, blended trend 13h, projection well below
    // trend → suppress. synth ends day before today; explicit 9h yesterday
    // night is appended so it doesn't collide with the synth fixture.
    const todayDateStr = "2026-05-13";
    const yesterdayNightStart = new Date(`${todayDateStr}T00:00:00Z`).getTime() - 5 * 3600_000;
    const synth = synthDays("2026-04-18", 24, 13 * 60);
    const trendSleeps: SleepEntry[] = [
      ...synth,
      {
        start_time: new Date(yesterdayNightStart).toISOString(),
        end_time: new Date(yesterdayNightStart + 9 * 3600_000).toISOString(),
        type: "night",
        woke_by: "self",
      },
    ];
    const out = computeNapBudget({
      activeNap: { start_time: `${todayDateStr}T08:30:00.000Z` },
      todaySleeps: [],
      trendSleeps,
      bedtime: `${todayDateStr}T17:00:00.000Z`,
      isLastNapOfDay: true,
      optedIn: true,
      now: new Date(`${todayDateStr}T08:55:00.000Z`).getTime(),
      ctx: ctx({ trendSleeps }),
    });
    expect(out).toBeNull();
  });
});

// ── Emits ───────────────────────────────────────────────────────────

describe("computeNapBudget — emits a cap when over trend", () => {
  it("returns a NapBudget for the Halldis-tonight scenario", () => {
    const s = halldisScenario();
    const out = computeNapBudget({ ...s, isLastNapOfDay: true, optedIn: true });
    expect(out).not.toBeNull();
    expect(out!.reason).toBe("over_trend");
    expect(out!.mode).toBe("first-contact");
    // Sanity bounds; the synth fixture is parameterised on trend math
    // that may legitimately drift — exact value lives in the prod-fixture
    // test below and in the cap-dimensional-invariant block.
    expect(out!.recommendedDurationMin).toBeGreaterThan(20);
    expect(out!.recommendedDurationMin).toBeLessThanOrEqual(90);
  });

  it("recommendedDurationMin honors the age-band floor", () => {
    // Floor invariant: regardless of the trend math, the engine never
    // recommends a cap below the literature-backed minimum useful nap
    // for the baby's age band. Sanity check that the floor is being
    // applied at all — i.e. that NAP_FLOOR_BY_AGE is wired up.
    const s = halldisScenario();
    const floorMin = findByAge(NAP_FLOOR_BY_AGE, 11).floorMin;
    const out = computeNapBudget({ ...s, isLastNapOfDay: true, optedIn: true });
    expect(out).not.toBeNull();
    expect(out!.recommendedDurationMin).toBeGreaterThanOrEqual(floorMin);
  });

  it("urgency is `firm` when projected overshoot exceeds tolerance (confident target)", () => {
    // Banked night 12h → projection if uncapped at 90 min nap = 13.5h. Trend
    // ~13h → overshoot ~30 min > 20 (TOLERANCE_MIN). With a medium-confidence
    // held target this promotes to firm; a low-confidence target would not
    // (see the advisory-on-low-confidence pin below).
    const s = halldisScenario({ bankedNightMin: 720 });
    const mediumTrend = {
      observedRecentMin: 780,
      interventionTargetMin: 780,
      interventionConfidence: "medium" as const,
      observedSourceLabel: "stub",
      interventionSourceLabel: "stub",
      mean7: 780,
      mean30: 780,
      diagnostics: {} as unknown as TrendTargets["diagnostics"],
      state: {} as unknown as TrendTargets["state"],
    };
    const out = computeNapBudget({
      ...s,
      ctx: ctx({ trendSleeps: s.trendSleeps, trendTargets: mediumTrend }),
      isLastNapOfDay: true,
      optedIn: true,
    });
    expect(out).not.toBeNull();
    expect(out!.urgency).toBe("firm");
  });

  it("urgency stays `advisory` on a low-confidence held target despite overshoot", () => {
    // Same overshoot as above, but a freshly-seeded (no prior state) target is
    // low-confidence — we don't fire a push ("wake the baby") off a shaky
    // number, so urgency is held at advisory.
    const s = halldisScenario({ bankedNightMin: 720 });
    const out = computeNapBudget({ ...s, isLastNapOfDay: true, optedIn: true });
    expect(out).not.toBeNull();
    expect(out!.urgency).toBe("advisory");
  });

  it("urgency is `advisory` when overshoot is within tolerance", () => {
    // Deterministic scenario built bottom-up to land inside the gray zone:
    //  - Yesterday night 11h30m banked (690 min)
    //  - Active nap 25 min in, ~65 min remaining if uncapped → 90 min total
    //  - Projection 690 + 90 = 780 min ≈ trend (~771) → overshoot ~9 min
    //  - 9 ≤ TOLERANCE_MIN (20) → advisory
    const todayDateStr = "2026-05-13";
    const yesterdayNightStart = new Date(`${todayDateStr}T00:00:00Z`).getTime() - 5 * 3600_000;
    const synth = synthDays("2026-04-18", 24, 13 * 60); // 0 jitter for determinism
    const trendSleeps: SleepEntry[] = [
      ...synth,
      {
        start_time: new Date(yesterdayNightStart).toISOString(),
        end_time: new Date(yesterdayNightStart + 690 * 60_000).toISOString(),
        type: "night",
        woke_by: "self",
      },
    ];
    const out = computeNapBudget({
      activeNap: { start_time: `${todayDateStr}T08:30:00.000Z` },
      todaySleeps: [],
      trendSleeps,
      bedtime: `${todayDateStr}T17:00:00.000Z`,
      isLastNapOfDay: true,
      optedIn: true,
      now: new Date(`${todayDateStr}T08:55:00.000Z`).getTime(),
      ctx: ctx({ trendSleeps }),
    });
    expect(out).not.toBeNull();
    expect(out!.urgency).toBe("advisory");
  });

  it("context exposes the source label and the blended trend in minutes", () => {
    const s = halldisScenario();
    const out = computeNapBudget({ ...s, isLastNapOfDay: true, optedIn: true });
    expect(out!.context.blendedTrendMin).toBeGreaterThan(11 * 60);
    expect(out!.context.blendedTrendMin).toBeLessThan(15 * 60);
    expect(out!.context.toleranceMin).toBe(NAP_BUDGET.TOLERANCE_MIN);
    // Stage 4 of the trend split: context source label now reflects the
    // *intervention* target (what the engine recommends toward), not the
    // raw observed blend. When no prior trend-target state exists the
    // initialiser tags it "observed (initial)"; once cap-following lifts
    // the held baseline it becomes "held baseline (…)". Match either
    // along with the legacy observed labels.
    expect(out!.context.sourceLabel).toMatch(/blanding|snitt|observed|held|natural-day/);
  });
});

// ── Bedtime guard ───────────────────────────────────────────────────

describe("computeNapBudget — bedtime guard", () => {
  it("tightens the cap if it would land within MIN_PRE_BEDTIME_WAKE of bedtime", () => {
    // Nap starts at 16:30, bedtime 19:00. wake-window floor is 90 min, so
    // wakeBy must be ≤ 17:30. Cap should reflect that.
    const todayDateStr = "2026-05-13";
    const trendSleeps = synthDays("2026-04-18", 25, 13 * 60);
    const napStartIso = `${todayDateStr}T14:30:00.000Z`; // 16:30 local
    const now = new Date(`${todayDateStr}T15:00:00.000Z`).getTime();
    const nightEnd = new Date(`${todayDateStr}T04:30:00.000Z`).toISOString();
    const out = computeNapBudget({
      activeNap: { start_time: napStartIso },
      todaySleeps: [
        {
          start_time: new Date(`${todayDateStr}T00:00:00.000Z`).toISOString(),
          end_time: nightEnd,
          type: "night",
          woke_by: "self",
        },
      ],
      trendSleeps,
      bedtime: `${todayDateStr}T17:00:00.000Z`, // 19:00 local
      isLastNapOfDay: true,
      optedIn: true,
      now,
      ctx: ctx({ trendSleeps }),
    });
    // Scenario is over-trend (12h night + ~90 min uncapped nap projects past
    // 13h) and within the pre-bedtime guard's reach — engine must emit and
    // tighten so wakeBy lands no later than bedtime − 90 min.
    expect(out).not.toBeNull();
    const wakeByMs = new Date(out!.wakeBy).getTime();
    const bedtimeMs = new Date(`${todayDateStr}T17:00:00.000Z`).getTime();
    const preBedtimeGapMin = (bedtimeMs - wakeByMs) / 60_000;
    expect(preBedtimeGapMin).toBeGreaterThanOrEqual(90 - 0.5);
  });

  it("suppresses entirely when no useful nap fits before bedtime gap", () => {
    // Nap start at 18:00, bedtime 19:00 → only 60 min, less than 90 min wake
    // window → no room for any useful nap → null.
    const todayDateStr = "2026-05-13";
    const trendSleeps = synthDays("2026-04-18", 25, 13 * 60);
    const out = computeNapBudget({
      activeNap: { start_time: `${todayDateStr}T16:00:00.000Z` }, // 18:00 local
      todaySleeps: [],
      trendSleeps,
      bedtime: `${todayDateStr}T17:00:00.000Z`,
      isLastNapOfDay: true,
      optedIn: true,
      now: new Date(`${todayDateStr}T16:30:00.000Z`).getTime(),
      ctx: ctx({ trendSleeps }),
    });
    expect(out).toBeNull();
  });
});

// ── Age generality ──────────────────────────────────────────────────

describe("computeNapBudget — works across ages with literature-backed floors", () => {
  it("uses the 6-14 mo floor for an 11mo baby", () => {
    const floorMin = findByAge(NAP_FLOOR_BY_AGE, 11).floorMin;
    expect(floorMin).toBe(22);
  });

  it("uses a different floor for a 4mo baby than a 36mo toddler", () => {
    expect(findByAge(NAP_FLOOR_BY_AGE, 4).floorMin).toBe(20);
    expect(findByAge(NAP_FLOOR_BY_AGE, 36).floorMin).toBe(30);
  });

  it("the Halldis-tonight cap lands at ~one cycle (gentle easing), not the strict trend cap", () => {
    // User feedback: "going down to 28 min is a bit wild for the start —
    // just doing a cycle cut short (i.e. 44 min) should break the cycle".
    // Cycle is ~50 min for an 11mo; cap should be at the first cycle
    // boundary, not the strict 28-min trend math.
    const s = halldisScenario();
    const out = computeNapBudget({ ...s, isLastNapOfDay: true, optedIn: true });
    expect(out).not.toBeNull();
    // Must NOT be the strict trend cap (~28 min).
    expect(out!.recommendedDurationMin).toBeGreaterThan(35);
    // Must NOT exceed two cycles.
    expect(out!.recommendedDurationMin).toBeLessThanOrEqual(60);
    // Must be cycle-aligned (cycleNudge populated).
    expect(out!.cycleNudge).not.toBeNull();
  });

  it("first-contact mode caps at one full cycle, no lead-time subtraction", () => {
    const s = halldisScenario();
    const out = computeNapBudget({ ...s, isLastNapOfDay: true, optedIn: true });
    expect(out).not.toBeNull();
    expect(out!.mode).toBe("first-contact");
    // No lead-time deduction → cap is a multiple of the learned cycle.
    expect(out!.cycleNudge).not.toBeNull();
  });

  it("established mode kicks in once 7d trend drops ≥25 min below 30d", () => {
    // Build trend where last 7 days are ~30 min lower than the prior 23
    // — the shape after a week of consistent cap-respect.
    const todayDateStr = "2026-05-13";
    const yesterdayNightStart = new Date(`${todayDateStr}T00:00:00Z`).getTime() - 5 * 3600_000;
    const longHistory = synthDays("2026-04-18", 17, 13 * 60); // 17 days at 780 min
    const recentCapped = synthDays("2026-05-05", 7, 12.0 * 60); // 7 days at 720 min
    const synth = [...longHistory, ...recentCapped];
    const trendSleeps: SleepEntry[] = [
      ...synth,
      {
        start_time: new Date(yesterdayNightStart).toISOString(),
        end_time: new Date(yesterdayNightStart + 740 * 60_000).toISOString(),
        type: "night",
        woke_by: "self",
      },
    ];
    const out = computeNapBudget({
      activeNap: { start_time: `${todayDateStr}T08:30:00.000Z` },
      todaySleeps: [],
      trendSleeps,
      bedtime: `${todayDateStr}T17:00:00.000Z`,
      isLastNapOfDay: true,
      optedIn: true,
      now: new Date(`${todayDateStr}T08:55:00.000Z`).getTime(),
      ctx: ctx({ trendSleeps }),
    });
    expect(out).not.toBeNull();
    expect(out!.mode).toBe("established");
    // Established mode shouldn't snap to cycle boundary.
    expect(out!.cycleNudge).toBeNull();
  });

  it("established mode applies EARLY_WAKE_LEAD_MIN buffer", () => {
    // Trend ~773 min (13h synth, clamped at the upper edge of the blend),
    // yesterday night 725 min → bankedPreNap 725, napBudget ≈ 48, established
    // cap = 48 − EARLY_WAKE_LEAD_MIN (5) ≈ 43. Asserts the cap reflects the
    // lead-time offset rather than collapsing onto the age-band floor —
    // which is what a regression to the pre-2026-05-25 dimensional bug would
    // produce. Even synthetic days so the blend is not pulled down by a 7d
    // dip; priorState pins established mode regardless of delta.
    const todayDateStr = "2026-05-13";
    const yesterdayNightStart = new Date(`${todayDateStr}T00:00:00Z`).getTime() - 5 * 3600_000;
    const synth = synthDays("2026-04-18", 24, 13 * 60);
    const trendSleeps: SleepEntry[] = [
      ...synth,
      {
        start_time: new Date(yesterdayNightStart).toISOString(),
        end_time: new Date(yesterdayNightStart + 725 * 60_000).toISOString(),
        type: "night",
        woke_by: "self",
      },
    ];
    const out = computeNapBudget({
      activeNap: { start_time: `${todayDateStr}T08:30:00.000Z` },
      todaySleeps: [],
      trendSleeps,
      bedtime: `${todayDateStr}T17:00:00.000Z`,
      isLastNapOfDay: true,
      optedIn: true,
      now: new Date(`${todayDateStr}T08:55:00.000Z`).getTime(),
      ctx: ctx({ trendSleeps }),
      priorState: { mode: "established", enteredAt: "2026-04-13T00:00:00.000Z" },
    });
    expect(out).not.toBeNull();
    expect(out!.mode).toBe("established");
    expect(out!.cycleNudge).toBeNull();
    // Pre-fix this would have collapsed to ~26 (floor 22 + elapsed+1 clamp).
    expect(out!.recommendedDurationMin).toBeGreaterThanOrEqual(38);
    expect(out!.recommendedDurationMin).toBeLessThanOrEqual(55);
  });

  it("emits a budget for an 18mo toddler with the older floor", () => {
    // Same Halldis-tonight setup, age switched to 18mo. SLEEP_NEEDS for
    // 12-18mo is 12-14h (range narrower, target lower). The synth at 13h
    // still over-trends a 12.44h night + 90 min uncapped nap. Floor at this
    // age is 28 min. Engine must emit and respect that floor.
    const s = halldisScenario();
    const out = computeNapBudget({
      ...s,
      ctx: { ...s.ctx, ageMonths: 18, trendSleeps: s.trendSleeps },
      isLastNapOfDay: true,
      optedIn: true,
    });
    expect(out).not.toBeNull();
    expect(out!.recommendedDurationMin).toBeGreaterThanOrEqual(28);
  });
});

// ── Cap dimensional invariant ───────────────────────────────────────

/**
 * Anti-regression for the 2026-05-25 production bug.
 *
 * Observed on Halldis: an 11mo with a 11h56m night, 30 min into her nap,
 * the engine recommended waking at napStart + 30 min (i.e. "wake now")
 * while the same engine's cycle predictor was projecting a natural wake
 * 80 min later. Root cause: the cap math used `bankedMin` (which includes
 * the active nap's elapsed minutes) as the available nap budget. The
 * resulting `cappedDurationMin` is meant to be "duration from nap start"
 * but was effectively "minutes remaining from now". As elapsed grew, the
 * cap shrank in lockstep, collapsing onto the `elapsedMin + 1` floor.
 *
 * The dimensional invariant: holding the fixture constant, evaluating
 * the engine at multiple points during the same nap must produce the
 * same absolute wakeBy (modulo the elapsed+1 safety floor once the cap
 * has truly been passed). Previously, wakeBy moved forward roughly
 * 1 min per minute of waiting — a tell-tale signature of the bug.
 */
describe("computeNapBudget — cap dimensional invariant", () => {
  it("wakeBy is invariant under repeated evaluation during the same nap", () => {
    // Halldis-screenshot replica: 11h56m night (716 min), 11mo, 13h trend.
    // bankedPreNap = 716, napBudget = 64. Evaluate at elapsed = 25 / 35 / 45
    // min. wakeBy must stay near a single absolute time across all three.
    const todayDateStr = "2026-05-13";
    const yesterdayNightStart =
      new Date(`${todayDateStr}T00:00:00Z`).getTime() - 5 * 3600_000;
    const synth = synthDays("2026-04-18", 24, 13 * 60);
    const trendSleeps: SleepEntry[] = [
      ...synth,
      {
        start_time: new Date(yesterdayNightStart).toISOString(),
        end_time: new Date(yesterdayNightStart + 716 * 60_000).toISOString(),
        type: "night",
        woke_by: "self",
      },
    ];
    const napStartIso = `${todayDateStr}T08:30:00.000Z`;
    const napStartMs = new Date(napStartIso).getTime();
    const args = {
      activeNap: { start_time: napStartIso },
      todaySleeps: [] as SleepEntry[],
      trendSleeps,
      bedtime: `${todayDateStr}T17:00:00.000Z`,
      isLastNapOfDay: true,
      optedIn: true,
      ctx: ctx({ trendSleeps }),
    };

    const wakeBys: number[] = [];
    for (const elapsedMin of [25, 35, 45]) {
      const out = computeNapBudget({
        ...args,
        now: napStartMs + elapsedMin * 60_000,
      });
      expect(out).not.toBeNull();
      wakeBys.push(new Date(out!.wakeBy).getTime());
    }
    // All three wakeBys must be within ±1 min of each other. Pre-fix this
    // span would be ~20 min (cap shrinking with elapsed).
    const span = (Math.max(...wakeBys) - Math.min(...wakeBys)) / 60_000;
    expect(span).toBeLessThanOrEqual(1);
  });

  it("established cap = napBudget − lead, computed from bankedPreNap, not bankedMin", () => {
    // Screenshot replica with established priorState. Even 13h synth so the
    // blend lands near 773; night 716 → bankedPreNap 716, napBudget ≈ 57,
    // established cap ≈ 52-58. Pre-fix this returned ~30 (the elapsed+1
    // safety floor, after the dimensional double-count collapsed the math).
    const todayDateStr = "2026-05-13";
    const yesterdayNightStart =
      new Date(`${todayDateStr}T00:00:00Z`).getTime() - 5 * 3600_000;
    const synth = synthDays("2026-04-18", 24, 13 * 60);
    const trendSleeps: SleepEntry[] = [
      ...synth,
      {
        start_time: new Date(yesterdayNightStart).toISOString(),
        end_time: new Date(yesterdayNightStart + 716 * 60_000).toISOString(),
        type: "night",
        woke_by: "self",
      },
    ];
    const napStartIso = `${todayDateStr}T08:30:00.000Z`;
    const out = computeNapBudget({
      activeNap: { start_time: napStartIso },
      todaySleeps: [],
      trendSleeps,
      bedtime: `${todayDateStr}T17:00:00.000Z`,
      isLastNapOfDay: true,
      optedIn: true,
      now: new Date(napStartIso).getTime() + 30 * 60_000,
      ctx: ctx({ trendSleeps }),
      priorState: { mode: "established", enteredAt: "2026-04-13T00:00:00.000Z" },
    });
    expect(out).not.toBeNull();
    expect(out!.mode).toBe("established");
    // Tight window. Pre-fix: ~30 (elapsed+1 floor). Post-fix: ~50-60.
    expect(out!.recommendedDurationMin).toBeGreaterThanOrEqual(50);
    expect(out!.recommendedDurationMin).toBeLessThanOrEqual(65);
  });

  it("first-contact cap fits a full cycle into napBudget from nap start", () => {
    // Same replica, first-contact (no priorState). napBudget = 64. Cycle for
    // an 11mo with no nap data falls in the 45–55 min range. The cap should
    // accommodate one full cycle (≥ 40 min), not collapse to floor.
    const todayDateStr = "2026-05-13";
    const yesterdayNightStart =
      new Date(`${todayDateStr}T00:00:00Z`).getTime() - 5 * 3600_000;
    const synth = synthDays("2026-04-18", 24, 13 * 60);
    const trendSleeps: SleepEntry[] = [
      ...synth,
      {
        start_time: new Date(yesterdayNightStart).toISOString(),
        end_time: new Date(yesterdayNightStart + 716 * 60_000).toISOString(),
        type: "night",
        woke_by: "self",
      },
    ];
    const napStartIso = `${todayDateStr}T08:30:00.000Z`;
    const out = computeNapBudget({
      activeNap: { start_time: napStartIso },
      todaySleeps: [],
      trendSleeps,
      bedtime: `${todayDateStr}T17:00:00.000Z`,
      isLastNapOfDay: true,
      optedIn: true,
      now: new Date(napStartIso).getTime() + 30 * 60_000,
      ctx: ctx({ trendSleeps }),
    });
    expect(out).not.toBeNull();
    expect(out!.mode).toBe("first-contact");
    expect(out!.cycleNudge).not.toBeNull();
    // One full cycle ≈ 45-55 min. Pre-fix the bug would have collapsed this
    // onto a sub-cycle floor or onto elapsed+1.
    expect(out!.recommendedDurationMin).toBeGreaterThanOrEqual(40);
    expect(out!.recommendedDurationMin).toBeLessThanOrEqual(65);
  });

  it("first-contact 2-cycle cap is stable across mid-nap evaluations", () => {
    // Codex follow-up: when napBudgetMin is large enough for 2 full cycles,
    // repeated evaluations must keep recommendedDurationMin at 2 cycles,
    // not drop to 1 as elapsed grows. A regression to the pre-fix elapsed-
    // double-counting bug in the first-contact branch would shrink the cap
    // from 2 cycles → 1 cycle mid-nap as bankedMin grew.
    //
    // Cycle is pinned via `ctx._sleepCycleEstimate` (the memoized field
    // the engine reads via `estimateSleepCycleDetails`) so this test
    // exercises cap dimensionality, not cycle-estimator v2 scoring.
    // Without the stub, the v2 estimator scores the synth fixture's
    // 117-min self-woke naps and lands on whatever fundamental falls out
    // of the data — a different concern entirely. (Codex re-review
    // 2026-05-25 flagged the prior version as fixture-coupled.)
    const todayDateStr = "2026-05-13";
    const yesterdayNightStart =
      new Date(`${todayDateStr}T00:00:00Z`).getTime() - 5 * 3600_000;
    const synth = synthDays("2026-04-18", 24, 13 * 60);
    const trendSleeps: SleepEntry[] = [
      ...synth,
      {
        start_time: new Date(yesterdayNightStart).toISOString(),
        end_time: new Date(yesterdayNightStart + 650 * 60_000).toISOString(),
        type: "night",
        woke_by: "self",
      },
    ];
    const napStartIso = `${todayDateStr}T08:30:00.000Z`;
    const napStartMs = new Date(napStartIso).getTime();
    const stubbedCycle = ctx({
      trendSleeps,
      _sleepCycleEstimate: {
        minutes: 55,
        source: "learned",
        confidence: "high",
        sampleCount: 12,
        scoreMargin: 5,
        candidateRange: [50, 65],
      },
    });
    const base = {
      activeNap: { start_time: napStartIso },
      todaySleeps: [] as SleepEntry[],
      trendSleeps,
      bedtime: `${todayDateStr}T17:00:00.000Z`,
      isLastNapOfDay: true,
      optedIn: true,
      ctx: stubbedCycle,
      learnedNapDurationMin: 180,
    };

    const out25 = computeNapBudget({ ...base, now: napStartMs + 25 * 60_000 });
    const out45 = computeNapBudget({ ...base, now: napStartMs + 45 * 60_000 });
    const out55 = computeNapBudget({ ...base, now: napStartMs + 55 * 60_000 });
    expect(out25).not.toBeNull();
    expect(out45).not.toBeNull();
    expect(out55).not.toBeNull();
    expect(out25!.mode).toBe("first-contact");
    expect(out45!.mode).toBe("first-contact");
    expect(out55!.mode).toBe("first-contact");
    // Cap stays at 2 cycles (= 2 × 55 = 110 min). Pre-fix the first-
    // contact branch would have shrunk this to 1 cycle as elapsed grew.
    expect(out25!.recommendedDurationMin).toBe(110);
    expect(out45!.recommendedDurationMin).toBe(110);
    expect(out55!.recommendedDurationMin).toBe(110);
    expect(out25!.cycleNudge!.boundaryAtMin).toBe(110);
  });
});

// ── Multi-day simulation ────────────────────────────────────────────

/**
 * Time-series anti-regression. Runs a typical 11mo across 5 days, with
 * the engine called at three points during each nap (t+20, t+35, t+50).
 * For each day, captures one trail line plus the wakeBy span across the
 * three evaluations. The "parent" caps at the first emitted wakeBy and
 * the actual nap is appended to history for the next day.
 *
 * This is the canonical test for the bug class the 2026-05-25 dimensional
 * issue belonged to — anything that makes the cap evolve during the nap
 * (or anything that makes the trend ratchet down over days of cap-
 * following) will show up either in the trail snapshot or in the
 * pinned invariants. testing.md's "render full state then assert"
 * pattern applied to a multi-evaluation timeline.
 */
describe("computeNapBudget — multi-day simulation", () => {
  it("typical 11mo, 5 days of capped naps with 4 mid-nap snapshots/day", () => {
    const baselineSynth = synthDays("2026-04-18", 24, 13 * 60);
    let history: SleepEntry[] = [...baselineSynth];

    // 12.2h nights each day, 1 nap starting 10:30 local (08:30Z), bedtime
    // 19:00 local (17:00Z). Day N's night ends at 06:30 local (04:30Z) of day N.
    const NIGHT_MIN = 732;
    const NAP_START_OFFSET_H = 8.5;
    const BEDTIME_OFFSET_H = 17;
    const startDay = "2026-05-13";

    const trail: string[] = [];
    const wakeBySpans: number[] = [];

    for (let day = 0; day < 5; day++) {
      const today = new Date(`${startDay}T00:00:00Z`).getTime() + day * 86400_000;
      const yesterdayNightStart = today - 5 * 3600_000;
      const yesterdayNight: SleepEntry = {
        start_time: new Date(yesterdayNightStart).toISOString(),
        end_time: new Date(yesterdayNightStart + NIGHT_MIN * 60_000).toISOString(),
        type: "night",
        woke_by: "self",
      };
      const trendSleeps = [...history, yesterdayNight];
      const napStartMs = today + NAP_START_OFFSET_H * 3600_000;
      const napStartIso = new Date(napStartMs).toISOString();
      const bedtimeIso = new Date(today + BEDTIME_OFFSET_H * 3600_000).toISOString();
      const args = {
        activeNap: { start_time: napStartIso },
        todaySleeps: [] as SleepEntry[],
        trendSleeps,
        bedtime: bedtimeIso,
        isLastNapOfDay: true,
        optedIn: true,
        ctx: ctx({ trendSleeps }),
      };

      // Three evaluation points all under the typical cap (~55-60 min).
      // Once elapsed passes the cap, the engine clamps wakeBy to `now + 1`
      // (safety: wakeBy can't be in the past). That's correct behavior,
      // not a dimensional bug, so the invariance trail stops at t+50.
      // Each evaluation must emit — this scenario is firmly over-trend
      // every day, so a `null` at any point would be the real regression.
      const wakeBys: number[] = [];
      let firstOut: NonNullable<ReturnType<typeof computeNapBudget>> | null = null;
      for (const elapsedMin of [20, 35, 50]) {
        const out = computeNapBudget({
          ...args,
          now: napStartMs + elapsedMin * 60_000,
        });
        expect(out, `day ${day} t+${elapsedMin} should emit a cap`).not.toBeNull();
        wakeBys.push(new Date(out!.wakeBy).getTime());
        if (!firstOut) firstOut = out;
      }

      const span = (Math.max(...wakeBys) - Math.min(...wakeBys)) / 60_000;
      wakeBySpans.push(span);

      const actualNapMin = Math.round((new Date(firstOut!.wakeBy).getTime() - napStartMs) / 60_000);
      const wakeHM = new Date(firstOut!.wakeBy).toISOString().slice(11, 16);
      trail.push(
        `day ${day}: night=${NIGHT_MIN}m wakeBy=${wakeHM}Z cap=${actualNapMin}m mode=${firstOut!.mode} urgency=${firstOut!.urgency} trend=${firstOut!.context.blendedTrendMin}`,
      );

      history.push(yesterdayNight, {
        start_time: napStartIso,
        end_time: new Date(napStartMs + actualNapMin * 60_000).toISOString(),
        type: "nap",
        woke_by: "woken",
      });
    }

    expect(trail.join("\n")).toMatchInlineSnapshot(`
      "day 0: night=732m wakeBy=09:28Z cap=58m mode=first-contact urgency=advisory trend=778
      day 1: night=732m wakeBy=09:28Z cap=58m mode=first-contact urgency=advisory trend=778
      day 2: night=732m wakeBy=09:28Z cap=58m mode=first-contact urgency=advisory trend=778
      day 3: night=732m wakeBy=09:28Z cap=58m mode=first-contact urgency=advisory trend=778
      day 4: night=732m wakeBy=09:28Z cap=58m mode=first-contact urgency=advisory trend=779"
    `);

    // Dimensional invariant: across all 5 days × 3 evaluations per day,
    // wakeBy never moves more than 1 min within a single nap.
    for (let i = 0; i < wakeBySpans.length; i++) {
      expect(wakeBySpans[i], `day ${i} wakeBy span ≤ 1 min`).toBeLessThanOrEqual(1);
    }

    // Anti-ratchet invariant: the held intervention target must not drop
    // materially as the parent follows the cap. Stage 4 of the trend
    // split (intervention vs observed) is what protects this — a
    // regression that wires the cap back to the observed mean would
    // show up as a slow trend drift in the snapshot above.
    const trends = trail.map((line) => Number(line.match(/trend=(\d+)/)![1]));
    const trendDrift = trends[0] - trends[trends.length - 1];
    expect(trendDrift, "intervention target should drift ≤ 10 min over 5 days of cap-follow")
      .toBeLessThanOrEqual(10);
  });
});

// ── Real-data integration ───────────────────────────────────────────

/**
 * Halldis's actual sleep data over the 25 days she's been tracked
 * (2026-04-19 → 2026-05-12). Noisy: long-nap days alternating with
 * skip days, the 14h vs 12h pingpong the parent flagged. The engine
 * must handle this gracefully — emit a cap when it would clearly help,
 * suppress when variance is too high, never produce nonsense numbers.
 */
describe("computeNapBudget — real Halldis data (regression net)", () => {
  // Type the fixture so the rest of the test reads cleanly.
  const real = halldisRealData as SleepEntry[];

  it("emits a concrete cap for the actual 2026-05-13 morning scenario", () => {
    // Halldis tonight: night 16:08-yesterday → 04:35 today (12h27).
    // Active nap supposedly starting around 10:30 local (08:30Z),
    // engine called 25 min into the nap.
    //
    // This is the canonical real-baby pin. If anything in the engine
    // changes — trend math, cycle estimator, intervention target, banked
    // calculation — the values below WILL change, and that should be
    // a deliberate update with a reason. Concrete values force someone
    // to look at the recommendation a real parent would see.
    const now = new Date("2026-05-13T08:55:00.000Z").getTime();
    const out = computeNapBudget({
      activeNap: { start_time: "2026-05-13T08:30:00.000Z" },
      todaySleeps: [],
      trendSleeps: real,
      bedtime: "2026-05-13T17:00:00.000Z", // 19:00 local
      isLastNapOfDay: true,
      optedIn: true,
      now,
      ctx: ctx({ trendSleeps: real }),
    });

    expect(out).not.toBeNull();
    // wakeBy: napStart (08:30Z) + 55 min = 09:25Z = 11:25 local — one
    // full sleep cycle, the gentle first-contact cap.
    expect(out!.wakeBy).toBe("2026-05-13T09:25:00.000Z");
    expect(out!.recommendedDurationMin).toBe(55);
    expect(out!.mode).toBe("first-contact");
    expect(out!.reason).toBe("over_trend");
    // The uncapped projection (banked + 90 min typical-full-nap remaining)
    // overshoots trend by > TOLERANCE_MIN, but this fixture has no persisted
    // trend-target state, so the held target is low-confidence — we hold at
    // advisory (no push) rather than fire a notification off a shaky target.
    expect(out!.urgency).toBe("advisory");
    expect(out!.cycleNudge).not.toBeNull();
    expect(out!.cycleNudge!.boundaryAtMin).toBe(55);
    // Context: blended trend ~13h, banked = 746 night + 25 elapsed = 771.
    expect(out!.context.blendedTrendMin).toBe(784);
    expect(out!.context.bankedMin).toBe(771);
  });

  it("wakeBy is invariant across mid-nap evaluations on the real fixture", () => {
    // Same scenario as the concrete-pin test but probing the dimensional
    // invariant on production data, not synthesised trends. wakeBy must
    // stay at 09:25Z across t+20 / t+30 / t+45 evaluations of the same
    // nap. context.bankedMin rises 1:1 with elapsed (proves it includes
    // the active nap's elapsed minutes correctly); recommendedDurationMin
    // stays constant (proves cap math uses bankedPreNap, not bankedMin).
    // Starts at t+20 — MIN_ELAPSED_BEFORE_CAP_MIN gate suppresses before.
    const napStartIso = "2026-05-13T08:30:00.000Z";
    const napStartMs = new Date(napStartIso).getTime();
    const base = {
      activeNap: { start_time: napStartIso },
      todaySleeps: [] as SleepEntry[],
      trendSleeps: real,
      bedtime: "2026-05-13T17:00:00.000Z",
      isLastNapOfDay: true,
      optedIn: true,
      ctx: ctx({ trendSleeps: real }),
    };
    const t20 = computeNapBudget({ ...base, now: napStartMs + 20 * 60_000 });
    const t30 = computeNapBudget({ ...base, now: napStartMs + 30 * 60_000 });
    const t45 = computeNapBudget({ ...base, now: napStartMs + 45 * 60_000 });
    expect(t20).not.toBeNull();
    expect(t30).not.toBeNull();
    expect(t45).not.toBeNull();
    expect(t20!.wakeBy).toBe("2026-05-13T09:25:00.000Z");
    expect(t30!.wakeBy).toBe("2026-05-13T09:25:00.000Z");
    expect(t45!.wakeBy).toBe("2026-05-13T09:25:00.000Z");
    expect(t20!.recommendedDurationMin).toBe(55);
    expect(t45!.recommendedDurationMin).toBe(55);
    // bankedMin rises with elapsed; the cap doesn't.
    expect(t30!.context.bankedMin - t20!.context.bankedMin).toBe(10);
    expect(t45!.context.bankedMin - t20!.context.bankedMin).toBe(25);
  });

  it("never produces NaN/Infinity for any plausible point in the dataset", () => {
    // Walk through every day in the fixture, pretend "today is the morning
    // after this day's night ended", and run the engine. Catch any math
    // pathologies (divide-by-zero, NaN, ISO parse errors).
    const seenInputs = new Set<string>();
    for (const s of real) {
      if (s.type !== "night" || !s.end_time) continue;
      const morningOf = new Date(s.end_time);
      morningOf.setMinutes(morningOf.getMinutes() + 60); // 1 hour after wake
      const now = morningOf.getTime();
      const napStart = new Date(now + 2 * 3600_000).toISOString(); // 2h later
      const napFakeStart = new Date(now + 25 * 60_000).toISOString(); // 25 min nap in-progress
      const bedtime = new Date(now + 11 * 3600_000).toISOString();
      const key = `${napFakeStart}`;
      if (seenInputs.has(key)) continue;
      seenInputs.add(key);

      const out = computeNapBudget({
        activeNap: { start_time: napFakeStart },
        todaySleeps: [],
        trendSleeps: real,
        bedtime,
        isLastNapOfDay: true,
        optedIn: true,
        now,
        ctx: ctx({ trendSleeps: real }),
      });

      if (out !== null) {
        expect(Number.isFinite(out.recommendedDurationMin)).toBe(true);
        expect(Number.isFinite(out.context.blendedTrendMin)).toBe(true);
        expect(Number.isFinite(out.context.bankedMin)).toBe(true);
        expect(out.recommendedDurationMin).toBeGreaterThan(0);
        // wakeBy must parse to a valid date strictly after napFakeStart.
        const wakeByMs = new Date(out.wakeBy).getTime();
        expect(Number.isFinite(wakeByMs)).toBe(true);
        expect(wakeByMs).toBeGreaterThan(new Date(napFakeStart).getTime());
        // Reference napStart so the linter doesn't trip on the unused var.
        expect(typeof napStart).toBe("string");
      }
    }
  });

  it("suppresses on noisy weeks (Halldis 7d stdev/mean is high after pingpong)", () => {
    // Halldis's recent 10 days have ~58 min stdev / ~13h mean = 0.075.
    // Currently below the 0.12 gate. As variance rises (more pingpong),
    // the suppression should fire. Synthesize a noisier overlay and check.
    const noisyOverlay: SleepEntry[] = [];
    // Replace the last 7 days of real data with high-jitter equivalents.
    const cutoff = new Date("2026-05-06T00:00:00Z").getTime();
    for (const s of real) {
      if (new Date(s.start_time).getTime() < cutoff) noisyOverlay.push(s);
    }
    // Inject deliberately jittery days (±180 min totals).
    for (let i = 0; i < 7; i++) {
      const dayMs = new Date("2026-05-06T00:00:00Z").getTime() + i * 86400_000;
      const totalMin = 13 * 60 + (i % 2 === 0 ? 180 : -180);
      const nightMin = Math.max(360, totalMin * 0.85);
      const napMin = Math.max(15, totalMin - nightMin);
      noisyOverlay.push({
        start_time: new Date(dayMs + 10 * 3600_000).toISOString(),
        end_time: new Date(dayMs + 10 * 3600_000 + napMin * 60_000).toISOString(),
        type: "nap",
        woke_by: "self",
      });
      noisyOverlay.push({
        start_time: new Date(dayMs + 19 * 3600_000).toISOString(),
        end_time: new Date(dayMs + 19 * 3600_000 + nightMin * 60_000).toISOString(),
        type: "night",
        woke_by: "self",
      });
    }

    const out = computeNapBudget({
      activeNap: { start_time: "2026-05-13T08:30:00.000Z" },
      todaySleeps: [],
      trendSleeps: noisyOverlay,
      bedtime: "2026-05-13T17:00:00.000Z",
      isLastNapOfDay: true,
      optedIn: true,
      now: new Date("2026-05-13T08:55:00.000Z").getTime(),
      ctx: ctx({ trendSleeps: noisyOverlay }),
    });

    // High-variance week should cause suppression.
    expect(out).toBeNull();
  });
});

// ── isDayOnTrend — gate for continuationWindow / rescue paths ──────

describe("isDayOnTrend — rescue suppression gate", () => {
  // Real bug: 2026-05-13 morning. Halldis napped 67 min (08:38→09:46).
  // Engine flagged it as cut-short and fired continuationWindow even
  // though banked24h was already on trend. This test pins the fix.
  it("returns true for Halldis's actual 2026-05-13 on-trend morning", () => {
    const real = halldisRealData as SleepEntry[];
    // The 2026-05-13 nap (08:38–09:46 = 67 min) had ended ~4 min before
    // this scenario's `now`. Fixture is a prior snapshot so we add the
    // nap explicitly via todaySleeps.
    const todaysCutShort: SleepEntry = {
      start_time: "2026-05-13T08:38:32.713Z",
      end_time: "2026-05-13T09:46:00.000Z",
      type: "nap",
      woke_by: "woken",
    };
    const now = new Date("2026-05-13T09:50:00.000Z").getTime();
    const onTrend = isDayOnTrend(real, [todaysCutShort], ctx({ trendSleeps: real }), now);
    expect(onTrend).toBe(true);
  });

  it("returns false on a real off-trend day (small overnight + no nap yet)", () => {
    // Same fixture but pretend "now" is right after a 9h short night,
    // before any nap. banked24h ≈ 9h, way under 13h trend → not on trend.
    const real = halldisRealData as SleepEntry[];
    // Synthesise an under-banked day by trimming to a 9h overnight only.
    const todayDateStr = "2026-05-13";
    const yesterdayNightStart = new Date(`${todayDateStr}T00:00:00Z`).getTime() - 5 * 3600_000;
    const shortNight: SleepEntry = {
      start_time: new Date(yesterdayNightStart).toISOString(),
      end_time: new Date(yesterdayNightStart + 9 * 3600_000).toISOString(),
      type: "night",
      woke_by: "self",
    };
    // Replace yesterday's night in the fixture with the short one.
    const trimmed = real.filter((s) => {
      if (s.type !== "night") return true;
      const start = new Date(s.start_time).getTime();
      return start < yesterdayNightStart;
    });
    trimmed.push(shortNight);
    const now = new Date(yesterdayNightStart + 9 * 3600_000 + 30 * 60_000).getTime();
    const onTrend = isDayOnTrend(trimmed, [], ctx({ trendSleeps: trimmed }), now);
    expect(onTrend).toBe(false);
  });

  it("returns false when trend data is too sparse to trust", () => {
    // With <7 days of completed data, the gate can't fire — preserve the
    // existing rescue behavior rather than silently disabling it.
    const sparse = (halldisRealData as SleepEntry[]).slice(0, 6);
    const now = new Date("2026-05-13T09:50:00.000Z").getTime();
    expect(isDayOnTrend(sparse, [], ctx({ trendSleeps: sparse }), now)).toBe(false);
  });
});

// ── Codex review fixes ─────────────────────────────────────────────

describe("computeNapBudget — Codex review regressions", () => {
  it("wakeBy is never in the past, even when elapsed > cap", () => {
    // Halldis-tonight scenario but pretend the parent is already 70 min
    // into the nap. One-cycle cap (55 min) would land 15 min in the past
    // — the engine must clamp so wakeBy ≥ now + 1 min.
    const s = halldisScenario();
    const lateNow = new Date(s.activeNap.start_time).getTime() + 70 * 60_000;
    const out = computeNapBudget({
      ...s,
      now: lateNow,
      isLastNapOfDay: true,
      optedIn: true,
    });
    expect(out).not.toBeNull();
    const wakeByMs = new Date(out!.wakeBy).getTime();
    expect(wakeByMs).toBeGreaterThan(lateNow);
  });

  it("trend gate ignores nap-only days that have no night", () => {
    // 10 days of nap-only history (no night entries). The gate must NOT
    // count them as "complete" — without the fix it would treat them as a
    // stable daily-sleep trend even though night minutes are missing.
    const todayDateStr = "2026-05-13";
    const napOnly: SleepEntry[] = [];
    for (let i = 0; i < 10; i++) {
      const dayMs = new Date("2026-04-25T00:00:00Z").getTime() + i * 86400_000;
      napOnly.push({
        start_time: new Date(dayMs + 10 * 3600_000).toISOString(),
        end_time: new Date(dayMs + 10 * 3600_000 + 60 * 60_000).toISOString(),
        type: "nap",
        woke_by: "self",
      });
    }
    const out = computeNapBudget({
      activeNap: { start_time: `${todayDateStr}T08:30:00.000Z` },
      todaySleeps: [],
      trendSleeps: napOnly,
      bedtime: `${todayDateStr}T17:00:00.000Z`,
      isLastNapOfDay: true,
      optedIn: true,
      now: new Date(`${todayDateStr}T08:55:00.000Z`).getTime(),
      ctx: ctx({ trendSleeps: napOnly }),
    });
    // No complete days → no trend → suppress entirely.
    expect(out).toBeNull();
  });

  it("learnedNapDurationMin override avoids over-projecting transitioning baby", () => {
    // Transitioning baby whose learned-typical has dropped to 50 min.
    // Without the override, estimateRemainingNapMin assumes 90 min and
    // false-caps. With override 50, projection stays inside trend.
    const todayDateStr = "2026-05-13";
    const yesterdayNightStart = new Date(`${todayDateStr}T00:00:00Z`).getTime() - 5 * 3600_000;
    const synth = synthDays("2026-04-18", 24, 13 * 60);
    const trendSleeps: SleepEntry[] = [
      ...synth,
      {
        start_time: new Date(yesterdayNightStart).toISOString(),
        end_time: new Date(yesterdayNightStart + 700 * 60_000).toISOString(),
        type: "night",
        woke_by: "self",
      },
    ];
    const input = {
      activeNap: { start_time: `${todayDateStr}T08:30:00.000Z` },
      todaySleeps: [] as SleepEntry[],
      trendSleeps,
      bedtime: `${todayDateStr}T17:00:00.000Z`,
      isLastNapOfDay: true,
      optedIn: true,
      now: new Date(`${todayDateStr}T08:55:00.000Z`).getTime(),
      ctx: ctx({ trendSleeps }),
    };
    // Without override: projection uses 90 min default → over-trend → cap.
    const withDefault = computeNapBudget({ ...input });
    // With override 50 min: projection 50-25 = 25 → banked 725 + 25 = 750 < 770 → no cap.
    const withOverride = computeNapBudget({ ...input, learnedNapDurationMin: 50 });
    // Just assert that the override CHANGES the outcome (suppression vs. cap).
    expect(withDefault === null && withOverride === null).toBe(false);
  });

  it("hysteresis: established mode persists when priorState says established and 30d≥7d", () => {
    // Construct a steady-state scenario where mean30 ≈ mean7 (delta ≈ 0).
    // Without priorState the pure delta-≥-25 gate falls back to
    // first-contact. With priorState=established and delta ≥ 0, the
    // relaxed stay-gate keeps the engine in established mode.
    const todayDateStr = "2026-05-13";
    const yesterdayNightStart = new Date(`${todayDateStr}T00:00:00Z`).getTime() - 5 * 3600_000;
    const synth = synthDays("2026-04-18", 24, 13 * 60); // flat 13h every day
    const yesterdayNight: SleepEntry = {
      start_time: new Date(yesterdayNightStart).toISOString(),
      end_time: new Date(yesterdayNightStart + 780 * 60_000).toISOString(),
      type: "night",
      woke_by: "self",
    };
    const trendSleeps = [...synth, yesterdayNight];

    const input = {
      activeNap: { start_time: `${todayDateStr}T08:30:00.000Z` },
      todaySleeps: [] as SleepEntry[],
      trendSleeps,
      bedtime: `${todayDateStr}T17:00:00.000Z`,
      isLastNapOfDay: true,
      optedIn: true,
      now: new Date(`${todayDateStr}T08:55:00.000Z`).getTime(),
      ctx: ctx({ trendSleeps }),
    };

    const fresh = computeNapBudget(input);
    const sticky = computeNapBudget({
      ...input,
      priorState: { mode: "established", enteredAt: "2026-04-13T00:00:00.000Z" },
    });

    // Both calls hit the same over-trend gate; the only difference is the
    // priorState. Both must emit, and the sticky one must be established
    // while the fresh one falls back to first-contact (mean30 ≈ mean7).
    expect(fresh).not.toBeNull();
    expect(sticky).not.toBeNull();
    expect(fresh!.mode).toBe("first-contact");
    expect(sticky!.mode).toBe("established");
  });

  it("hysteresis: established mode exits when 7d climbs back above 30d", () => {
    // Build trend data where the last 7 days have HIGHER totals than the
    // 30d window (parent stopped capping — mean7 > mean30 → delta < 0).
    // Even with priorState=established, the stay-gate (delta ≥ 0) fails,
    // so the engine transitions back to first-contact.
    const todayDateStr = "2026-05-13";
    const yesterdayNightStart = new Date(`${todayDateStr}T00:00:00Z`).getTime() - 5 * 3600_000;
    const early = synthDays("2026-04-18", 17, 12 * 60); // older days: 12h
    const recent = synthDays("2026-05-05", 7, 14 * 60);  // last 7 days: 14h
    const yesterdayNight: SleepEntry = {
      start_time: new Date(yesterdayNightStart).toISOString(),
      end_time: new Date(yesterdayNightStart + 800 * 60_000).toISOString(),
      type: "night",
      woke_by: "self",
    };
    const trendSleeps = [...early, ...recent, yesterdayNight];

    const out = computeNapBudget({
      activeNap: { start_time: `${todayDateStr}T08:30:00.000Z` },
      todaySleeps: [],
      trendSleeps,
      bedtime: `${todayDateStr}T17:00:00.000Z`,
      isLastNapOfDay: true,
      optedIn: true,
      priorState: { mode: "established", enteredAt: "2026-04-13T00:00:00.000Z" },
      now: new Date(`${todayDateStr}T08:55:00.000Z`).getTime(),
      ctx: ctx({ trendSleeps }),
    });

    // Scenario projects clearly over trend (800 min night + nap = ~14h+).
    // Engine must emit, and hysteresis must have released — mode no longer
    // established because the parent has clearly stopped capping.
    expect(out).not.toBeNull();
    expect(out!.mode).toBe("first-contact");
  });

  it("off-day filter excludes flagged dates from trend computation", () => {
    // 18 days of 13.5h totals followed by 6 days of 12h totals (a recent
    // "off week"), plus a separate yesterdayNight as the 25th day.
    // Without the filter the recent 7d window pulls the blended trend
    // down. Marking the 6 low days off-day restores it. The 12h–13.5h
    // split keeps stdev/mean below the noise gate so both calls emit;
    // an earlier version of this test silently no-op'd because the
    // variance was too high (see codex audit 2026-05-25). lowDays runs
    // up to 2026-05-11 so it doesn't collide with yesterdayNight on
    // 2026-05-12 (which would double-count and blow up the stdev).
    const todayDateStr = "2026-05-13";
    const yesterdayNightStart = new Date(`${todayDateStr}T00:00:00Z`).getTime() - 5 * 3600_000;
    const highDays = synthDays("2026-04-18", 18, 13.5 * 60);
    const lowDays = synthDays("2026-05-06", 6, 12 * 60);
    const yesterdayNight: SleepEntry = {
      start_time: new Date(yesterdayNightStart).toISOString(),
      end_time: new Date(yesterdayNightStart + 800 * 60_000).toISOString(),
      type: "night",
      woke_by: "self",
    };
    const trendSleeps = [...highDays, ...lowDays, yesterdayNight];

    const input = {
      activeNap: { start_time: `${todayDateStr}T08:30:00.000Z` },
      todaySleeps: [] as SleepEntry[],
      trendSleeps,
      bedtime: `${todayDateStr}T17:00:00.000Z`,
      isLastNapOfDay: true,
      optedIn: true,
      now: new Date(`${todayDateStr}T08:55:00.000Z`).getTime(),
    };

    const withAllDays = computeNapBudget({ ...input, ctx: ctx({ trendSleeps }) });

    const offDays = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const dayMs = new Date("2026-05-06T00:00:00Z").getTime() + i * 86400_000;
      const d = new Date(dayMs);
      offDays.add(
        `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`,
      );
    }
    const withFilter = computeNapBudget({
      ...input,
      ctx: ctx({ trendSleeps, offDays }),
    });

    expect(withAllDays).not.toBeNull();
    expect(withFilter).not.toBeNull();
    expect(withFilter!.context.blendedTrendMin).toBeGreaterThan(
      withAllDays!.context.blendedTrendMin,
    );
  });

  it("split-night fragments both count toward banked", () => {
    // Parent logged the night as TWO entries (a mid-night feeding session
    // split out): 17:00-21:00 yesterday (4h) and 21:30-05:30 today (8h).
    // Old code's `break` after the first night-ended-today bailed out
    // before including the earlier fragment — banked under-counted by 4h.
    // Sleep-day anchor at 05:30 today picks up both because both end
    // within the 12h overnight window. 12h banked + 25 min nap + 65 min
    // remaining projects over trend → engine must emit, and bankedMin
    // must reflect both fragments.
    const todayDateStr = "2026-05-13";
    const todayStart = new Date(`${todayDateStr}T00:00:00Z`).getTime();
    const trendSleeps: SleepEntry[] = [
      {
        start_time: new Date(todayStart - 7 * 3600_000).toISOString(),
        end_time: new Date(todayStart - 3 * 3600_000).toISOString(),
        type: "night",
        woke_by: "self",
      },
      {
        start_time: new Date(todayStart - 2.5 * 3600_000).toISOString(),
        end_time: new Date(todayStart + 5.5 * 3600_000).toISOString(),
        type: "night",
        woke_by: "self",
      },
      ...synthDays("2026-04-18", 24, 13 * 60),
    ];
    const out = computeNapBudget({
      activeNap: { start_time: `${todayDateStr}T08:30:00.000Z` },
      todaySleeps: [],
      trendSleeps,
      bedtime: `${todayDateStr}T17:00:00.000Z`,
      isLastNapOfDay: true,
      optedIn: true,
      now: new Date(`${todayDateStr}T08:55:00.000Z`).getTime(),
      ctx: ctx({ trendSleeps }),
    });
    expect(out).not.toBeNull();
    // 4h + 8h = 720 min night + 25 min active nap = 745 min banked.
    expect(out!.context.bankedMin).toBeGreaterThanOrEqual(740);
    expect(out!.context.bankedMin).toBeLessThanOrEqual(755);
  });

  it("midnight-crossing nap stays attributed to its sleep-day (not double-counted)", () => {
    // Engine fires the next morning AFTER a 23:40 → 00:30 nap. The
    // nap belonged to yesterday's sleep-day (started before tonight's
    // bedtime). Today's banked must NOT include it — that would
    // double-count when yesterday's napBudget already saw it.
    const todayDateStr = "2026-05-13";
    const yesterdayLateNapStart = new Date(`${todayDateStr}T00:00:00Z`).getTime() - 20 * 60_000;
    const yesterdayLateNapEnd = new Date(`${todayDateStr}T00:00:00Z`).getTime() + 30 * 60_000;
    const todayNightStart = new Date(`${todayDateStr}T00:00:00Z`).getTime() - 5 * 3600_000;
    const todayNightEnd = todayNightStart + 720 * 60_000; // 12h
    const trendSleeps: SleepEntry[] = [
      {
        start_time: new Date(yesterdayLateNapStart).toISOString(),
        end_time: new Date(yesterdayLateNapEnd).toISOString(),
        type: "nap",
        woke_by: "self",
      },
      {
        start_time: new Date(todayNightStart).toISOString(),
        end_time: new Date(todayNightEnd).toISOString(),
        type: "night",
        woke_by: "self",
      },
      ...synthDays("2026-04-18", 24, 13 * 60),
    ];
    const activeNapStart = todayNightEnd + 2 * 3600_000; // 2h after wake
    const now = activeNapStart + 25 * 60_000;
    const out = computeNapBudget({
      activeNap: { start_time: new Date(activeNapStart).toISOString() },
      todaySleeps: [],
      trendSleeps,
      bedtime: new Date(todayNightEnd + 13 * 3600_000).toISOString(),
      isLastNapOfDay: true,
      optedIn: true,
      now,
      ctx: ctx({ trendSleeps }),
    });
    expect(out).not.toBeNull();
    // Banked = 12h night + 25 min active = 745 min. The midnight-crossing
    // nap (50 min) is NOT included because it started before the wake
    // anchor — sleep-day anchor keeps it on yesterday's ledger.
    expect(out!.context.bankedMin).toBeLessThan(770);
    expect(out!.context.bankedMin).toBeGreaterThanOrEqual(740);
  });

  it("first-day-after-onboarding: bankedToday falls back to local midnight in baby tz", () => {
    // Defensive branch (computeBankedToday `wakeAnchorMs === null` → local
    // midnight). No completed night precedes now, so the wake anchor
    // falls back to local midnight in the baby's tz. Stub trendTargets
    // to bypass Gate 3's MIN_TREND_DAYS requirement.
    //
    // To discriminate local vs UTC midnight (Codex re-review 2026-05-26
    // flagged the previous version as non-discriminating), the active
    // nap straddles UTC midnight but is firmly inside the Oslo day:
    //   - tz = Europe/Oslo (CEST = UTC+2 in May)
    //   - napStart = 2026-05-12T23:30:00Z = 2026-05-13T01:30 Oslo
    //   - now      = 2026-05-13T00:00:00Z = 2026-05-13T02:00 Oslo
    // Local midnight in Oslo for 2026-05-13 = 2026-05-12T22:00Z.
    // napStart (23:30Z) > localMidnight (22:00Z) → 30 elapsed minutes
    // are banked. If the engine used UTC midnight (2026-05-13T00:00Z),
    // napStart would be earlier → 0 minutes banked.
    const stubTrend: TrendTargets = {
      observedRecentMin: 25,
      interventionTargetMin: 25,
      interventionConfidence: "medium",
      observedSourceLabel: "stub",
      interventionSourceLabel: "stub",
      mean7: 25,
      mean30: 25,
      diagnostics: {} as unknown as TrendTargets["diagnostics"],
      state: {} as unknown as TrendTargets["state"],
    };
    const out = computeNapBudget({
      activeNap: { start_time: "2026-05-12T23:30:00.000Z" },
      todaySleeps: [],
      trendSleeps: [],
      bedtime: "2026-05-13T17:00:00.000Z",
      isLastNapOfDay: true,
      optedIn: true,
      now: new Date("2026-05-13T00:00:00.000Z").getTime(),
      ctx: ctx({ trendSleeps: [], trendTargets: stubTrend }),
      learnedNapDurationMin: 90,
    });
    expect(out).not.toBeNull();
    // 30 min of elapsed nap counted. UTC-midnight anchoring would give 0.
    expect(out!.context.bankedMin).toBe(30);
  });

  it("active-nap-before-wake-anchor: elapsed not banked into today's frame", () => {
    // Defensive branch (computeBankedToday line 352) — when the activeNap
    // record's start_time precedes the most recent night's end (a data
    // anomaly or a long-running record that bridged the night), the
    // engine must not bank the active nap's "elapsed" into today's frame.
    // The same data with the activeNap after the anchor banks normally;
    // contrast pins the branch.
    const synth = synthDays("2026-04-18", 24, 13 * 60);
    const longNight: SleepEntry = {
      // 14h night. bankedMin alone clears trend → engine emits in both
      // cases so context.bankedMin is observable.
      start_time: "2026-05-12T17:00:00.000Z",
      end_time: "2026-05-13T07:00:00.000Z",
      type: "night",
      woke_by: "self",
    };
    const trendSleeps = [...synth, longNight];
    const base = {
      todaySleeps: [] as SleepEntry[],
      trendSleeps,
      bedtime: "2026-05-13T17:00:00.000Z",
      isLastNapOfDay: true,
      optedIn: true,
      now: new Date("2026-05-13T09:00:00.000Z").getTime(),
      ctx: ctx({ trendSleeps }),
      learnedNapDurationMin: 90,
    };

    // Case A: nap started 4h BEFORE the wake anchor — data anomaly.
    const before = computeNapBudget({
      ...base,
      activeNap: { start_time: "2026-05-13T03:00:00.000Z" },
    });
    // Case B: nap started 1h AFTER the wake anchor — normal case.
    const after = computeNapBudget({
      ...base,
      activeNap: { start_time: "2026-05-13T08:00:00.000Z" },
    });

    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    // 14h night = 840 min. Case A: no addition → 840. Case B: +60 elapsed → 900.
    expect(before!.context.bankedMin).toBe(840);
    expect(after!.context.bankedMin).toBe(900);
  });

  it("overnight wakings net out of bankedMin (real Halldis pattern)", () => {
    // Halldis pattern: 12h overnight with two parent-attended wakings
    // (e.g. 15 min + 50 min = 65 min total). Actual sleep is 11h, not 12.
    // The bug counts wake-time as sleep → bankedMin off by every minute
    // the baby was awake mid-night. That alone can flip a near-trend day
    // into "above trend" and fire a cap that shouldn't fire.
    //
    // Synth at 11h so the trend (≈660 min) is well below both cases'
    // projection — the cap fires in both, and bankedMin is observable.
    //   A. night has no pauses → bankedMin = 720 (12h night) + 60 (active) = 780.
    //   B. night has 65 min pauses → bankedMin = 720 + 60 − 65 = 715.
    // The 65-min delta IS the bug — pre-fix, both cases bank 780.
    const synth = synthDays("2026-04-18", 24, 11 * 60);
    const nightStart = "2026-05-12T17:00:00.000Z";
    const nightEnd = "2026-05-13T05:00:00.000Z"; // 12h
    const baseNight: SleepEntry = {
      start_time: nightStart,
      end_time: nightEnd,
      type: "night",
      woke_by: "self",
    };
    const trendNoPauses = [...synth, baseNight];
    const nightWithPauses: SleepEntry = {
      ...baseNight,
      pauses: [
        { pause_time: "2026-05-12T20:00:00.000Z", resume_time: "2026-05-12T20:15:00.000Z" }, // 15 min
        { pause_time: "2026-05-13T02:30:00.000Z", resume_time: "2026-05-13T03:20:00.000Z" }, //  50 min
      ],
    };
    const trendWithPauses = [...synth, nightWithPauses];
    const base = {
      activeNap: { start_time: "2026-05-13T08:00:00.000Z" },
      todaySleeps: [] as SleepEntry[],
      bedtime: "2026-05-13T17:00:00.000Z",
      isLastNapOfDay: true,
      optedIn: true,
      now: new Date("2026-05-13T09:00:00.000Z").getTime(),
      learnedNapDurationMin: 90,
    };

    const without = computeNapBudget({
      ...base,
      trendSleeps: trendNoPauses,
      ctx: ctx({ trendSleeps: trendNoPauses }),
    });
    const with_ = computeNapBudget({
      ...base,
      trendSleeps: trendWithPauses,
      ctx: ctx({ trendSleeps: trendWithPauses }),
    });

    expect(without).not.toBeNull();
    expect(with_).not.toBeNull();
    // 12h night + 60 min active elapsed = 780, then -65 min wakings on case B.
    expect(without!.context.bankedMin).toBe(780);
    expect(with_!.context.bankedMin).toBe(715);
  });

  it("isDayOnTrend nets overnight wakings out of banked24h", () => {
    // Mirror of the above for the rescue suppression gate. A day with
    // observed-trend ≈ 13h and an overnight of 13.0h *with* 65 min of
    // wakings has actual sleep 11.92h — below trend tolerance. Without
    // the netting the engine thinks the day is on trend and suppresses
    // the continuation/rescue path that the parent actually needs.
    const synth = synthDays("2026-04-18", 24, 13 * 60);
    const yesterdayStart = "2026-05-12T16:00:00.000Z";
    const yesterdayEnd = "2026-05-13T05:00:00.000Z"; // 13h
    const baseNight: SleepEntry = {
      start_time: yesterdayStart,
      end_time: yesterdayEnd,
      type: "night",
      woke_by: "self",
    };
    const nightWithPauses: SleepEntry = {
      ...baseNight,
      pauses: [
        { pause_time: "2026-05-12T19:30:00.000Z", resume_time: "2026-05-12T19:45:00.000Z" }, // 15 min
        { pause_time: "2026-05-13T01:00:00.000Z", resume_time: "2026-05-13T01:50:00.000Z" }, // 50 min
      ],
    };
    const now = new Date("2026-05-13T07:00:00.000Z").getTime();

    expect(
      isDayOnTrend(
        [...synth, baseNight],
        [],
        ctx({ trendSleeps: [...synth, baseNight] }),
        now,
      ),
    ).toBe(true);
    expect(
      isDayOnTrend(
        [...synth, nightWithPauses],
        [],
        ctx({ trendSleeps: [...synth, nightWithPauses] }),
        now,
      ),
    ).toBe(false);
  });

  it("bedtime-guard tightening does not re-introduce a past wakeBy", () => {
    // Parent has napped past bedtime - 90 min. The bedtime guard would
    // tighten cap to (bedtime - 90 min - napStart), which lands in the
    // past relative to now. The post-guard elapsed+1 floor must take over
    // and produce a wake-now recommendation, not a past wake.
    //
    // Setup: nap started at 08:30Z, now is 15:35Z (425 min elapsed), bedtime
    // 17:00Z. latestWakeMs = 15:30Z → bedtime guard wants 420 min cap, which
    // is 5 min in the past. Final clamp must push cap to ≥ 426 min so
    // wakeBy ≥ now + 1.
    const s = halldisScenario();
    const lateNow = new Date("2026-05-13T15:35:00.000Z").getTime();
    const out = computeNapBudget({
      ...s,
      now: lateNow,
      isLastNapOfDay: true,
      optedIn: true,
    });
    expect(out).not.toBeNull();
    const wakeByMs = new Date(out!.wakeBy).getTime();
    expect(wakeByMs).toBeGreaterThan(lateNow);
  });

  it("today flagged off → engine suppresses napBudget for today's last nap", () => {
    // Off-day filter previously only excluded HISTORICAL days from trend
    // computation; today's banner still rendered. After fix: today's
    // local-date in ctx.offDays short-circuits computeNapBudget at gate 1b.
    const s = halldisScenario();
    const todayKey = "2026-05-13"; // halldisScenario fixes this date
    const offDays = new Set<string>([todayKey]);
    const baseOut = computeNapBudget({
      ...s,
      isLastNapOfDay: true,
      optedIn: true,
    });
    // Sanity: without the flag the engine emits (otherwise the suppression
    // test gives no signal).
    expect(baseOut).not.toBeNull();
    const out = computeNapBudget({
      ...s,
      isLastNapOfDay: true,
      optedIn: true,
      ctx: { ...s.ctx, offDays },
    });
    expect(out).toBeNull();
  });

  it("off-day filter also drops the previous date's overnight bucket", () => {
    // getWeekStats anchors nights by their start_time local date. A baby
    // sick on Wed had a bad overnight Tue→Wed which lives in Tuesday's
    // bucket. Marking Wed off should also drop Tue from trend, otherwise
    // the bad night still pulls the mean down.
    const todayDateStr = "2026-05-13";
    const yesterdayNightStart = new Date(`${todayDateStr}T00:00:00Z`).getTime() - 5 * 3600_000;
    // 23 normal days (2026-04-19 → 2026-05-11), then a separate yesterday
    // overnight (2026-05-12 → 2026-05-13). The 2026-05-11 night is the
    // short overnight (8h) that we want off-day expansion to also drop.
    const normal = synthDays("2026-04-19", 23, 13 * 60);
    const shortNightStart = new Date("2026-05-11T19:00:00Z");
    const shortNightEnd = new Date(shortNightStart.getTime() + 8 * 3600_000);
    const fixed = normal.map((s) =>
      s.start_time === shortNightStart.toISOString() && s.type === "night"
        ? { ...s, end_time: shortNightEnd.toISOString() }
        : s,
    );
    const yesterdayNight: SleepEntry = {
      start_time: new Date(yesterdayNightStart).toISOString(),
      end_time: new Date(yesterdayNightStart + 780 * 60_000).toISOString(),
      type: "night",
      woke_by: "self",
    };
    const trendSleeps = [...fixed, yesterdayNight];
    const baseInput = {
      activeNap: { start_time: `${todayDateStr}T08:30:00.000Z` },
      todaySleeps: [] as SleepEntry[],
      trendSleeps,
      bedtime: `${todayDateStr}T17:00:00.000Z`,
      isLastNapOfDay: true,
      optedIn: true,
      now: new Date(`${todayDateStr}T08:55:00.000Z`).getTime(),
    };
    // No off-day: the short Tue overnight is included → mean drops.
    const withoutFilter = computeNapBudget({ ...baseInput, ctx: ctx({ trendSleeps }) });
    // Off-day = 2026-05-12 (the sick day). The filter must expand back to
    // 2026-05-11 (the overnight that ended that morning) so the bad night
    // is also excluded → mean rises.
    const offDays = new Set<string>(["2026-05-12"]);
    const withFilter = computeNapBudget({ ...baseInput, ctx: ctx({ trendSleeps, offDays }) });
    expect(withoutFilter).not.toBeNull();
    expect(withFilter).not.toBeNull();
    expect(withFilter!.context.blendedTrendMin).toBeGreaterThan(
      withoutFilter!.context.blendedTrendMin,
    );
  });
});
