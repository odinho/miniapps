import { describe, expect, it } from "bun:test";
import { classifyTrendDay, computeTrendTargets } from "$lib/engine/trend.js";
import type { TrendTargetState } from "$lib/engine/trend.js";
import type { SleepEntry, BabyContext } from "$lib/types.js";

// Stage 1 of the trend intervention-target split:
//
// `computeTrendTargets` returns both `observedRecentMin` and
// `interventionTargetMin`. In stage 1 they're equal (the held-baseline drift
// lands later) but the day classification and diagnostics are live, so we
// pin those mechanics here.
//
// Codex design memo: `local/codex-trend-split-design.md`.

const TZ = "UTC";

// ─── Helpers used by the closed-loop drift tests ────────────────────────
// Kept at module scope (not inside `describe`) so oxlint doesn't flag
// them as "recreated on every call" and so the type checker resolves
// their return types up-front.

function naturalDayAt(
  date: string,
  totalMin: number,
  wokeBy: "self" | "woken" = "self",
): SleepEntry[] {
  const napMin = Math.min(120, Math.max(60, totalMin - 660));
  const nightMin = totalMin - napMin;
  const napStart = `${date}T08:20:00.000Z`;
  const napEnd =
    `${date}T${String(8 + Math.floor((20 + napMin) / 60)).padStart(2, "0")}:` +
    `${String((20 + napMin) % 60).padStart(2, "0")}:00.000Z`;
  const nightStart = `${date}T18:00:00.000Z`;
  const nextDate = isoNextDate(date);
  const nightEndH = 18 + nightMin / 60;
  const totalH = Math.floor(nightEndH) - 24;
  const totalM = Math.round((nightEndH - Math.floor(nightEndH)) * 60);
  const nightEnd =
    `${nextDate}T${String(totalH).padStart(2, "0")}:` +
    `${String(totalM).padStart(2, "0")}:00.000Z`;
  return [
    { start_time: napStart, end_time: napEnd, type: "nap", woke_by: wokeBy },
    { start_time: nightStart, end_time: nightEnd, type: "night", woke_by: "self" },
  ];
}

function isoNextDate(d: string): string {
  return new Date(new Date(`${d}T00:00:00Z`).getTime() + 86400_000)
    .toISOString()
    .slice(0, 10);
}

function noonUtc(date: string): number {
  return new Date(`${date}T12:00:00Z`).getTime();
}

function isoOffset(base: string, days: number): string {
  return new Date(new Date(`${base}T00:00:00Z`).getTime() + days * 86400_000)
    .toISOString()
    .slice(0, 10);
}

function ctxForCtxBase(sleeps: SleepEntry[]): BabyContext {
  return {
    birthdate: "2025-06-12",
    ageMonths: 11,
    tz: TZ,
    customNapCount: 1,
    recentSleeps: sleeps,
  };
}

function last30(history: SleepEntry[], beforeMs: number): SleepEntry[] {
  const cutoff = beforeMs - 30 * 86400_000;
  return history.filter((s) => {
    const startMs = new Date(s.start_time).getTime();
    return startMs >= cutoff && startMs < beforeMs;
  });
}

function sleep(
  start: string,
  end: string | null,
  type: "nap" | "night",
  wokeBy: "self" | "woken" | null = null,
): SleepEntry {
  return { start_time: start, end_time: end, type, woke_by: wokeBy };
}

