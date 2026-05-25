/**
 * Anti-regression pin for the sleep-cycle estimator on REAL prod data
 * (`tests/fixtures/halldis-sleep.json`). The synthetic scenarios in
 * `cycle-estimator.unit.ts` cover the algorithmic shape; this file
 * pins what the estimator actually emits when fed Halldis's history.
 *
 * Why both: any future drift in the estimator — alias defenses,
 * weighting tweaks, sample collector changes — will surface here as a
 * diff against real-world data, not just constructed fixtures. The
 * estimator originally over-claimed `c=40` on this exact data, so
 * this is the canonical regression target.
 *
 * Cutoff progression: we run the estimator at five growing windows
 * (day 30 / 60 / 90 / 120 / end-of-history) so the snapshot also
 * shows how confidence develops as the long-horizon `cycleSleeps`
 * window fills with usable self-wake samples.
 */
import { describe, expect, it } from "bun:test";
import {
  estimateSleepCycleDetails,
  calculateAgeMonths,
} from "$lib/engine/schedule.js";
import type { SleepEntry, BabyContext } from "$lib/types.js";

import halldisData from "../fixtures/halldis-sleep.json";

interface DayRecord {
  date: string;
  wakeTime: string;
  target_bedtime?: string | null;
  off_day?: 0 | 1;
  sleeps: SleepEntry[];
}

const HALLDIS_BIRTHDATE = "2025-06-12";
const TZ = "Europe/Oslo";
const days = halldisData as DayRecord[];

/** Build a BabyContext as of the END of day `cutoff` — all sleeps from
 *  days[0..cutoff-1] go into cycleSleeps + recentSleeps. Mirrors prod's
 *  long-horizon path: the engine reads cycleSleeps for cycle estimation. */
function ctxAt(cutoff: number): BabyContext {
  const priorSleeps: SleepEntry[] = [];
  const offDays = new Set<string>();
  for (let j = 0; j < cutoff; j++) {
    for (const s of days[j].sleeps) {
      if (s.end_time) priorSleeps.push(s);
    }
    if (days[j].off_day === 1) offDays.add(days[j].date);
  }
  const refDate = new Date(days[cutoff - 1].date + "T12:00:00Z");
  return {
    birthdate: HALLDIS_BIRTHDATE,
    ageMonths: calculateAgeMonths(HALLDIS_BIRTHDATE, refDate),
    tz: TZ,
    customNapCount: 1, // Halldis's prod setting throughout the window
    recentSleeps: priorSleeps,
    cycleSleeps: priorSleeps,
    offDays,
  };
}

function renderCutoff(label: string, cutoff: number): string {
  const ctx = ctxAt(cutoff);
  const est = estimateSleepCycleDetails(ctx);
  const sign = est.scoreMargin >= 0 ? "+" : "-";
  return [
    label.padEnd(28),
    `age=${ctx.ageMonths}mo`,
    `c=${String(est.minutes).padStart(2)}m`,
    `src=${est.source.padEnd(11)}`,
    `conf=${est.confidence.padEnd(6)}`,
    `N=${est.sampleCount.toFixed(1).padStart(5)}`,
    `margin=${sign}${Math.abs(est.scoreMargin).toFixed(2).padStart(5)}`,
  ].join("  ");
}

describe("cycle estimator: real Halldis prod data", () => {
  it("progression of estimate as cycleSleeps fills", () => {
    // 138 days of data. Pick cutoffs that span the first month (sparse
    // self-wake samples → age-default expected) through end-of-history
    // (the largest sample the estimator has ever seen on this baby).
    const eod = days.length;
    const lines = [
      renderCutoff(`after day 30 (${days[29].date})`,   30),
      renderCutoff(`after day 60 (${days[59].date})`,   60),
      renderCutoff(`after day 90 (${days[89].date})`,   90),
      renderCutoff(`after day 120 (${days[119].date})`, 120),
      renderCutoff(`end of history (${days[eod - 1].date})`, eod),
    ];

    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "after day 30 (2026-02-04)     age=7mo  c=55m  src=age-default  conf=low     N=  0.0  margin=+ 0.00
      after day 60 (2026-03-06)     age=8mo  c=55m  src=age-default  conf=low     N=  0.0  margin=+ 0.00
      after day 90 (2026-04-05)     age=9mo  c=55m  src=age-default  conf=low     N= 10.3  margin=+ 0.29
      after day 120 (2026-05-05)    age=10mo  c=55m  src=age-default  conf=low     N= 21.1  margin=+ 7.43
      end of history (2026-05-24)   age=11mo  c=55m  src=age-default  conf=low     N= 25.4  margin=+ 6.32"
    `);

    // ── Invariants — snapshot-proof anti-regression on the actual bug ─
    // The original bug: subharmonic finder picked c=40 (or similar)
    // for this exact data because nap durations cluster at 110m and
    // the old scorer admitted c=37 / c=40 as zero-distance matches.
    // The new estimator's age-plausible range for the 6-12mo months
    // Halldis spans is [50, 65]; for 12+mo it shifts to [55, 70].
    // Either way, the result must NEVER land below 50.
    const eodEst = estimateSleepCycleDetails(ctxAt(eod));
    expect(eodEst.minutes).toBeGreaterThanOrEqual(50);

    // The 6-12mo prior range is [50, 65]; with Halldis being mostly
    // cap-respect (parent-woken) naps, self-wake samples are sparse
    // and the estimator should hedge to age-default low for most of
    // the history — the cluster of legit self-wake naps isn't dense
    // enough to clear the per-sample margin + ambiguity gates.
    // This pins the conservatism: we'd rather report age-default than
    // overclaim on noisy data.
    expect(eodEst.source).toBe("age-default");
    expect(eodEst.confidence).toBe("low");

    // The candidate search range must match the age band's plausible
    // window — proves we routed through `getSleepCyclePrior` rather
    // than the old hardcoded 35-60.
    expect(eodEst.candidateRange[0]).toBeGreaterThanOrEqual(50);
    expect(eodEst.candidateRange[1]).toBeLessThanOrEqual(70);
  });

  it("self-wake sample count never drops as the cutoff grows", () => {
    // Pure non-regression: a sample-collector bug that accidentally
    // filtered older days or mis-handled off-days would show up as
    // effectiveN going DOWN at a later cutoff. Plateauing is fine
    // (consecutive cutoffs can legitimately add zero new self-wakes
    // if the stretch is mostly cap-respect days), so we use ≥ not >.
    const counts = [30, 60, 90, 120, days.length].map((c) => ({
      cutoff: c,
      n: estimateSleepCycleDetails(ctxAt(c)).sampleCount,
    }));
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i].n).toBeGreaterThanOrEqual(counts[i - 1].n);
    }
  });
});
