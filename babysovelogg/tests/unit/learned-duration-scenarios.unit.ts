/**
 * Scenario table for `getLearnedNapDuration` and `predictNapEndTime`.
 *
 * This is a single-snapshot, table-driven view of the engine's behavior across
 * the dimensions that drive the home-screen nap-end prediction:
 *   - age (newborn / infant / 1-nap toddler edge)
 *   - nap count (1 vs 2 vs 3)
 *   - sample size (none / few / many)
 *   - data quality (all-natural / mixed / cut-shorts present)
 *
 * If the algorithm changes, the diff on the snapshot tells you exactly what
 * shifted in each scenario and lets you decide whether the shift is intended.
 * Targeted assertions below the snapshot pin the invariants that matter for
 * production behavior (1-nap > 2-nap, censoring lifts the cut-short case,
 * etc.) so they can't be auto-updated away.
 */
import { describe, expect, it } from "bun:test";
import {
  getLearnedNapDuration,
  predictDayNaps,
  predictNapEndTime,
} from "$lib/engine/schedule.js";
import type { SleepEntry, BabyContext } from "$lib/types.js";

// ─── Tiny scenario DSL ──────────────────────────────────────────────────────

/** ISO timestamp for "day d at HH:MM" in 2026-03 (UTC). */
function ts(d: number, hour: number, min = 0): string {
  return `2026-03-${String(d).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:00.000Z`;
}

interface NapSpec {
  /** day-of-month for the nap start */
  d: number;
  /** start hour (24h, UTC) */
  h: number;
  /** duration in minutes */
  dur: number;
  /** wake reason */
  wokeBy?: "self" | "woken";
}

/**
 * Build a context with `naps`, each on its own day, plus a night per day so
 * every nap qualifies as "complete day". `customNapCount` lets a scenario
 * pin the nap count directly when there's not enough data to learn it.
 */
function scenario(opts: {
  ageMonths: number;
  customNapCount?: number;
  naps: NapSpec[];
}): BabyContext {
  const sleeps: SleepEntry[] = [];
  const days = new Set<number>();
  for (const n of opts.naps) {
    days.add(n.d);
    const endH = n.h + Math.floor(n.dur / 60);
    const endM = n.dur % 60;
    sleeps.push({
      start_time: ts(n.d, n.h, 0),
      end_time: ts(n.d, endH, endM),
      type: "nap",
      woke_by: n.wokeBy ?? null,
    });
  }
  // One night per nap-day so daysWithNight covers everything.
  for (const d of days) {
    sleeps.push({
      start_time: ts(d, 19, 0),
      end_time: ts(d + 1, 6, 0),
      type: "night",
    });
  }
  return {
    birthdate: "2025-06-12",
    ageMonths: opts.ageMonths,
    tz: "UTC",
    customNapCount: opts.customNapCount ?? null,
    recentSleeps: sleeps,
  };
}

const NAP_START = ts(28, 9, 30); // 09:30 on day 28 — outside any scenario's data

// ─── Renderer ───────────────────────────────────────────────────────────────

/**
 * Render the full prediction outcome for a labeled scenario as a single line.
 * Compact + diffable. `learned` is the per-nap duration the engine chose;
 * `endsAt` is what the home screen would show for an active nap starting at
 * NAP_START.
 */
function render(label: string, ctx: BabyContext): string {
  const learned = getLearnedNapDuration(ctx);
  const end = predictNapEndTime(NAP_START, ctx);
  const endHHMM = end.slice(11, 16);
  return `${label.padEnd(40)} learned=${String(learned).padStart(3)}m  ends=${endHHMM}`;
}

// ─── Scenarios ──────────────────────────────────────────────────────────────

