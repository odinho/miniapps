import { describe, expect, it } from "bun:test";
import { scorePlan, selectBestPlan, buildSleepsForBedtime } from "$lib/engine/schedule.js";
import { assembleState, type DayData } from "$lib/engine/state.js";
import type { BabyContext, SleepEntry, Baby, SleepLogRow, DayStartRow } from "$lib/types.js";
import type { PlanCandidate, PredictedNap } from "$lib/engine/schedule.js";

// ─── Shared helpers ──────────────────────────────────────────────────────────

function ctx(overrides: Partial<BabyContext> = {}): BabyContext {
  return {
    birthdate: "2025-06-12", ageMonths: 9, tz: "UTC",
    customNapCount: null, recentSleeps: [], ...overrides,
  };
}

function plan(napTimes: [string, string][], bedtime: string): PlanCandidate {
  return {
    naps: napTimes.map(([s, e]) => ({
      startTime: `2026-03-28T${s}:00Z`,
      endTime: `2026-03-28T${e}:00Z`,
    })),
    bedtime: `2026-03-28T${bedtime}:00Z`,
  };
}

const WAKE = new Date("2026-03-28T07:00:00Z").getTime();
const NOW = new Date("2026-03-28T08:00:00Z").getTime();

/** Sparse recent sleeps: consistent naps, only 2 nights (no habitual bedtime weight). */
function sparseRecentSleeps(): SleepEntry[] {
  const sleeps: SleepEntry[] = [];
  for (let d = 11; d <= 25; d++) {
    const ds = `2026-03-${String(d).padStart(2, "0")}`;
    sleeps.push(
      { start_time: `${ds}T09:30:00Z`, end_time: `${ds}T11:00:00Z`, type: "nap" },
      { start_time: `${ds}T14:00:00Z`, end_time: `${ds}T15:30:00Z`, type: "nap" },
    );
  }
  sleeps.push(
    { start_time: "2026-03-24T19:30:00Z", end_time: "2026-03-24T23:59:00Z", type: "night" },
    { start_time: "2026-03-25T19:30:00Z", end_time: "2026-03-25T23:59:00Z", type: "night" },
  );
  return sleeps;
}

// ─── assembleState helpers (for coherent day plan tests) ─────────────────────

const baseBaby: Baby = {
  id: 1, name: "Testa", birthdate: "2025-06-12",
  created_at: "2026-01-01T00:00:00.000Z", custom_nap_count: null,
  potty_mode: 0, timezone: null, target_bedtime: null,
  created_by_event_id: null, updated_by_event_id: null,
};

function sleepRow(overrides: Partial<SleepLogRow> = {}): SleepLogRow {
  return {
    id: 1, baby_id: 1, start_time: "2026-03-26T09:00:00.000Z",
    end_time: "2026-03-26T10:00:00.000Z", type: "nap", notes: null,
    mood: null, method: null, fall_asleep_time: null, onset_note: null,
    woke_by: null, wake_notes: null, wake_mood: null, deleted: 0,
    domain_id: "slp_test", created_by_event_id: null, updated_by_event_id: null,
    ...overrides,
  };
}

/** 14 days of schedule-like data for strategy selection. */
function scheduleRecentSleeps(): SleepLogRow[] {
  const sleeps: SleepLogRow[] = [];
  for (let d = 11; d <= 25; d++) {
    const ds = `2026-03-${String(d).padStart(2, "0")}`;
    sleeps.push(
      sleepRow({ id: d * 10 + 1, start_time: `${ds}T09:30:00Z`, end_time: `${ds}T11:00:00Z`, type: "nap", domain_id: `r${d}a` }),
      sleepRow({ id: d * 10 + 2, start_time: `${ds}T14:00:00Z`, end_time: `${ds}T15:30:00Z`, type: "nap", domain_id: `r${d}b` }),
    );
  }
  sleeps.push(
    sleepRow({ id: 901, start_time: "2026-03-24T19:30:00Z", end_time: "2026-03-24T23:59:00Z", type: "night", domain_id: "rn1" }),
    sleepRow({ id: 902, start_time: "2026-03-25T19:30:00Z", end_time: "2026-03-25T23:59:00Z", type: "night", domain_id: "rn2" }),
  );
  return sleeps;
}

function dayData(overrides: Partial<DayData> = {}): DayData {
  return {
    baby: baseBaby, activeSleep: undefined, todaySleeps: [],
    recentSleeps: scheduleRecentSleeps(), todayWakeUp: undefined,
    pausesBySleep: new Map(), diaperCount: 0, lastDiaperTime: null,
    ...overrides,
  };
}

const utcBaby = { ...baseBaby, timezone: "UTC" };

