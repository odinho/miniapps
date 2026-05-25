/**
 * Sleep cycle estimator v2 — research-backed scoring with explicit
 * source/confidence/diagnostics. See `estimateSleepCycleDetails` in
 * `src/lib/engine/schedule.ts` and the "Cycle estimator v2" plan in
 * `docs/followups.md`.
 *
 * Structure follows `docs/testing.md`: one table-driven render+snapshot
 * over a curated scenario set (spec fixtures + Codex's adversarial set),
 * with invariants pinned below the snapshot so `--update-snapshots`
 * can't paste a regression away.
 */
import { describe, expect, it } from "bun:test";
import {
  estimateSleepCycleDetails,
  estimateSleepCycleFromData,
  getSleepCyclePrior,
} from "$lib/engine/schedule.js";
import type { SleepEntry, BabyContext } from "$lib/types.js";

// ─── Tiny scenario DSL ──────────────────────────────────────────────────────

const ts = (d: number, hour: number, min = 0): string =>
  `2026-05-${String(d).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:00.000Z`;

interface NapSpec {
  d: number;
  h: number;
  durMin: number;
  /** Defaults to "self" (cycle samples are strict self-wake only). Use
   *  null explicitly to test the missing-wake-reason path. */
  wokeBy?: "self" | "woken" | null;
}

function ctxOf(opts: {
  ageMonths: number;
  customNapCount?: number;
  naps: NapSpec[];
  offDays?: string[];
}): BabyContext {
  const sleeps: SleepEntry[] = [];
  const dayKeys = new Set<number>();
  for (const n of opts.naps) {
    dayKeys.add(n.d);
    const endMin = n.h * 60 + n.durMin;
    sleeps.push({
      start_time: ts(n.d, n.h),
      end_time: ts(n.d, Math.floor(endMin / 60), endMin % 60),
      type: "nap",
      woke_by: n.wokeBy === undefined ? "self" : n.wokeBy,
    });
  }
  for (const d of dayKeys) {
    sleeps.push({ start_time: ts(d, 19), end_time: ts(d + 1, 6), type: "night" });
  }
  return {
    birthdate: "2025-06-12",
    ageMonths: opts.ageMonths,
    tz: "UTC",
    customNapCount: opts.customNapCount ?? null,
    recentSleeps: sleeps,
    cycleSleeps: sleeps,
    offDays: opts.offDays ? new Set(opts.offDays) : undefined,
  };
}

/** N self-wake naps at `dur` minutes spread across consecutive days starting at `startDay`. */
const selfRun = (
  count: number,
  dur: number,
  startDay = 1,
  wokeBy: "self" | "woken" | null = "self",
): NapSpec[] =>
  Array.from({ length: count }, (_, i) => ({ d: startDay + i, h: 10, durMin: dur, wokeBy }));

// ─── Renderer ───────────────────────────────────────────────────────────────

/** One compact line per scenario: shows every field a consumer might read,
 *  so any future field addition surfaces in the snapshot diff. */
function render(label: string, ctx: BabyContext): string {
  const e = estimateSleepCycleDetails(ctx);
  const m = `c=${String(e.minutes).padStart(2)}m`;
  const src = `src=${e.source.padEnd(11)}`;
  const cnf = `conf=${e.confidence.padEnd(6)}`;
  const n = `N=${e.sampleCount.toFixed(1).padStart(5)}`;
  const sign = e.scoreMargin >= 0 ? "+" : "-";
  const mg = `margin=${sign}${Math.abs(e.scoreMargin).toFixed(2).padStart(5)}`;
  const rng = `range=[${e.candidateRange[0]},${e.candidateRange[1]}]`;
  return `${label.padEnd(46)} ${m}  ${src}  ${cnf}  ${n}  ${mg}  ${rng}`;
}

// ─── The scenario table ─────────────────────────────────────────────────────

