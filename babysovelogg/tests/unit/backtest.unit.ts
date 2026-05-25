import { describe, expect, it } from "bun:test";
import {
  backtest,
  bucketResultsByAge,
  bucketResultsByWeek,
  bucketByWarmup,
  renderSummary,
} from "$lib/engine/backtest.js";
import type { DayRecord, BacktestResult } from "$lib/engine/backtest.js";

import halldisData from "../fixtures/halldis-sleep.json";

const BIRTHDATE = "2025-06-12";
const TZ = "Europe/Oslo";
const days = halldisData as DayRecord[];

// =============================================================================
// Mechanics
// =============================================================================

describe("backtest", () => {
  it("skips first day and handles empty-nap days", () => {
    const result = backtest(days, BIRTHDATE, { tz: TZ });

    expect(result.totalDays).toBeGreaterThan(0);
    expect(result.days[0].date).not.toBe(days[0].date);
  });

  it("accepts a custom predictor", () => {
    const result = backtest(days, BIRTHDATE, { predict: () => [], tz: TZ });

    // Empty predictor matches actual count only on rare 0-nap days
    // (sick/travel) — keep this loose so refreshing the fixture doesn't
    // need a manual count update.
    expect(result.napCountAccuracy).toBeLessThan(0.05);
    // Empty predictor gets 60 min penalty per unmatched actual nap
    expect(result.napStartMAE).toBe(60);
  });

  it("all fixture times are UTC instants", () => {
    for (const day of days) {
      expect(day.wakeTime).toMatch(/Z$/);
      for (const s of day.sleeps) {
        expect(s.start_time).toMatch(/Z$/);
        expect(s.end_time).toMatch(/Z$/);
      }
    }
  });
});

// =============================================================================
// Baseline: current algorithm on 83 days of Halldis data (Jan 6 - Mar 29)
// =============================================================================

