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
      10mo, 1-nap, Halldis prod                learned=104m  ends=11:16
      10mo, 1-nap, Halldis +censor             learned=118m  ends=11:26
      10mo, 1-nap, no woke_by data             learned=104m  ends=11:16"
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