const wake28: DayStartRow = {
  id: 1, baby_id: 1, date: "2026-03-28",
  wake_time: "2026-03-28T07:00:00.000Z",
  created_at: "2026-03-28T07:00:00.000Z",
  created_by_event_id: null,
};

function fmtTime(iso: string): string { return iso.slice(11, 16); }

function renderDayPlan(result: ReturnType<typeof assembleState>): string {
  const p = result.prediction;
  if (!p) return "no prediction";
  const lines: string[] = [];
  lines.push(`strategy: ${p.strategy}`);
  if (p.predictedNaps) {
    for (let i = 0; i < p.predictedNaps.length; i++) {
      const n = p.predictedNaps[i];
      lines.push(`lur ${i + 1}: ${fmtTime(n.startTime)}–${fmtTime(n.endTime)}`);
    }
  }
  if (p.expectedNapEnd) lines.push(`nap ends: ~${fmtTime(p.expectedNapEnd)}`);
  lines.push(`bedtime: ${p.bedtime ? fmtTime(p.bedtime) : "(none)"}`);
  lines.push(`naps done: ${p.napsAllDone} (${p.expectedNapCount} expected)`);
  return lines.join("\n");
}

// ─── scorePlan ───────────────────────────────────────────────────────────────

describe("scorePlan", () => {
  // 9mo: WW range [150, 210], final WW max 273 (1.3×)

  const feasibleCases: [string, PlanCandidate, boolean][] = [
    ["reasonable wake windows",
      plan([["09:30", "11:00"], ["14:00", "15:30"]], "19:30"), true],
    ["WW below minimum (60 min)",
      plan([["08:00", "09:00"], ["12:00", "13:00"]], "18:00"), false],
    ["nap within 60 min of bedtime (B8)",
      plan([["09:30", "11:00"], ["18:30", "19:00"]], "19:15"), false],
    ["final WW too long (300 min)",
      plan([["09:30", "11:00"]], "16:00"), false],
    ["zero naps, bedtime too far from wake (780 min)",
      plan([], "20:00"), false],
    ["zero naps, bedtime within range",
      plan([], "10:30"), true],
  ];

  for (const [label, candidate, expected] of feasibleCases) {
    it(`feasibility: ${label} → ${expected ? "feasible" : "infeasible"}`, () => {
      const result = scorePlan(candidate, ctx(), WAKE);

      expect(result.feasible).toBe(expected);
    });
  }

  it("closer to target → lower cost", () => {
    const targetMs = new Date("2026-03-28T18:30:00Z").getTime();

    const closer = scorePlan(plan([["09:30", "11:00"], ["14:00", "15:30"]], "19:00"), ctx(), WAKE, targetMs);
    const farther = scorePlan(plan([["09:30", "11:00"], ["14:00", "15:30"]], "20:00"), ctx(), WAKE, targetMs);

    expect(closer.feasible).toBe(true);
    expect(farther.feasible).toBe(true);
    expect(closer.cost).toBeLessThan(farther.cost);
  });

  it("dropping naps → heavy penalty", () => {
    const targetMs = new Date("2026-03-28T18:30:00Z").getTime();

    const twoNaps = scorePlan(plan([["09:30", "11:00"], ["14:00", "15:30"]], "19:00"), ctx(), WAKE, targetMs, 2);
    // One nap with feasible final WW (11:00 → 14:30 = 210 min, within 9mo max)
    const oneNap = scorePlan(plan([["09:30", "11:00"]], "14:30"), ctx(), WAKE, targetMs, 2);

    expect(twoNaps.feasible).toBe(true);
    expect(oneNap.feasible).toBe(true);
    expect(oneNap.cost).toBeGreaterThan(twoNaps.cost + 400); // 500 penalty per dropped nap
  });
});

// ─── selectBestPlan ──────────────────────────────────────────────────────────