function mostCommonNapCount(result: ReturnType<typeof backtest>): number {
  const counts = new Map<number, number>();
  for (const d of result.days) {
    const n = d.actualNaps.length;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  let best = 0, bestCount = 0;
  for (const [n, c] of counts) {
    if (c > bestCount) { best = n; bestCount = c; }
  }
  return best;
}

describe("baseline", () => {
  const auto = backtest(days, BIRTHDATE, { tz: TZ });
  const buckets = bucketResultsByAge(auto, BIRTHDATE);

  it("per-month breakdown", () => {
    const lines = buckets.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "6mo: 5 days, count 60% (3/5), naps 2.4p/2.8a, nap MAE 56.5, dur MAE 27.7, bed MAE 28.7, wake MAE 19.9, nap bias +12.9, count bias -0.4, cycle 5/0/0 (l/m/h), cut-short 0
      7mo: 31 days, count 77% (24/31), naps 2.1p/1.9a, nap MAE 50.4, dur MAE 26.8, bed MAE 22.3, wake MAE 29.1, nap bias -12.7, count bias +0.16, cycle 31/0/0 (l/m/h), cut-short 0
      8mo: 28 days, count 89% (25/28), naps 2.0p/1.9a, nap MAE 27, dur MAE 18.9, bed MAE 15.8, wake MAE 21.8, nap bias -4.8, count bias +0.11, cycle 28/0/0 (l/m/h), cut-short 0
      9mo: 31 days, count 87% (27/31), naps 1.1p/1.1a, nap MAE 47.1, dur MAE 26.2, bed MAE 25.2, wake MAE 26.3, nap bias +3.3, count bias 0, cycle 31/0/0 (l/m/h), cut-short 0
      10mo: 30 days, count 90% (27/30), naps 1.0p/1.1a, nap MAE 24.7, dur MAE 34, bed MAE 22.8, wake MAE 23.5, nap bias +8.7, count bias -0.1, cycle 30/0/0 (l/m/h), cut-short 6
      11mo: 13 days, count 92% (12/13), naps 1.0p/0.9a, nap MAE 41.2, dur MAE 14.5, bed MAE 21.1, wake MAE 38.6, nap bias -15.2, count bias +0.08, cycle 13/0/0 (l/m/h), cut-short 2"
    `);
  });

  // Pre-compute: one backtest per unique nap count (avoids running 4 separate backtests)
  const manualCountsByLabel = Object.fromEntries(
    buckets.map((b) => [b.label, mostCommonNapCount(b.result)]),
  );
  const uniqueCounts = [...new Set(Object.values(manualCountsByLabel))];
  const manualResults = Object.fromEntries(
    uniqueCounts.map((n) => [n, backtest(days, BIRTHDATE, { customNapCount: n, tz: TZ })]),
  );

  it("per-month with manual nap count", () => {
    const lines = buckets.map((b) => {
      const n = manualCountsByLabel[b.label];
      const manualBucket = bucketResultsByAge(manualResults[n], BIRTHDATE).find(
        (mb) => mb.label === b.label,
      )!;
      return renderSummary(manualBucket.result, `${b.label} manual=${n}`);
    });
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "6mo manual=3: 5 days, count 80% (4/5), naps 3.0p/2.8a, nap MAE 59.7, dur MAE 26.2, bed MAE 35.3, wake MAE 21.2, nap bias +13.9, count bias +0.2, cycle 5/0/0 (l/m/h), cut-short 0
      7mo manual=2: 31 days, count 84% (26/31), naps 2.0p/1.9a, nap MAE 48.2, dur MAE 27.3, bed MAE 20, wake MAE 29, nap bias -12.2, count bias +0.1, cycle 31/0/0 (l/m/h), cut-short 0
      8mo manual=2: 28 days, count 89% (25/28), naps 2.0p/1.9a, nap MAE 27, dur MAE 18.9, bed MAE 15.8, wake MAE 21.8, nap bias -4.8, count bias +0.11, cycle 28/0/0 (l/m/h), cut-short 0
      9mo manual=1: 31 days, count 90% (28/31), naps 1.0p/1.1a, nap MAE 46.8, dur MAE 26.3, bed MAE 23.1, wake MAE 26, nap bias +3.1, count bias -0.1, cycle 31/0/0 (l/m/h), cut-short 0
      10mo manual=1: 30 days, count 90% (27/30), naps 1.0p/1.1a, nap MAE 24.7, dur MAE 34, bed MAE 22.8, wake MAE 23.5, nap bias +8.7, count bias -0.1, cycle 30/0/0 (l/m/h), cut-short 6
      11mo manual=1: 13 days, count 92% (12/13), naps 1.0p/0.9a, nap MAE 41.2, dur MAE 14.5, bed MAE 21.1, wake MAE 38.6, nap bias -15.2, count bias +0.08, cycle 13/0/0 (l/m/h), cut-short 2"
    `);
  });

  it("combined summary", () => {
    expect(renderSummary(auto, "all")).toMatchInlineSnapshot(`"all: 138 days, count 86% (118/138), naps 1.5p/1.5a, nap MAE 39.7, dur MAE 25, bed MAE 22, wake MAE 26.3, nap bias -3.3, count bias +0.03, cycle 138/0/0 (l/m/h), cut-short 8"`);
  });

  it("warm-up curve", () => {
    const warmup = bucketByWarmup(auto);
    const lines = warmup.map((b) => renderSummary(b.result, b.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "day 1-3: 3 days, count 33% (1/3), naps 2.0p/2.7a, nap MAE 71.3, dur MAE 28.4, bed MAE 36.3, wake MAE 17.9, nap bias +46.8, count bias -0.67, cycle 3/0/0 (l/m/h), cut-short 0
      day 4-7: 4 days, count 50% (2/4), naps 3.0p/2.5a, nap MAE 54.7, dur MAE 36.6, bed MAE 39.2, wake MAE 35.8, nap bias -26.4, count bias +0.5, cycle 4/0/0 (l/m/h), cut-short 0
      day 8-14: 7 days, count 86% (6/7), naps 2.0p/1.9a, nap MAE 66.5, dur MAE 20.8, bed MAE 13.5, wake MAE 23.7, nap bias -40.4, count bias +0.14, cycle 7/0/0 (l/m/h), cut-short 0
      day 15+: 124 days, count 88% (109/124), naps 1.4p/1.4a, nap MAE 35.3, dur MAE 24.5, bed MAE 21.5, wake MAE 26.3, nap bias -1.1, count bias +0.02, cycle 124/0/0 (l/m/h), cut-short 8"
    `);
  });

  // ── Regression guards ──
  it("nap start MAE ≤ 50 min", () => expect(auto.napStartMAE).toBeLessThan(50));
  it("nap duration MAE ≤ 30 min", () => expect(auto.napDurationMAE).toBeLessThan(30));
  it("bedtime MAE ≤ 30 min", () => expect(auto.bedtimeMAE).toBeLessThan(30));
  it("wake time MAE ≤ 30 min", () => expect(auto.wakeTimeMAE).toBeLessThan(30));
  it("nap count accuracy ≥ 78%", () => expect(auto.napCountAccuracy).toBeGreaterThan(0.78));

  // ─── Per-week timeline ────────────────────────────────────────────────
  //
  // The per-month roll-up above hides week-to-week behaviour: a single
  // rough week can pull a month's MAE up while leaving the surrounding
  // weeks untouched, and a confidence shift from low → medium → high is
  // an emergent property of weeks of clean data, not months. This block
  // pins the timeline so any engine change that drifts within-month
  // behaviour shows up as a row diff rather than averaging out.
  it("Halldis week-by-week timeline", () => {
    const weeks = bucketResultsByWeek(auto);
    // Render each week compact: regime/MAE/cycle/rescue. Skip newborn-
    // only weeks (no schedule predictions) — first ~2 weeks here.
    const lines = weeks
      .filter((w) => w.result.strategyCounts.routine_schedule + w.result.strategyCounts.emerging_rhythm > 0)
      .map((w) => renderSummary(w.result, w.label));
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "wk 2026-01-05: 5 days, count 60% (3/5), naps 2.4p/2.8a, nap MAE 56.5, dur MAE 27.7, bed MAE 28.7, wake MAE 19.9, nap bias +12.9, count bias -0.4, cycle 5/0/0 (l/m/h), cut-short 0
      wk 2026-01-12: 7 days, count 71% (5/7), naps 2.3p/2.0a, nap MAE 60.9, dur MAE 26, bed MAE 25.2, wake MAE 33.6, nap bias -36.2, count bias +0.29, cycle 7/0/0 (l/m/h), cut-short 0
      wk 2026-01-19: 7 days, count 57% (4/7), naps 2.0p/1.6a, nap MAE 64.5, dur MAE 33.5, bed MAE 27.1, wake MAE 19.6, nap bias -23.5, count bias +0.43, cycle 7/0/0 (l/m/h), cut-short 0
      wk 2026-01-26: 7 days, count 86% (6/7), naps 2.0p/1.9a, nap MAE 51.2, dur MAE 39.9, bed MAE 21.3, wake MAE 26.4, nap bias -13.8, count bias +0.14, cycle 7/0/0 (l/m/h), cut-short 0
      wk 2026-02-02: 7 days, count 100% (7/7), naps 2.0p/2.0a, nap MAE 17.8, dur MAE 17.5, bed MAE 14.5, wake MAE 29.2, nap bias -4.6, count bias 0, cycle 7/0/0 (l/m/h), cut-short 0
      wk 2026-02-09: 7 days, count 86% (6/7), naps 2.0p/2.1a, nap MAE 39.2, dur MAE 14.1, bed MAE 18.7, wake MAE 33.8, nap bias +13.2, count bias -0.14, cycle 7/0/0 (l/m/h), cut-short 0
      wk 2026-02-16: 7 days, count 100% (7/7), naps 2.0p/2.0a, nap MAE 21.3, dur MAE 14.3, bed MAE 16.7, wake MAE 19, nap bias -11.1, count bias 0, cycle 7/0/0 (l/m/h), cut-short 0
      wk 2026-02-23: 7 days, count 100% (7/7), naps 2.0p/2.0a, nap MAE 22.1, dur MAE 16.6, bed MAE 18.6, wake MAE 24.1, nap bias +9.5, count bias 0, cycle 7/0/0 (l/m/h), cut-short 0
      wk 2026-03-02: 7 days, count 71% (5/7), naps 2.0p/1.7a, nap MAE 42.6, dur MAE 26, bed MAE 9.5, wake MAE 25.7, nap bias -5.5, count bias +0.29, cycle 7/0/0 (l/m/h), cut-short 0
      wk 2026-03-09: 7 days, count 57% (4/7), naps 1.9p/1.4a, nap MAE 53.1, dur MAE 21.2, bed MAE 31.2, wake MAE 24.3, nap bias -25.4, count bias +0.43, cycle 7/0/0 (l/m/h), cut-short 0
      wk 2026-03-16: 7 days, count 86% (6/7), naps 1.0p/1.1a, nap MAE 45.8, dur MAE 26.9, bed MAE 21.5, wake MAE 32.8, nap bias -22.7, count bias -0.14, cycle 7/0/0 (l/m/h), cut-short 0
      wk 2026-03-23: 7 days, count 86% (6/7), naps 1.0p/1.1a, nap MAE 68.4, dur MAE 27.9, bed MAE 14.1, wake MAE 26.3, nap bias +61.3, count bias -0.14, cycle 7/0/0 (l/m/h), cut-short 0
      wk 2026-03-30: 7 days, count 100% (7/7), naps 1.0p/1.0a, nap MAE 25, dur MAE 21.8, bed MAE 35, wake MAE 12.2, nap bias +13.6, count bias 0, cycle 7/0/0 (l/m/h), cut-short 0
      wk 2026-04-06: 7 days, count 86% (6/7), naps 1.0p/1.1a, nap MAE 16.9, dur MAE 39.2, bed MAE 27.5, wake MAE 30.6, nap bias +8.1, count bias -0.14, cycle 7/0/0 (l/m/h), cut-short 0
      wk 2026-04-13: 7 days, count 100% (7/7), naps 1.0p/1.0a, nap MAE 24.3, dur MAE 23, bed MAE 15.1, wake MAE 20.3, nap bias -19.3, count bias 0, cycle 7/0/0 (l/m/h), cut-short 0
      wk 2026-04-20: 7 days, count 100% (7/7), naps 1.0p/1.0a, nap MAE 33.3, dur MAE 32, bed MAE 20.5, wake MAE 24.9, nap bias +17.2, count bias 0, cycle 7/0/0 (l/m/h), cut-short 2
      wk 2026-04-27: 7 days, count 100% (7/7), naps 1.0p/1.0a, nap MAE 12.1, dur MAE 23.7, bed MAE 25.5, wake MAE 24.2, nap bias +8.6, count bias 0, cycle 7/0/0 (l/m/h), cut-short 1
      wk 2026-05-04: 7 days, count 71% (5/7), naps 1.0p/1.3a, nap MAE 27.8, dur MAE 56.1, bed MAE 26.9, wake MAE 19, nap bias +21, count bias -0.29, cycle 7/0/0 (l/m/h), cut-short 3
      wk 2026-05-11: 7 days, count 86% (6/7), naps 1.0p/0.9a, nap MAE 34.1, dur MAE 14.1, bed MAE 22.2, wake MAE 42.8, nap bias -15.9, count bias +0.14, cycle 7/0/0 (l/m/h), cut-short 1
      wk 2026-05-18: 7 days, count 100% (7/7), naps 1.0p/1.0a, nap MAE 42.9, dur MAE 14.3, bed MAE 19.9, wake MAE 34.9, nap bias -11.7, count bias 0, cycle 7/0/0 (l/m/h), cut-short 1"
    `);

    // Invariants — algorithm-correctness pins that survive snapshot
    // updates:
    //   1. No week is empty (each row covers ≥ 1 day).
    //   2. Within-month MAE swings stay bounded — no week should show
    //      nap-start MAE > 120 min (the empty-predictor penalty floor),
    //      which would indicate predict() returning nothing for that
    //      window.
    //   3. The rescue-likely count never exceeds the day count.
    for (const w of weeks) {
      expect(w.result.totalDays).toBeGreaterThan(0);
      expect(w.result.napStartMAE).toBeLessThan(120);
      expect(w.result.rescueLikelyDays).toBeLessThanOrEqual(w.result.totalDays);
    }
  });

  it("Halldis 10mo per-day rescue-likely list", () => {
    // Per-day visibility for ONE notable bucket — the 10mo month had
    // 6 rescue-likely days hidden inside an otherwise clean MAE. This
    // names them so any engine drift on rescue-flagging shows up as
    // either a date change or a count change. Keep it narrow (one
    // month) so the test stays short.
    const tenMo = bucketResultsByAge(auto, BIRTHDATE).find((b) => b.label === "10mo")!;
    const lines = tenMo.result.days
      .filter((d) => d.rescueLikely)
      .map((d) => {
        const naps = d.actualNaps.map((n) => {
          const dur = Math.round(
            (new Date(n.end_time!).getTime() - new Date(n.start_time).getTime()) / 60000,
          );
          return `${n.start_time.slice(11, 16)}–${n.end_time!.slice(11, 16)} ${dur}m ${n.woke_by ?? "?"}`;
        });
        return `${d.date}: ${naps.join(" | ")}`;
      });
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "2026-04-24: 08:27–09:09 41m woken
      2026-04-26: 08:42–09:30 48m woken
      2026-04-30: 08:03–09:23 79m woken
      2026-05-06: 07:13–07:55 41m self | 11:32–12:14 42m woken
      2026-05-07: 06:20–06:48 28m self | 10:05–10:44 39m woken
      2026-05-10: 07:37–08:13 36m woken"
    `);

    // Invariant: every rescue-likely day must contain at least one
    // parent-woken nap shorter than ~90 min (the heuristic's
    // threshold for an 11mo with ~120m learned + 55m age-default cycle).
    for (const d of tenMo.result.days.filter((dr: BacktestResult["days"][number]) => dr.rescueLikely)) {
      const hasShortWoken = d.actualNaps.some((n) => {
        if (n.woke_by !== "woken" || !n.end_time) return false;
        const durMin = (new Date(n.end_time).getTime() - new Date(n.start_time).getTime()) / 60000;
        return durMin < 100;
      });
      expect(hasShortWoken).toBe(true);
    }
  });
});