function day(d: number, h: number, m = 0): string {
  return `2026-04-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
}

describe("classifyTrendDay", () => {
  const ref = 780; // 13h reference (matches Halldis's pre-cap trend roughly)
  const tol = 20;  // NAP_BUDGET.TOLERANCE_MIN

  it("classifies a self-wake last-nap day as 'natural'", () => {
    const sleeps = [
      sleep(day(10, 9, 0), day(10, 11, 0), "nap", "self"),
      sleep(day(10, 19, 0), day(11, 8, 0), "night", "self"),
    ];
    const d = classifyTrendDay("2026-04-10", sleeps, ref, tol, undefined);
    expect(d.kind).toBe("natural");
    expect(d.reason).toBe("last nap self-woke");
    expect(d.totalMin).toBe(120 + 13 * 60);
  });

  it("classifies a parent-woken substantial near-target day as 'policy-affected'", () => {
    // Total ~13h, last nap is parent-woken at substantial 110 min
    const sleeps = [
      sleep(day(11, 9, 0), day(11, 10, 50), "nap", "woken"),
      sleep(day(11, 19, 0), day(12, 8, 0), "night", "self"),
    ];
    const d = classifyTrendDay("2026-04-11", sleeps, ref, tol, undefined);
    expect(d.kind).toBe("policy-affected");
    expect(d.reason).toBe("parent-woken last nap near target");
  });

  it("classifies a parent-woken FAR-below-target day as 'natural' (parent-woken but low total → not policy-affected, the cap math didn't push them down)", () => {
    // Low total — only 8h — so the "near target" gate fails.
    const sleeps = [
      sleep(day(12, 9, 0), day(12, 10, 50), "nap", "woken"),
      sleep(day(12, 22, 0), day(13, 4, 0), "night", "self"),
    ];
    const d = classifyTrendDay("2026-04-12", sleeps, ref, tol, undefined);
    expect(d.kind).toBe("natural");
    expect(d.reason).toBe("untagged complete");
  });

  it("classifies an off-day as 'off-day' regardless of contents", () => {
    const sleeps = [
      sleep(day(13, 9, 0), day(13, 10, 50), "nap", "self"),
      sleep(day(13, 19, 0), day(14, 8, 0), "night", "self"),
    ];
    const d = classifyTrendDay("2026-04-13", sleeps, ref, tol, new Set(["2026-04-13"]));
    expect(d.kind).toBe("off-day");
  });

  it("classifies a day with no night entry as 'incomplete'", () => {
    const sleeps = [sleep(day(14, 9, 0), day(14, 10, 30), "nap", "self")];
    const d = classifyTrendDay("2026-04-14", sleeps, ref, tol, undefined);
    expect(d.kind).toBe("incomplete");
  });

  it("ignores a tiny parent-woken last nap (under 30 min) for policy-affected classification", () => {
    // A 15-min car-seat nap shouldn't drag the day into policy-affected.
    const sleeps = [
      sleep(day(15, 9, 0), day(15, 9, 15), "nap", "woken"),
      sleep(day(15, 19, 0), day(16, 8, 0), "night", "self"),
    ];
    const d = classifyTrendDay("2026-04-15", sleeps, ref, tol, undefined);
    // Last-nap parent-woken but under the 30-min substantial threshold →
    // falls through to "untagged complete" (natural for now, weakly).
    expect(d.kind).toBe("natural");
  });
});

describe("computeTrendTargets (stage 1: API only)", () => {
  function halldisLikeTrend(): SleepEntry[] {
    // 8 days of routine 1-nap. Wake ~05:25, nap ~10:20-12:10, night 18:00+.
    // The first 6 are clean self-wakes; the last 2 are parent-woken near
    // target (the user's "I've been intervening" pattern).
    const out: SleepEntry[] = [];
    for (let d = 1; d <= 6; d++) {
      out.push(sleep(day(d, 10, 20), day(d, 12, 10), "nap", "self"));
      out.push(sleep(day(d, 18, 0), day(d + 1, 5, 25), "night", "self"));
    }
    for (let d = 7; d <= 8; d++) {
      out.push(sleep(day(d, 10, 20), day(d, 12, 5), "nap", "woken"));
      out.push(sleep(day(d, 18, 0), day(d + 1, 5, 25), "night", "self"));
    }
    return out;
  }

  function ctx11(sleeps: SleepEntry[]): BabyContext {
    return {
      birthdate: "2025-06-12",
      ageMonths: 11,
      tz: TZ,
      customNapCount: 1,
      recentSleeps: sleeps,
    };
  }

  it("initializes intervention target ≥ observed (natural-mean tiebreak)", () => {
    // Stage 2 init: when natural days dominate the window, the seed lifts
    // toward the natural mean so the held baseline doesn't start low.
    // Without prior state, intervention target should be >= observed.
    const sleeps = halldisLikeTrend();
    const now = new Date(day(9, 5, 25)).getTime();
    const targets = computeTrendTargets(sleeps, ctx11(sleeps), now);
    expect(targets).not.toBeNull();
    expect(targets!.observedRecentMin).toBeGreaterThan(0);
    expect(targets!.interventionTargetMin).toBeGreaterThanOrEqual(targets!.observedRecentMin);
    expect(targets!.interventionConfidence).toBe("low"); // no prior held baseline
    expect(targets!.interventionSourceLabel).toBe("observed (initial)");
    expect(targets!.state).toBeDefined();
    expect(targets!.state.source).toBe("observed-initial");
  });

  // ─── Closed-loop anti-ratchet invariants (Codex 2026-05-20) ─────────────
  //
  // The headline contract: when the parent obeys the cap perfectly for
  // 30 days, the held intervention target must NOT walk downward materially
  // even though the rolling observed mean does (the cap by construction
  // lands today's total below trend, so observed averages downward over
  // time). This is the entire point of the split. Helpers used here live
  // at module scope so they're typechecked once.

  it("holds intervention target when parent follows caps for 30 days", () => {
    // Seed: 14 natural days at 780 min (13h) with low variance.
    const history: SleepEntry[] = [];
    for (let d = 0; d < 14; d++) {
      const date = isoOffset("2026-04-01", d);
      history.push(...naturalDayAt(date, 780, "self"));
    }

    let state: TrendTargetState | null = null;
    const targets: number[] = [];
    const observedSeries: number[] = [];

    // Simulate 30 days of "parent follows cap": last nap parent-woken,
    // day total lands target - 5 (EARLY_WAKE_LEAD_MIN). The synthetic
    // parent obeys every recommendation perfectly.
    for (let d = 0; d < 30; d++) {
      const date = isoOffset("2026-04-15", d);
      const now = noonUtc(date);
      const recent = last30(history, now);
      const ctx = ctxForCtxBase(recent);
      const result: NonNullable<ReturnType<typeof computeTrendTargets>> =
        computeTrendTargets(recent, ctx, now, state)!;
      targets.push(result.interventionTargetMin);
      observedSeries.push(result.observedRecentMin);

      // Parent follows the cap aggressively — 30 min under target — so the
      // observed mean visibly drifts down. The exact drop is illustrative;
      // the contract is "held target doesn't ratchet down when observed
      // does", and a too-small simulated drop makes the test degenerate.
      const capTotal = result.interventionTargetMin - 30;
      history.push(...naturalDayAt(date, capTotal, "woken"));

      state = result.state;
    }

    const drift = Math.max(...targets) - Math.min(...targets);
    expect(drift).toBeLessThanOrEqual(15);
    // Sanity: observed-recent should drift down materially while held
    // intervention target does not. Confirms the split is actually doing
    // its job — if both move together, the test isn't catching anything.
    const observedDrop = observedSeries[0] - observedSeries.at(-1)!;
    expect(observedDrop).toBeGreaterThan(15);
  });

  it("drifts upward faster when natural higher-need days arrive", () => {
    // 7 natural days at 780, then 7 natural days at 820 (+40 min trend up).
    const history: SleepEntry[] = [];
    for (let d = 0; d < 7; d++) {
      history.push(...naturalDayAt(isoOffset("2026-04-01", d), 780, "self"));
    }
    for (let d = 7; d < 14; d++) {
      history.push(...naturalDayAt(isoOffset("2026-04-01", d), 820, "self"));
    }

    let state: TrendTargetState | null = null;
    const now = noonUtc(isoOffset("2026-04-01", 15));
    // Seed with initial pass.
    const t0 = computeTrendTargets(last30(history, now), ctxForCtxBase(last30(history, now)), now, null)!;
    state = { ...t0.state, targetMin: 780, baselineMin: 780 };

    // Run a second pass — the higher-need days should pull the target up.
    const t1 = computeTrendTargets(last30(history, now), ctxForCtxBase(last30(history, now)), now, state)!;
    expect(t1.interventionTargetMin).toBeGreaterThan(780);
  });

  it("does NOT drift down on policy-affected days even when the observed mean does", () => {
    // 7 natural days at 780, then 10 policy-affected days at 760.
    const history: SleepEntry[] = [];
    for (let d = 0; d < 7; d++) {
      history.push(...naturalDayAt(isoOffset("2026-04-01", d), 780, "self"));
    }
    for (let d = 7; d < 17; d++) {
      history.push(...naturalDayAt(isoOffset("2026-04-01", d), 760, "woken"));
    }
    const now = noonUtc(isoOffset("2026-04-01", 17));
    const recent = last30(history, now);
    const ctx = ctxForCtxBase(recent);
    const prior: TrendTargetState = {
      targetMin: 780,
      baselineMin: 780,
      source: "observed-initial",
      confidence: "medium",
      naturalSupportStreak: 0,
      updatedAt: new Date(now - 86400_000).toISOString(),
    };
    const t = computeTrendTargets(recent, ctx, now, prior)!;
    // Held target stays ≥ baseline; observed should be visibly lower.
    expect(t.interventionTargetMin).toBeGreaterThanOrEqual(778);
    expect(t.observedRecentMin).toBeLessThan(780);
  });

  it("carries the held target forward when prior state exists (no drift in stage 2)", () => {
    const sleeps = halldisLikeTrend();
    const now = new Date(day(9, 5, 25)).getTime();
    const prior = {
      targetMin: 800,
      baselineMin: 800,
      source: "observed-initial" as const,
      confidence: "medium" as const,
      naturalSupportStreak: 0,
      updatedAt: new Date(day(8, 5, 25)).toISOString(),
    };
    const targets = computeTrendTargets(sleeps, ctx11(sleeps), now, prior);
    expect(targets!.interventionTargetMin).toBe(800);
    expect(targets!.interventionConfidence).toBe("medium");
    expect(targets!.state.targetMin).toBe(800);
    expect(targets!.state.baselineMin).toBe(800);
  });

  it("classifies days into natural vs policy-affected in diagnostics", () => {
    const sleeps = halldisLikeTrend();
    const now = new Date(day(9, 5, 25)).getTime();
    const targets = computeTrendTargets(sleeps, ctx11(sleeps), now)!;
    expect(targets.diagnostics.naturalDays30).toBeGreaterThanOrEqual(5);
    expect(targets.diagnostics.policyAffectedDays30).toBeGreaterThanOrEqual(1);
  });

  it("returns null when the underlying data is too sparse (no advice)", () => {
    // Only 2 days — below NAP_BUDGET.MIN_TREND_DAYS.
    const sleeps = [
      sleep(day(1, 10, 20), day(1, 12, 10), "nap", "self"),
      sleep(day(1, 18, 0), day(2, 5, 25), "night", "self"),
    ];
    const now = new Date(day(3, 5, 25)).getTime();
    const targets = computeTrendTargets(sleeps, ctx11(sleeps), now);
    expect(targets).toBeNull();
  });
});