describe("selectBestPlan", () => {
  const recentSleeps = sparseRecentSleeps();

  it("no target → returns natural plan", () => {
    const result = selectBestPlan("2026-03-28T07:00:00Z", [], undefined, ctx({ recentSleeps }), NOW);

    expect(result.source).toBe("natural");
  });

  it("target shifts bedtime by at most the daily cap from natural (asymmetric)", () => {
    const natural = selectBestPlan("2026-03-28T07:00:00Z", [], undefined, ctx({ recentSleeps }), NOW);
    const withTarget = selectBestPlan("2026-03-28T07:00:00Z", [], undefined,
      ctx({ recentSleeps, targetBedtime: "16:00" }), NOW);

    expect(Math.abs(new Date(natural.bedtime).getTime() - new Date(withTarget.bedtime).getTime()))
      .toBeLessThanOrEqual(60 * 60_000);
  });

  it("target_bedtime set: natural's bedtime incorporates target soft-anchor", () => {
    // Both natural and target-guided plans now share the same bedtime
    // (the target soft-anchor moved into recommendBedtime in 2026-05).
    // Source can be either; what matters is that the bedtime shifted
    // toward target relative to no-target.
    const noTarget = selectBestPlan("2026-03-28T07:00:00Z", [], undefined,
      ctx({ recentSleeps }), NOW);
    const withTarget = selectBestPlan("2026-03-28T07:00:00Z", [], undefined,
      ctx({ recentSleeps, targetBedtime: "19:45" }), NOW);

    const noTargetMs = new Date(noTarget.bedtime).getTime();
    const withTargetMs = new Date(withTarget.bedtime).getTime();
    expect(withTargetMs).not.toBe(noTargetMs);
    expect(["natural", "target-guided"]).toContain(withTarget.source);
  });

  it("all-infeasible: returns natural plan with feasible=false instead of silent bad plan", () => {
    // Force 0 naps → no-nap 9mo with wake 07:00 and bedtime ~19:00 →
    // final WW = 720 min, well above max 273 min → hard violation.
    const noDataCtx = ctx({ recentSleeps: [], customNapCount: 0 });
    const result = selectBestPlan("2026-03-28T07:00:00Z", [], undefined, noDataCtx, NOW);
    expect(result.feasible).toBe(false);
    expect(result.source).toBe("natural");
    expect(result.bedtime).toBeDefined();
  });

  it("feasible plan: returns feasible=true", () => {
    const result = selectBestPlan("2026-03-28T07:00:00Z", [], undefined, ctx({ recentSleeps }), NOW);
    expect(result.feasible).toBe(true);
  });
});

// ─── Coherent day plan (assembleState integration) ───────────────────────────