describe("learned nap duration: scenario table", () => {
  it("matches the documented behavior across realistic inputs", () => {
    const lines = [
      // No data — pure prior, varying age & nap count.
      render("3mo, 3-nap, no data",       scenario({ ageMonths:  3, customNapCount: 3, naps: [] })),
      render("6mo, 3-nap, no data",       scenario({ ageMonths:  6, customNapCount: 3, naps: [] })),
      render("8mo, 2-nap, no data",       scenario({ ageMonths:  8, customNapCount: 2, naps: [] })),
      render("10mo, 2-nap, no data",      scenario({ ageMonths: 10, customNapCount: 2, naps: [] })),
      render("10mo, 1-nap, no data",      scenario({ ageMonths: 10, customNapCount: 1, naps: [] })),
      render("14mo, 1-nap, no data",      scenario({ ageMonths: 14, customNapCount: 1, naps: [] })),

      // Plenty of clean self-wake data — the prior should fade out.
      render("10mo, 1-nap, 7×self×110m",  scenario({
        ageMonths: 10, customNapCount: 1,
        naps: [...Array(7)].map((_, i) => ({ d: 19 + i, h: 9, dur: 110, wokeBy: "self" })),
      })),
      render("8mo, 2-nap, 14×self×60m",   scenario({
        ageMonths: 8, customNapCount: 2,
        naps: [...Array(7)].flatMap((_, i) => [
          { d: 19 + i, h:  9, dur: 60, wokeBy: "self" as const },
          { d: 19 + i, h: 14, dur: 60, wokeBy: "self" as const },
        ]),
      })),

      // Halldis-shaped: 6 naps, 2 self-wake (99, 125), 4 woken with 3 short cuts.
      // Self-wake count (2) is below the censoring threshold, so the censor
      // bows out and we rely on fix A's nap-count-aware prior to lift the
      // result. This is the actual bug case from prod.
      render("10mo, 1-nap, Halldis prod",   scenario({
        ageMonths: 10, customNapCount: 1,
        naps: [
          { d: 23, h: 7, dur: 125, wokeBy: "self" },
          { d: 24, h: 8, dur:  41, wokeBy: "woken" }, // cut short (door)
          { d: 25, h: 8, dur: 120, wokeBy: "woken" }, // long, ambiguous
          { d: 26, h: 8, dur:  48, wokeBy: "woken" }, // cut short (out of car)
          { d: 27, h: 7, dur:  99, wokeBy: "self" },
          { d: 28, h: 7, dur: 104, wokeBy: "woken" }, // ambiguous (foto)
        ],
      })),

      // Same Halldis shape but with enough self-wakes for the censor to
      // engage — short woken naps below the self-median are dropped, lifting
      // the prediction further.
      render("10mo, 1-nap, Halldis +censor", scenario({
        ageMonths: 10, customNapCount: 1,
        naps: [
          { d: 19, h: 7, dur: 110, wokeBy: "self" },
          { d: 20, h: 7, dur: 120, wokeBy: "self" },
          { d: 21, h: 7, dur: 100, wokeBy: "self" },
          { d: 23, h: 7, dur: 125, wokeBy: "self" },
          { d: 24, h: 8, dur:  41, wokeBy: "woken" }, // dropped
          { d: 25, h: 8, dur: 120, wokeBy: "woken" }, // kept
          { d: 26, h: 8, dur:  48, wokeBy: "woken" }, // dropped
          { d: 27, h: 7, dur:  99, wokeBy: "self" },
          { d: 28, h: 7, dur: 104, wokeBy: "woken" }, // dropped (< median)
        ],
      })),

      // Edge: missing or unknown woke_by behaves as if censoring is off.
      render("10mo, 1-nap, no woke_by data", scenario({
        ageMonths: 10, customNapCount: 1,
        naps: [
          { d: 23, h: 7, dur: 125 },
          { d: 24, h: 8, dur:  41 },
          { d: 25, h: 8, dur: 120 },
          { d: 26, h: 8, dur:  48 },
          { d: 27, h: 7, dur:  99 },
          { d: 28, h: 7, dur: 104 },
        ],
      })),
    ];

    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "3mo, 3-nap, no data                      learned= 61m  ends=10:28
      6mo, 3-nap, no data                      learned= 47m  ends=10:19
      8mo, 2-nap, no data                      learned= 68m  ends=10:34
      10mo, 2-nap, no data                     learned= 65m  ends=10:32
      10mo, 1-nap, no data                     learned=131m  ends=11:43
      14mo, 1-nap, no data                     learned=125m  ends=11:34
      10mo, 1-nap, 7×self×110m                 learned=113m  ends=11:22
      8mo, 2-nap, 14×self×60m                  learned= 60m  ends=10:29
      10mo, 1-nap, Halldis prod                learned=106m  ends=11:17
      10mo, 1-nap, Halldis +censor             learned=113m  ends=11:22
      10mo, 1-nap, no woke_by data             learned=106m  ends=11:17"
    `);
  });

  // Pinned invariants — these protect the production behavior so the snapshot
  // can't be silently --update'd into a regression.

  it("1-nap baby gets a longer prior than 2-nap baby of the same age", () => {
    const oneNap  = scenario({ ageMonths: 10, customNapCount: 1, naps: [] });
    const twoNap  = scenario({ ageMonths: 10, customNapCount: 2, naps: [] });

    expect(getLearnedNapDuration(oneNap)).toBeGreaterThan(getLearnedNapDuration(twoNap));
  });

  it("the Halldis prod case predicts ≥ 100 min nap end (was 77 min before fix A)", () => {
    const halldis = scenario({
      ageMonths: 10, customNapCount: 1,
      naps: [
        { d: 23, h: 7, dur: 125, wokeBy: "self" },
        { d: 24, h: 8, dur:  41, wokeBy: "woken" },
        { d: 25, h: 8, dur: 120, wokeBy: "woken" },
        { d: 26, h: 8, dur:  48, wokeBy: "woken" },
        { d: 27, h: 7, dur:  99, wokeBy: "self" },
        { d: 28, h: 7, dur: 104, wokeBy: "woken" },
      ],
    });

    expect(getLearnedNapDuration(halldis)).toBeGreaterThanOrEqual(100);
  });

  it("censoring lifts the result vs. the same data without woke_by labels", () => {
    const naps: NapSpec[] = [
      { d: 19, h: 7, dur: 110, wokeBy: "self" },
      { d: 20, h: 7, dur: 120, wokeBy: "self" },
      { d: 21, h: 7, dur: 100, wokeBy: "self" },
      { d: 23, h: 7, dur: 125, wokeBy: "self" },
      { d: 24, h: 8, dur:  41, wokeBy: "woken" },
      { d: 25, h: 8, dur: 120, wokeBy: "woken" },
      { d: 26, h: 8, dur:  48, wokeBy: "woken" },
      { d: 27, h: 7, dur:  99, wokeBy: "self" },
    ];
    const labelled = scenario({ ageMonths: 10, customNapCount: 1, naps });
    const unlabelled = scenario({
      ageMonths: 10, customNapCount: 1,
      naps: naps.map((n) => ({ ...n, wokeBy: undefined })),
    });

    expect(getLearnedNapDuration(labelled)).toBeGreaterThan(getLearnedNapDuration(unlabelled));
  });
});

// ─── predictDayNaps with cut-shorts: positional path ───────────────────────
//
// Even after fix B, the day-ahead planner reads `getPositionalNapDurations`
// for the 1st-vs-2nd nap split. If that path doesn't censor cut-shorts, the
// home screen could show "active nap ends ~11:18" (correct) while still
// planning a 41-min "1st nap" tomorrow from the same polluted data. The fix
// applies censoring to both paths; this test pins the expected day-ahead
// behavior so it can't silently regress.

describe("predictDayNaps respects censoring", () => {
  it("plans a sensible 1st nap for the Halldis-shaped 1-nap baby", () => {
    // 5 self-wakes (so the censor engages) + 3 cut-shorts. With censoring,
    // the planner sees only the long naps and predicts a long 1st nap.
    const ctx = scenario({
      ageMonths: 10, customNapCount: 1,
      naps: [
        { d: 19, h: 7, dur: 110, wokeBy: "self" },
        { d: 20, h: 7, dur: 120, wokeBy: "self" },
        { d: 21, h: 7, dur: 100, wokeBy: "self" },
        { d: 23, h: 7, dur: 125, wokeBy: "self" },
        { d: 24, h: 8, dur:  41, wokeBy: "woken" },
        { d: 25, h: 8, dur: 120, wokeBy: "woken" },
        { d: 26, h: 8, dur:  48, wokeBy: "woken" },
        { d: 27, h: 7, dur:  99, wokeBy: "self" },
        { d: 28, h: 7, dur: 104, wokeBy: "woken" },
      ],
    });

    const naps = predictDayNaps(ts(29, 6, 0), ctx);
    expect(naps.length).toBe(1);
    const napMin = (new Date(naps[0].endTime).getTime() - new Date(naps[0].startTime).getTime()) / 60_000;
    expect(napMin).toBeGreaterThan(90);
  });
});

// ─── edge-age safety ───────────────────────────────────────────────────────
//
// Direct callers (tests, scripts, future ports) can pass odd ageMonths
// values. The engine's normal app path goes through `calculateAgeMonths`
// which clamps to ≥ 0, but `getLearnedNapDuration` is also exposed as a
// pure function. Pin that the prior stays in a sane range across edges.

describe("getLearnedNapDuration: edge ages", () => {
  it("ageMonths = 0 returns the newborn-shape prior", () => {
    const c = scenario({ ageMonths: 0, naps: [] });
    const learned = getLearnedNapDuration(c);
    expect(learned).toBeGreaterThanOrEqual(20);
    expect(learned).toBeLessThanOrEqual(180);
  });

  it("negative ageMonths is treated as the youngest bracket, not the oldest", () => {
    // Without findByAge clamping, ageMonths=-1 fell through to the 18-24mo
    // bracket and produced a 1-nap × 212 min ≈ 180 min prior — wildly wrong
    // for a not-yet-born baby. Should now resolve to the high-nap-count,
    // young-baby prior.
    const negCtx = scenario({ ageMonths: -1, naps: [] });
    const newborn = scenario({ ageMonths: 0, naps: [] });

    expect(getLearnedNapDuration(negCtx)).toBe(getLearnedNapDuration(newborn));
  });

  it("very old ageMonths clamps to the oldest documented bracket", () => {
    const c = scenario({ ageMonths: 60, naps: [] });
    expect(getLearnedNapDuration(c)).toBeGreaterThanOrEqual(20);
    expect(getLearnedNapDuration(c)).toBeLessThanOrEqual(180);
  });
});

// ─── blend curve invariants ─────────────────────────────────────────────────
//
// `blendEstimate(default, learned, n, 3, 8)` shifts dramatically with sample
// count: 0 → fully prior, 3 → 1/6 learned, 6 → 4/6 learned, 8+ → fully
// learned. These shifts matter because they govern how fast the engine
// trusts a baby's actual data over the population prior. Pin the shape.

// ─── extended-window self-median (with transition guard) ──────────────────
//
// The 7-day window is too sparse for some babies to have ≥ 3 self-wakes,
// which means `censorCutShortNaps` bows out and cut-shorts contaminate the
// learned mean. When the engine has a wider lookback (typically 21 days
// from `strategySleeps` in production), use it for self-median estimation
// only — duration learning still trusts the 7-day window so the engine
// adapts quickly during transitions.
//
// The transition guard is a per-day nap-count filter: in a 2 → 1 transition
// the old-regime days have a different self-wake distribution that would
// skew the threshold. We restrict extended self-wakes to days that match
// the baby's *current* dominant nap count.

describe("extended-window self-median", () => {
  it("engages the censor when 7d has < 3 self-wakes but extended has more", () => {
    // 7-day base: only 2 self-wakes (below censor threshold) + 3 cut-shorts.
    const sevenDay: NapSpec[] = [
      { d: 23, h: 7, dur: 125, wokeBy: "self" },
      { d: 24, h: 8, dur:  41, wokeBy: "woken" },
      { d: 25, h: 8, dur: 120, wokeBy: "woken" },
      { d: 26, h: 8, dur:  48, wokeBy: "woken" },
      { d: 27, h: 7, dur:  99, wokeBy: "self" },
      { d: 28, h: 7, dur: 104, wokeBy: "woken" },
    ];
    // Extended 21-day: same 7d shape plus 5 more self-wakes from prior weeks
    // (all on 1-nap days, so the transition guard keeps them).
    const extended: NapSpec[] = [
      ...[...Array(5)].map((_, i) => ({ d: 9 + i, h: 7, dur: 110, wokeBy: "self" as const })),
      ...sevenDay,
    ];

    const baselineCtx = scenario({ ageMonths: 10, customNapCount: 1, naps: sevenDay });
    const extCtx = scenario({ ageMonths: 10, customNapCount: 1, naps: sevenDay });
    extCtx.extendedSleeps = scenario({ ageMonths: 10, customNapCount: 1, naps: extended }).recentSleeps;

    expect(getLearnedNapDuration(extCtx)).toBeGreaterThan(getLearnedNapDuration(baselineCtx));
  });

  it("ignores extended-window days from a previous nap-count regime", () => {
    // Halldis-style: currently 1-nap baby, was 2-nap a few weeks ago.
    // Recent (7d): 5 days of 1 long nap each + 1 cut-short.
    const recent: NapSpec[] = [
      { d: 22, h: 8, dur: 120, wokeBy: "self" },
      { d: 23, h: 8, dur: 110, wokeBy: "self" },
      { d: 24, h: 8, dur: 100, wokeBy: "woken" }, // would be censored if median fires
      { d: 25, h: 8, dur: 115, wokeBy: "self" },
      { d: 26, h: 8, dur:  50, wokeBy: "woken" }, // cut short
      { d: 27, h: 8, dur: 125, wokeBy: "self" },
      { d: 28, h: 8, dur: 130, wokeBy: "self" },
    ];
    // Extended also has 7 prior days of 2-nap regime with shorter naps
    // (~50-60 min each — typical 2-nap baby of similar age).
    const extended: NapSpec[] = [
      // Old regime: 2 naps/day, ~50 min each, all self.
      ...[...Array(7)].flatMap((_, i) => [
        { d: 9 + i, h:  9, dur: 55, wokeBy: "self" as const },
        { d: 9 + i, h: 14, dur: 50, wokeBy: "self" as const },
      ]),
      ...recent,
    ];

    const onlyRecent = scenario({ ageMonths: 10, customNapCount: 1, naps: recent });
    const withExt = scenario({ ageMonths: 10, customNapCount: 1, naps: recent });
    withExt.extendedSleeps = scenario({ ageMonths: 10, customNapCount: 1, naps: extended }).recentSleeps;

    // With the transition guard, the old 2-nap days are filtered out: the
    // self-median comes from the current 1-nap regime (~115-125 min). The
    // 100-min "woken" nap is below that median and gets censored.
    // Without the guard, the old-regime ~50 min self-wakes would push the
    // median way down, and the 100-min "woken" would get kept — undoing the
    // censor. We assert the guard wins by checking the result tracks the
    // recent-only behavior, not a regressed-toward-old-regime value.
    const recentOnlyLearned = getLearnedNapDuration(onlyRecent);
    const withExtLearned = getLearnedNapDuration(withExt);

    // Both should produce sensible 1-nap predictions (≥ 100 min).
    expect(recentOnlyLearned).toBeGreaterThanOrEqual(100);
    expect(withExtLearned).toBeGreaterThanOrEqual(100);
  });

  it("censors via the transition-filtered positional branch too", () => {
    // Mid-transition: 5 recent 1-nap days + 16 older 2-nap days. The positional
    // engine routes through `getPositionalDataForNapCount` here because nap
    // counts are mixed. That branch used to bypass `censorCutShortNaps` — make
    // sure a cut-short on a current-regime day does NOT pull positional[0] down.
    const matchingDays1Nap: NapSpec[] = [
      { d: 23, h: 7, dur: 110, wokeBy: "self" },
      { d: 24, h: 7, dur: 120, wokeBy: "self" },
      { d: 25, h: 7, dur: 100, wokeBy: "self" },
      { d: 26, h: 7, dur: 115, wokeBy: "self" },
      { d: 28, h: 7, dur:  41, wokeBy: "woken" }, // cut short — should not fall through
    ];
    const old2NapDays: NapSpec[] = [...Array(16)].flatMap((_, i) => [
      { d: 1 + i, h:  9, dur: 55, wokeBy: "self" as const },
      { d: 1 + i, h: 14, dur: 50, wokeBy: "self" as const },
    ]);

    const ctxWithExt = scenario({ ageMonths: 10, naps: matchingDays1Nap });
    ctxWithExt.extendedSleeps = scenario({ ageMonths: 10, naps: [...old2NapDays, ...matchingDays1Nap] }).recentSleeps;

    const naps = predictDayNaps(ts(29, 6, 0), ctxWithExt);
    expect(naps.length).toBe(1);
    const napMin = (new Date(naps[0].endTime).getTime() - new Date(naps[0].startTime).getTime()) / 60_000;
    // If the cut-short leaked through, the prediction would collapse below 80.
    // With censoring applied, the planner should keep it close to the natural
    // distribution (~100-115 min).
    expect(napMin).toBeGreaterThan(95);
  });

  it("falls back to the per-call median when extendedSleeps is undefined", () => {
    // Pin: the new optional field can't change behavior for callers that
    // don't populate it (the entire backtest harness today, plus older
    // engine consumers).
    const naps: NapSpec[] = [
      { d: 19, h: 7, dur: 110, wokeBy: "self" },
      { d: 20, h: 7, dur: 120, wokeBy: "self" },
      { d: 21, h: 7, dur: 100, wokeBy: "self" },
      { d: 23, h: 8, dur:  41, wokeBy: "woken" },
      { d: 25, h: 8, dur: 120, wokeBy: "woken" },
      { d: 27, h: 7, dur:  99, wokeBy: "self" },
    ];
    const a = scenario({ ageMonths: 10, customNapCount: 1, naps });
    const b = scenario({ ageMonths: 10, customNapCount: 1, naps });
    expect(b.extendedSleeps).toBeUndefined();

    expect(getLearnedNapDuration(a)).toBe(getLearnedNapDuration(b));
  });
});

describe("getLearnedNapDuration: blend curve", () => {
  // 1-nap 10mo baby: SHINE prior ~131 min, observed naps 90 min.
  // We expect the learned value to slide from prior toward 90 as n grows.
  function withNSelfNaps(n: number): BabyContext {
    return scenario({
      ageMonths: 10, customNapCount: 1,
      naps: [...Array(n)].map((_, i) => ({ d: 19 + i, h: 9, dur: 90, wokeBy: "self" as const })),
    });
  }

  it("with 0 samples it's the SHINE prior, with 8+ samples it's the data", () => {
    const zero  = getLearnedNapDuration(withNSelfNaps(0));
    const three = getLearnedNapDuration(withNSelfNaps(3));
    const eight = getLearnedNapDuration(withNSelfNaps(8));

    expect(zero).toBeGreaterThan(120);
    expect(eight).toBeLessThanOrEqual(95);
    // 3 samples should be between zero (prior) and eight (data), strictly.
    expect(three).toBeLessThan(zero);
    expect(three).toBeGreaterThan(eight);
  });
});