describe("cycle estimator v2: scenario table", () => {
  it("matches the documented behavior across spec + adversarial fixtures", () => {
    const lines = [
      // ── Spec fixtures from docs/followups.md ────────────────────────────
      // Halldis-shape: 1 lonely self-wake among parent-woken caps — must
      // bail to age-default low because effectiveN < 5.
      render("11mo, Halldis-shape (1 self, 6 woken)", ctxOf({
        ageMonths: 11, customNapCount: 1,
        naps: [
          ...selfRun(6, 84, 1, "woken"),
          { d: 7, h: 10, durMin: 110, wokeBy: "self" },
        ],
      })),
      // Same baby once enough self-wakes accrue: lock in 55min.
      render("11mo, 12 self-wakes @ 110m",            ctxOf({
        ageMonths: 11, customNapCount: 1, naps: selfRun(12, 110),
      })),
      // 7mo at 50min: edge of plausible range, needs MANY very-tight
      // samples to clear the tightened high-confidence gate (Codex
      // 2026-05-25 — 0.5σ residuals alone are too easy a bar).
      render("7mo, 22 self-wakes @ 50m (2-nap)",      ctxOf({
        ageMonths: 7, customNapCount: 2,
        naps: Array.from({ length: 11 }, (_, i) => [
          { d: i + 1, h:  9, durMin: 50, wokeBy: "self" as const },
          { d: i + 1, h: 14, durMin: 50, wokeBy: "self" as const },
        ]).flat(),
      })),
      // 111min cluster: c=37 is the classic subharmonic trap. The
      // age-plausible range [50, 65] cuts c=37 out entirely.
      render("11mo, 10 self-wakes @ 111m (alias)",    ctxOf({
        ageMonths: 11, customNapCount: 1, naps: selfRun(10, 111),
      })),

      // ── Adversarial fixtures (Codex 2026-05-24 design review) ──────────
      render("11mo, uniform 30-180m noise",           ctxOf({
        ageMonths: 11, customNapCount: 1,
        naps: [33, 71, 142, 95, 47, 128, 58, 105, 161, 38, 87, 153, 67, 119, 41]
          .map((dur, i) => ({ d: i + 1, h: 10, durMin: dur })),
      })),
      render("11mo, bimodal 52m + 63m",               ctxOf({
        ageMonths: 11, customNapCount: 1,
        naps: [...selfRun(6, 52, 1), ...selfRun(6, 63, 10)],
      })),
      render("11mo, 10 @ 110m but all off-days",      ctxOf({
        ageMonths: 11, customNapCount: 1,
        naps: selfRun(10, 110),
        offDays: Array.from({ length: 10 }, (_, i) => ts(i + 1, 0).slice(0, 10)),
      })),
      render("11mo, 12 @ 110m but woke_by=null",      ctxOf({
        ageMonths: 11, customNapCount: 1, naps: selfRun(12, 110, 1, null),
      })),
      // Mixed regime: old 2-nap days at 50m, new 1-nap days at 60m.
      // Should land between but never high — the regime weight and
      // recency together should prevent overfitting either cluster.
      render("11mo, old 2-nap @50m + new 1-nap @60m", ctxOf({
        ageMonths: 11, customNapCount: 1,
        naps: [
          ...Array.from({ length: 8 }, (_, i) => [
            { d: i + 1, h:  9, durMin: 50, wokeBy: "self" as const },
            { d: i + 1, h: 14, durMin: 50, wokeBy: "self" as const },
          ]).flat(),
          ...selfRun(4, 60, 25),
        ],
      })),
      // Age boundary: same data, prior shifts 55→60 across 12mo line.
      render("11.9mo, 12 self-wakes @ 55m",           ctxOf({
        ageMonths: 11.9, customNapCount: 1, naps: selfRun(12, 55),
      })),
      render("12.1mo, 12 self-wakes @ 55m",           ctxOf({
        ageMonths: 12.1, customNapCount: 1, naps: selfRun(12, 55),
      })),
      // Long 180min cluster at 14mo: in [55, 70] range, 180/3 = 60 exact.
      render("14mo, 10 self-wakes @ 180m",            ctxOf({
        ageMonths: 14, customNapCount: 1, naps: selfRun(10, 180),
      })),
      // 12-24mo @ 110min: Codex flagged this as a missing edge case —
      // 110/2 = 55 sits below the toddler range [55, 70], so the scorer
      // must NOT pick an alias at the range edge (64 ≈ 110/1.72) just
      // because no perfect 2-cycle fit exists in-range.
      render("14mo, 12 self-wakes @ 110m",            ctxOf({
        ageMonths: 14, customNapCount: 1, naps: selfRun(12, 110),
      })),
      // Cap-respect carve-out: 8 clean self-wakes establish cycle, 20
      // woken naps at boundary-aligned 55min must NOT shift the estimate.
      // 8 self-wakes is the minimum that clears N≥5 with recency-0.5 floor
      // (effective N = 8 × 0.75 = 6.0); below that, both sides trivially
      // hit age-default and the invariance check passes vacuously.
      render("11mo, 8 self@110 + 20 woken@55",        ctxOf({
        ageMonths: 11, customNapCount: 1,
        naps: [...selfRun(8, 110, 1), ...selfRun(20, 55, 10, "woken")],
      })),
      // Subharmonic-trap reproduction. Old `estimateSleepCycleFromData`
      // (search range 35-60, no prior, zero-distance scoring) would have
      // picked c=37 here: 110/3 ≈ 36.7 and 165/4 = 41.25 both score
      // perfectly under a residual-only scorer. The new estimator's
      // age-plausible range [50, 65] for 11mo excludes c=37 entirely,
      // so the result must stay in-range — pinning the alias-defense.
      render("11mo, 12@110m + 8@165m (alias trap)",   ctxOf({
        ageMonths: 11, customNapCount: 1,
        naps: [...selfRun(12, 110, 1), ...selfRun(8, 165, 15)],
      })),
    ];

    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "11mo, Halldis-shape (1 self, 6 woken)          c=55m  src=age-default  conf=low     N=  1.0  margin=+ 0.00  range=[50,65]
      11mo, 12 self-wakes @ 110m                     c=55m  src=learned      conf=medium  N=  9.0  margin=+ 0.00  range=[50,65]
      7mo, 22 self-wakes @ 50m (2-nap)               c=50m  src=learned      conf=high    N= 16.5  margin=+12.11  range=[50,65]
      11mo, 10 self-wakes @ 111m (alias)             c=55m  src=learned      conf=medium  N=  7.5  margin=+ 0.00  range=[50,65]
      11mo, uniform 30-180m noise                    c=55m  src=age-default  conf=low     N= 11.2  margin=+ 7.65  range=[50,65]
      11mo, bimodal 52m + 63m                        c=55m  src=age-default  conf=low     N=  9.0  margin=+ 3.09  range=[50,65]
      11mo, 10 @ 110m but all off-days               c=55m  src=age-default  conf=low     N=  0.0  margin=+ 0.00  range=[50,65]
      11mo, 12 @ 110m but woke_by=null               c=55m  src=age-default  conf=low     N=  0.0  margin=+ 0.00  range=[50,65]
      11mo, old 2-nap @50m + new 1-nap @60m          c=55m  src=age-default  conf=low     N=  9.0  margin=+ 0.17  range=[50,65]
      11.9mo, 12 self-wakes @ 55m                    c=55m  src=learned      conf=medium  N=  9.0  margin=+ 0.00  range=[50,65]
      12.1mo, 12 self-wakes @ 55m                    c=55m  src=learned      conf=medium  N=  9.0  margin=+ 6.53  range=[55,70]
      14mo, 10 self-wakes @ 180m                     c=60m  src=learned      conf=medium  N=  7.5  margin=+ 0.00  range=[55,70]
      14mo, 12 self-wakes @ 110m                     c=55m  src=learned      conf=medium  N=  9.0  margin=+27.63  range=[55,70]
      11mo, 8 self@110 + 20 woken@55                 c=55m  src=learned      conf=medium  N=  6.0  margin=+ 0.00  range=[50,65]
      11mo, 12@110m + 8@165m (alias trap)            c=55m  src=learned      conf=high    N= 15.0  margin=+ 0.00  range=[50,65]"
    `);

    // ── Invariants pinned below the snapshot ─────────────────────────────
    // Any of these failing means a real regression — `--update-snapshots`
    // can't paste them away.

    // The two flagship fixtures from the spec: Halldis-shape must fall back
    // safely, the 12-self-wake case must learn.
    const halldisShape = estimateSleepCycleDetails(ctxOf({
      ageMonths: 11, customNapCount: 1,
      naps: [
        ...selfRun(6, 84, 1, "woken"),
        { d: 7, h: 10, durMin: 110, wokeBy: "self" },
      ],
    }));
    expect(halldisShape.source).toBe("age-default");
    expect(halldisShape.confidence).toBe("low");
    expect(halldisShape.minutes).toBe(55);

    const halldis12 = estimateSleepCycleDetails(ctxOf({
      ageMonths: 11, customNapCount: 1, naps: selfRun(12, 110),
    }));
    expect(halldis12.source).toBe("learned");
    expect(halldis12.minutes).toBe(55);

    // Subharmonic guard: the 111m cluster must NEVER drop the estimate
    // into an alias below the age-plausible range. This was the live
    // bug that motivated the rewrite.
    const cluster111 = estimateSleepCycleDetails(ctxOf({
      ageMonths: 11, customNapCount: 1, naps: selfRun(10, 111),
    }));
    expect(cluster111.minutes).toBeGreaterThanOrEqual(50);
    expect(cluster111.minutes).toBeLessThanOrEqual(65);

    // Toddler edge: same 110m cluster at 14mo. 110/2=55 sits below the
    // [55, 70] range. The scorer must stay within range — not pick
    // 64-ish at the edge nor a sub-55 alias. Codex 2026-05-25 final
    // review flagged this as a missing fixture.
    const toddler110 = estimateSleepCycleDetails(ctxOf({
      ageMonths: 14, customNapCount: 1, naps: selfRun(12, 110),
    }));
    expect(toddler110.minutes).toBeGreaterThanOrEqual(55);
    expect(toddler110.minutes).toBeLessThanOrEqual(70);

    // Subharmonic-trap regression pin: 110m + 165m clusters would have
    // tied c=37 (110/3 ≈ 36.7, 165/4 ≈ 41.25 — both inside the OLD
    // [35, 60] search) under residual-only scoring. The new estimator
    // must reject c=37 because it's outside the 11mo plausible range,
    // landing somewhere in [50, 65] instead.
    const aliasTrap = estimateSleepCycleDetails(ctxOf({
      ageMonths: 11, customNapCount: 1,
      naps: [...selfRun(12, 110, 1), ...selfRun(8, 165, 15)],
    }));
    expect(aliasTrap.minutes).toBeGreaterThanOrEqual(50);
    expect(aliasTrap.minutes).toBeLessThanOrEqual(65);
    expect(aliasTrap.minutes).not.toBe(37);
    expect(aliasTrap.minutes).not.toBe(40);
    expect(aliasTrap.minutes).not.toBe(41);

    // Strict self-wake filter: woken-only data must be ignored entirely.
    const wokenOnly = estimateSleepCycleDetails(ctxOf({
      ageMonths: 11, customNapCount: 1, naps: selfRun(12, 110, 1, null),
    }));
    expect(wokenOnly.sampleCount).toBe(0);
    expect(wokenOnly.source).toBe("age-default");

    // Cap-respect invariance: adding 20 parent-woken naps at 55m
    // boundaries must NOT change the learned estimate from the clean
    // self-wake set. 8 self-wakes is the minimum that clears N≥5 (with
    // recency-0.5 floor) and reaches "learned"; below that, the
    // comparison is vacuous (both sides fall to age-default).
    const cleanRef = estimateSleepCycleDetails(ctxOf({
      ageMonths: 11, customNapCount: 1, naps: selfRun(8, 110),
    }));
    expect(cleanRef.source).toBe("learned");
    const withCaps = estimateSleepCycleDetails(ctxOf({
      ageMonths: 11, customNapCount: 1,
      naps: [...selfRun(8, 110, 1), ...selfRun(20, 55, 10, "woken")],
    }));
    expect(withCaps.minutes).toBe(cleanRef.minutes);
    expect(withCaps.source).toBe(cleanRef.source);
    expect(withCaps.confidence).toBe(cleanRef.confidence);
    expect(withCaps.sampleCount).toBe(cleanRef.sampleCount);

    // Off-day exclusion: 10 clean self-wakes ALL on off-days must
    // collapse to age-default.
    const offDayOnly = estimateSleepCycleDetails(ctxOf({
      ageMonths: 11, customNapCount: 1,
      naps: selfRun(10, 110),
      offDays: Array.from({ length: 10 }, (_, i) => ts(i + 1, 0).slice(0, 10)),
    }));
    expect(offDayOnly.source).toBe("age-default");
    expect(offDayOnly.sampleCount).toBe(0);

    // Noise floor: 15 random uniform samples must never reach high
    // confidence — the data is by construction not cycle-aligned.
    const noise = estimateSleepCycleDetails(ctxOf({
      ageMonths: 11, customNapCount: 1,
      naps: [33, 71, 142, 95, 47, 128, 58, 105, 161, 38, 87, 153, 67, 119, 41]
        .map((dur, i) => ({ d: i + 1, h: 10, durMin: dur })),
    }));
    expect(noise.confidence).not.toBe("high");

    // Bimodal data must not pretend to be a single learned cycle with
    // high confidence — the residual std at the midpoint betrays it.
    const bimodal = estimateSleepCycleDetails(ctxOf({
      ageMonths: 11, customNapCount: 1,
      naps: [...selfRun(6, 52, 1), ...selfRun(6, 63, 10)],
    }));
    expect(bimodal.confidence).not.toBe("high");
  });
});

// ─── Standalone tests that don't fit the table shape ────────────────────────

describe("cycle estimator v2: prior bands match the literature", () => {
  it("returns research-aligned priors across the age ladder", () => {
    const lines = [0.5, 2, 4, 8, 14, 26].map((age) => {
      const p = getSleepCyclePrior(age);
      return `${age.toString().padStart(4)}mo: mean=${p.meanMin}  sd=${p.sdMin}  range=[${p.rangeMin[0]},${p.rangeMin[1]}]`;
    });
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      " 0.5mo: mean=50  sd=6  range=[40,60]
         2mo: mean=50  sd=6  range=[40,60]
         4mo: mean=50  sd=5  range=[45,60]
         8mo: mean=55  sd=4  range=[50,65]
        14mo: mean=60  sd=5  range=[55,70]
        26mo: mean=60  sd=6  range=[55,70]"
    `);

    // The 6-12mo band must align with Lopp/Jenni (57.5 ± 2.4 at 9mo).
    // We use sd=4 (slightly wider than ±2.4) so data overwhelms the
    // prior at typical sample counts.
    const infant = getSleepCyclePrior(9);
    expect(infant.meanMin).toBeWithin(54, 58);
    expect(infant.rangeMin[0]).toBeLessThanOrEqual(50);
    expect(infant.rangeMin[1]).toBeGreaterThanOrEqual(60);
  });
});

describe("cycle estimator v2: integration with consumers", () => {
  it("memoizes the estimate on the BabyContext", () => {
    const ctx = ctxOf({
      ageMonths: 11, customNapCount: 1, naps: selfRun(8, 110),
    });
    expect(estimateSleepCycleDetails(ctx)).toBe(estimateSleepCycleDetails(ctx));
  });

  it("legacy estimateSleepCycleFromData returns the .minutes shim", () => {
    const ctx = ctxOf({
      ageMonths: 11, customNapCount: 1, naps: selfRun(2, 110),
    });
    expect(estimateSleepCycleFromData(ctx)).toBe(estimateSleepCycleDetails(ctx).minutes);
  });
});