describe("coherent day plan", () => {
  const sparseRows = scheduleRecentSleeps();

  it("morning → during nap → after late nap", () => {
    const morning = assembleState(
      dayData({ baby: utcBaby, recentSleeps: sparseRows, todaySleeps: [],
        todayWakeUp: wake28, now: new Date("2026-03-28T08:00:00Z").getTime() }),
    );

    expect(renderDayPlan(morning)).toMatchInlineSnapshot(`
"strategy: emerging_rhythm
lur 1: 10:00–11:30
lur 2: 14:30–16:00
bedtime: 20:00
naps done: false (2 expected)"
`);

    const duringNap = assembleState(
      dayData({ baby: utcBaby, recentSleeps: sparseRows, todaySleeps: [],
        activeSleep: sleepRow({ end_time: null, start_time: "2026-03-28T09:30:00Z", type: "nap" }),
        todayWakeUp: wake28, now: new Date("2026-03-28T10:30:00Z").getTime() }),
    );

    expect(renderDayPlan(duringNap)).toMatchInlineSnapshot(`
"strategy: emerging_rhythm
lur 1: 14:30–16:00
nap ends: ~10:47
bedtime: 20:00
naps done: false (2 expected)"
`);

    const afterLateNap = assembleState(
      dayData({ baby: utcBaby, recentSleeps: sparseRows,
        todaySleeps: [sleepRow({ id: 10, start_time: "2026-03-28T09:30:00Z",
          end_time: "2026-03-28T15:00:00Z", type: "nap", domain_id: "slp_late" })],
        todayWakeUp: wake28, now: new Date("2026-03-28T15:30:00Z").getTime() }),
    );

    expect(renderDayPlan(afterLateNap)).toMatchInlineSnapshot(`
"strategy: emerging_rhythm
bedtime: 19:00
naps done: true (2 expected)"
`);
    // Pin: when the 2nd predicted nap lands within 60 min of bedtime, emerging
    // collapses to bedtime just like the routine path. nextNap == bedtime.
    expect(afterLateNap.prediction!.napsAllDone).toBe(true);
    expect(afterLateNap.prediction!.nextNap).toBe(afterLateNap.prediction!.bedtime);
    expect(afterLateNap.prediction!.predictedNaps).toBeNull();

    // Pin: bedtime is valid (computed from real data, in a sane window) and
    // sits after the last predicted nap end. The previous "not equal to
    // 19:00 default" pin gave false positives when the actual computation
    // legitimately landed at 19:00.
    for (const r of [morning, duringNap, afterLateNap]) {
      expect(r.prediction!.bedtime).not.toBeNull();
      const bedtimeMs = new Date(r.prediction!.bedtime!).getTime();
      expect(bedtimeMs).toBeGreaterThan(new Date("2026-03-28T15:00:00Z").getTime());
      expect(bedtimeMs).toBeLessThan(new Date("2026-03-29T00:00:00Z").getTime());
      const naps = r.prediction!.predictedNaps;
      if (naps && naps.length > 0) {
        const lastNapEnd = new Date(naps[naps.length - 1].endTime).getTime();
        expect(bedtimeMs).toBeGreaterThan(lastNapEnd);
      }
    }
  });

  it("target bedtime: plan scored and selected, shift capped at 60 min", () => {
    // The cap was originally 15 min, which made target_bedtime essentially
    // cosmetic (target=18:30 with natural=19:45 effective bedtime capped to
    // 19:30). Raised to 60 min so the family's stated target actually pulls
    // predictions toward their preference.
    const bedtimeBaby = { ...baseBaby, timezone: "UTC", target_bedtime: "18:30" };

    const morning = assembleState(
      dayData({ baby: bedtimeBaby, recentSleeps: sparseRows, todaySleeps: [],
        todayWakeUp: wake28, now: new Date("2026-03-28T08:00:00Z").getTime() }),
    );

    expect(renderDayPlan(morning)).toMatchInlineSnapshot(`
      "strategy: emerging_rhythm
      lur 1: 10:00–11:30
      lur 2: 14:30–16:00
      bedtime: 19:45
      naps done: false (2 expected)"
    `);

    const withoutTarget = assembleState(
      dayData({ baby: utcBaby, recentSleeps: sparseRows, todaySleeps: [],
        todayWakeUp: wake28, now: new Date("2026-03-28T08:00:00Z").getTime() }),
    );

    // Pin: target should pull bedtime earlier or equal to learned-only prediction
    const targetBedtimeMs = new Date(morning.prediction!.bedtime!).getTime();
    const learnedBedtimeMs = new Date(withoutTarget.prediction!.bedtime!).getTime();
    expect(targetBedtimeMs).toBeLessThanOrEqual(learnedBedtimeMs);
    // Pin: shift capped at 60 min from natural bedtime
    expect(learnedBedtimeMs - targetBedtimeMs).toBeLessThanOrEqual(60 * 60_000);
  });

  it("midday replan after completed nap: naps and bedtime stay coherent", () => {
    const nap1 = sleepRow({
      id: 10, start_time: "2026-03-28T10:00:00Z",
      end_time: "2026-03-28T11:30:00Z", type: "nap", domain_id: "slp_1",
    });

    const result = assembleState(
      dayData({ baby: utcBaby, recentSleeps: sparseRows,
        todaySleeps: [nap1], todayWakeUp: wake28,
        now: new Date("2026-03-28T12:00:00Z").getTime() }),
    );

    expect(renderDayPlan(result)).toMatchInlineSnapshot(`
"strategy: emerging_rhythm
lur 1: 14:30–16:00
bedtime: 20:00
naps done: false (2 expected)"
`);

    // Pin: remaining nap is after the completed nap
    const naps = result.prediction!.predictedNaps!;
    expect(naps.length).toBe(1);
    expect(new Date(naps[0].startTime).getTime())
      .toBeGreaterThan(new Date(nap1.end_time!).getTime());
    // Pin: bedtime is after the remaining nap
    expect(new Date(result.prediction!.bedtime!).getTime())
      .toBeGreaterThan(new Date(naps[0].endTime).getTime());
  });
});

// ─── buildSleepsForBedtime: synthetic nap cutoff ──────────────────────────────

describe("buildSleepsForBedtime: late-nap cutoff respects family bedtime", () => {
  const noon = new Date("2026-03-28T13:00:00Z").getTime();

  it("cold-start with target=19:45: nap ending 17:01 is retained", () => {
    const c = ctx({ targetBedtime: "19:45", recentSleeps: [] });
    const nap: PredictedNap = {
      startTime: "2026-03-28T16:11:00Z",
      endTime: "2026-03-28T17:01:00Z",
    };
    const result = buildSleepsForBedtime([], undefined, [nap], c, noon);
    expect(result).toHaveLength(1);
  });

  it("no-target fallback: nap ending 17:01 is dropped (past 17:00 floor)", () => {
    const c = ctx({ recentSleeps: [] });
    const nap: PredictedNap = {
      startTime: "2026-03-28T16:11:00Z",
      endTime: "2026-03-28T17:01:00Z",
    };
    const result = buildSleepsForBedtime([], undefined, [nap], c, noon);
    expect(result).toHaveLength(0);
  });

  it("no-target fallback: nap ending exactly 17:00 is kept (boundary is exclusive)", () => {
    const c = ctx({ recentSleeps: [] });
    const nap: PredictedNap = {
      startTime: "2026-03-28T16:10:00Z",
      endTime: "2026-03-28T17:00:00Z",
    };
    const result = buildSleepsForBedtime([], undefined, [nap], c, noon);
    expect(result).toHaveLength(1);
  });
});
