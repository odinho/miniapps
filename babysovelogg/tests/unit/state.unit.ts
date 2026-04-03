import { describe, expect, it } from "bun:test";
import { assembleState, type DayData } from "$lib/engine/state.js";
import type { Baby, SleepLogRow, DayStartRow } from "$lib/types.js";

const baseBaby: Baby = {
  id: 1,
  name: "Testa",
  birthdate: "2025-06-12",
  created_at: "2026-01-01T00:00:00.000Z",
  custom_nap_count: null,
  potty_mode: 0,
  timezone: null,
  target_bedtime: null,
  created_by_event_id: null,
  updated_by_event_id: null,
};

function sleepRow(overrides: Partial<SleepLogRow> = {}): SleepLogRow {
  return {
    id: 1,
    baby_id: 1,
    start_time: "2026-03-26T09:00:00.000Z",
    end_time: "2026-03-26T10:00:00.000Z",
    type: "nap",
    notes: null,
    mood: null,
    method: null,
    fall_asleep_time: null,
    onset_note: null,
    woke_by: null,
    wake_notes: null,
    wake_mood: null,
    deleted: 0,
    domain_id: "slp_test",
    created_by_event_id: null,
    updated_by_event_id: null,
    ...overrides,
  };
}

/**
 * Generate 14 days of schedule-like recent sleep data for strategy selector.
 * Needs to cover the full hysteresis replay window (6 days back) with enough
 * data at every point for the selector to pick routine_schedule.
 */
function scheduleRecentSleeps(): SleepLogRow[] {
  const sleeps: SleepLogRow[] = [];
  for (let d = 11; d <= 25; d++) {
    const dateStr = `2026-03-${String(d).padStart(2, "0")}`;
    sleeps.push(
      sleepRow({ id: d * 10 + 1, start_time: `${dateStr}T09:30:00Z`, end_time: `${dateStr}T11:00:00Z`, type: "nap", domain_id: `slp_r${d}a` }),
      sleepRow({ id: d * 10 + 2, start_time: `${dateStr}T14:00:00Z`, end_time: `${dateStr}T15:30:00Z`, type: "nap", domain_id: `slp_r${d}b` }),
      sleepRow({ id: d * 10 + 3, start_time: `${dateStr}T19:30:00Z`, end_time: `${dateStr}T23:59:00Z`, type: "night", domain_id: `slp_r${d}c` }),
    );
  }
  return sleeps;
}

function dayData(overrides: Partial<DayData> = {}): DayData {
  return {
    baby: baseBaby,
    activeSleep: undefined,
    todaySleeps: [],
    recentSleeps: scheduleRecentSleeps(),
    todayWakeUp: undefined,
    pausesBySleep: new Map(),
    diaperCount: 0,
    lastDiaperTime: null,
    ...overrides,
  };
}

describe("assembleState", () => {
  it("computes ageMonths from baby birthdate", () => {
    const result = assembleState(dayData());
    expect(result.ageMonths).toBeGreaterThan(0);
    expect(result.baby.name).toBe("Testa");
  });

  it("returns stats from today's sleeps", () => {
    const result = assembleState(
      dayData({
        todaySleeps: [sleepRow()],
      }),
    );
    expect(result.stats.napCount).toBe(1);
    expect(result.stats.totalNapMinutes).toBe(60);
  });

  it("keeps prediction during active nap sleep (bedtime estimate)", () => {
    const wakeUp: DayStartRow = {
      id: 1, baby_id: 1, date: "2026-03-26",
      wake_time: "2026-03-26T07:00:00.000Z",
      created_at: "2026-03-26T07:00:00.000Z",
      created_by_event_id: null,
    };
    const result = assembleState(
      dayData({
        activeSleep: sleepRow({ end_time: null, start_time: "2026-03-26T09:30:00.000Z" }),
        todayWakeUp: wakeUp,
        now: new Date("2026-03-26T10:00:00.000Z").getTime(),
      }),
    );
    expect(result.prediction).not.toBeNull();
    expect(result.prediction!.bedtime).toBeDefined();
  });

  it("no prediction when there is no wake time reference", () => {
    const result = assembleState(
      dayData({
        activeSleep: sleepRow({ end_time: null }),
        now: new Date("2026-03-26T10:00:00.000Z").getTime(),
      }),
    );
    expect(result.prediction).toBeNull();
  });

  it("generates prediction when no active sleep and wake-up time set", () => {
    const wakeUp: DayStartRow = {
      id: 1, baby_id: 1, date: "2026-03-26",
      wake_time: "2026-03-26T07:00:00.000Z",
      created_at: "2026-03-26T07:00:00.000Z",
      created_by_event_id: null,
    };
    const result = assembleState(
      dayData({
        todayWakeUp: wakeUp,
        now: new Date("2026-03-26T08:00:00.000Z").getTime(),
      }),
    );
    expect(result.prediction).not.toBeNull();
    expect(result.prediction!.nextNap).toBeDefined();
    expect(result.prediction!.bedtime).toBeDefined();
    expect(result.prediction!.predictedNaps).not.toBeNull();
  });

  it("prediction uses last completed sleep end time", () => {
    const completedSleep = sleepRow({
      start_time: "2026-03-26T09:00:00.000Z",
      end_time: "2026-03-26T10:00:00.000Z",
    });
    const result = assembleState(
      dayData({
        todaySleeps: [completedSleep],
      }),
    );
    expect(result.prediction).not.toBeNull();
    // Next nap should be after the completed sleep's end time
    expect(new Date(result.prediction!.nextNap!).getTime()).toBeGreaterThan(
      new Date("2026-03-26T10:00:00.000Z").getTime(),
    );
  });

  it("passes through diaper counts", () => {
    const result = assembleState(
      dayData({
        diaperCount: 5,
        lastDiaperTime: "2026-03-26T11:00:00.000Z",
      }),
    );
    expect(result.diaperCount).toBe(5);
    expect(result.lastDiaperTime).toBe("2026-03-26T11:00:00.000Z");
  });

  it("subtracts pauses from stats", () => {
    const sleep = sleepRow({ id: 42 });
    const pausesBySleep = new Map([
      [
        42,
        [
          {
            id: 1,
            sleep_id: 42,
            pause_time: "2026-03-26T09:20:00.000Z",
            resume_time: "2026-03-26T09:30:00.000Z",
            created_by_event_id: null,
          },
        ],
      ],
    ]);
    const result = assembleState(
      dayData({
        todaySleeps: [sleep],
        pausesBySleep,
      }),
    );
    expect(result.stats.totalNapMinutes).toBe(50); // 60 - 10
  });

  it("B2: nextNap derived from day schedule respects custom nap count", () => {
    // 9-month-old with 1 custom nap, woke at 06:00
    // With 1 nap, the single wake window should be much longer than the age-based default
    const baby9mo: Baby = { ...baseBaby, birthdate: "2025-06-12", custom_nap_count: 1 };
    const wakeUp: DayStartRow = {
      id: 1,
      baby_id: 1,
      date: "2026-03-26",
      wake_time: "2026-03-26T06:00:00.000Z",
      created_at: "2026-03-26T06:00:00.000Z",
      created_by_event_id: null,
    };

    const result = assembleState(
      dayData({
        baby: baby9mo,
        todayWakeUp: wakeUp,
        now: new Date("2026-03-26T08:43:00.000Z").getTime(),
      }),
    );

    // With 1 nap for a 9mo, the first wake window should be ~3h (180min midpoint)
    // so next nap should be around 09:00, not 07:30
    // The key assertion: nap should NOT be before 09:00
    const nextNapTime = new Date(result.prediction!.nextNap!);
    expect(nextNapTime.getTime()).toBeGreaterThanOrEqual(
      new Date("2026-03-26T09:00:00.000Z").getTime(),
    );
  });

  it("B8: no nap suggested within 60 min of bedtime", () => {
    // Set up: 9mo baby, wake at 06:00, 1 nap already done ending at 11:00
    // At 16:51 bedtime should be ~18:00, no nap should be suggested
    const baby9mo: Baby = { ...baseBaby, birthdate: "2025-06-12", custom_nap_count: 1 };
    const wakeUp: DayStartRow = {
      id: 1,
      baby_id: 1,
      date: "2026-03-26",
      wake_time: "2026-03-26T06:00:00.000Z",
      created_at: "2026-03-26T06:00:00.000Z",
      created_by_event_id: null,
    };
    const completedNap = sleepRow({
      start_time: "2026-03-26T09:30:00.000Z",
      end_time: "2026-03-26T11:00:00.000Z",
      type: "nap",
    });

    const result = assembleState(
      dayData({
        baby: baby9mo,
        todaySleeps: [completedNap],
        todayWakeUp: wakeUp,
        now: new Date("2026-03-26T16:51:00.000Z").getTime(),
      }),
    );

    // With 1 custom nap and 1 completed, napsAllDone should be true
    expect(result.prediction!.napsAllDone).toBe(true);
    // nextNap should be bedtime, not a new nap
    expect(result.prediction!.nextNap).toBe(result.prediction!.bedtime);
  });

  it("skipped nap: napsAllDone when predicted nap is >90 min overdue", () => {
    // 9mo baby, 2 expected naps, only 1 done. At 18:17, the second predicted nap was hours ago.
    const wakeUp: DayStartRow = {
      id: 1, baby_id: 1, date: "2026-03-28",
      wake_time: "2026-03-28T06:15:00.000Z",
      created_at: "2026-03-28T06:15:00.000Z",
      created_by_event_id: null,
    };
    const longNap = sleepRow({
      start_time: "2026-03-28T09:46:00.000Z",
      end_time: "2026-03-28T12:22:00.000Z",
      type: "nap",
    });

    const result = assembleState(
      dayData({
        todaySleeps: [longNap],
        todayWakeUp: wakeUp,
        now: new Date("2026-03-28T18:17:00.000Z").getTime(),
      }),
    );

    expect(result.prediction!.napsAllDone).toBe(true);
    expect(result.prediction!.nextNap).toBe(result.prediction!.bedtime);
    expect(result.prediction!.predictedNaps).toBeNull();
  });

  it("stale predictions recalculated from actual wake time after long nap", () => {
    // Nap ran much longer than predicted — remaining predictions should start from actual wake time
    const wakeUp: DayStartRow = {
      id: 1, baby_id: 1, date: "2026-03-28",
      wake_time: "2026-03-28T06:15:00.000Z",
      created_at: "2026-03-28T06:15:00.000Z",
      created_by_event_id: null,
    };
    const longNap = sleepRow({
      start_time: "2026-03-28T09:46:00.000Z",
      end_time: "2026-03-28T12:22:00.000Z",
      type: "nap",
    });

    const result = assembleState(
      dayData({
        todaySleeps: [longNap],
        todayWakeUp: wakeUp,
        now: new Date("2026-03-28T12:49:00.000Z").getTime(),
      }),
    );

    // Should have a prediction with next nap after 12:22 (not from the stale day schedule)
    if (result.prediction!.predictedNaps && result.prediction!.predictedNaps.length > 0) {
      const nextPredicted = new Date(result.prediction!.predictedNaps[0].startTime);
      expect(nextPredicted.getTime()).toBeGreaterThan(
        new Date("2026-03-28T12:22:00.000Z").getTime(),
      );
    }
    expect(new Date(result.prediction!.nextNap!).getTime()).toBeGreaterThan(
      new Date("2026-03-28T12:22:00.000Z").getTime(),
    );
  });

  it("active nap counts toward consumed slots (no predicted overlap)", () => {
    // Baby is actively napping (nap 1). Predicted naps should not include nap 1's slot.
    const wakeUp: DayStartRow = {
      id: 1, baby_id: 1, date: "2026-03-28",
      wake_time: "2026-03-28T06:15:00.000Z",
      created_at: "2026-03-28T06:15:00.000Z",
      created_by_event_id: null,
    };

    const result = assembleState(
      dayData({
        activeSleep: sleepRow({
          start_time: "2026-03-28T09:46:00.000Z",
          end_time: null,
          type: "nap",
        }),
        todayWakeUp: wakeUp,
        now: new Date("2026-03-28T10:30:00.000Z").getTime(),
      }),
    );

    // predictedNaps should only show remaining naps after the active one
    // For a 9mo baby with 2 expected naps, 1 active → 1 remaining predicted
    const remaining = result.prediction!.predictedNaps;
    expect(remaining).not.toBeNull();
    if (remaining && remaining.length > 0) {
      // None should start before the baby woke up (06:15) → they're all future
      for (const n of remaining) {
        expect(new Date(n.startTime).getTime()).toBeGreaterThan(
          new Date("2026-03-28T09:46:00.000Z").getTime(),
        );
      }
    }
  });

  it("B11: napsAllDone flag set when all expected naps are completed", () => {
    // 9mo with 2 expected naps (default), both completed
    const wakeUp: DayStartRow = {
      id: 1,
      baby_id: 1,
      date: "2026-03-26",
      wake_time: "2026-03-26T06:00:00.000Z",
      created_at: "2026-03-26T06:00:00.000Z",
      created_by_event_id: null,
    };
    const nap1 = sleepRow({
      id: 1,
      start_time: "2026-03-26T08:30:00.000Z",
      end_time: "2026-03-26T09:30:00.000Z",
      type: "nap",
      domain_id: "slp_1",
    });
    const nap2 = sleepRow({
      id: 2,
      start_time: "2026-03-26T12:00:00.000Z",
      end_time: "2026-03-26T13:00:00.000Z",
      type: "nap",
      domain_id: "slp_2",
    });

    const result = assembleState(
      dayData({
        todaySleeps: [nap1, nap2],
        todayWakeUp: wakeUp,
        now: new Date("2026-03-26T15:00:00.000Z").getTime(),
      }),
    );

    expect(result.prediction!.napsAllDone).toBe(true);
    // Should show bedtime, not next nap
    expect(result.prediction!.nextNap).toBe(result.prediction!.bedtime);
  });

  // ── Coherent day plan: bedtime derived from predicted naps ──
  // These tests use sparse recent data (< 3 nights) so habitual bedtime weight
  // is 0 and bedtime is purely pressure-based. This lets us verify the coherent
  // day plan without habitual blending masking the change.

  /** Sparse recent sleeps: enough for strategy to pick routine_schedule, but
   *  too few nights for habitual bedtime weight (needs ≥ 3). */
  function sparseRecentSleeps(): SleepLogRow[] {
    const sleeps: SleepLogRow[] = [];
    for (let d = 11; d <= 25; d++) {
      const ds = `2026-03-${String(d).padStart(2, "0")}`;
      sleeps.push(
        sleepRow({ id: d * 10 + 1, start_time: `${ds}T09:30:00Z`, end_time: `${ds}T11:00:00Z`, type: "nap", domain_id: `r${d}a` }),
        sleepRow({ id: d * 10 + 2, start_time: `${ds}T14:00:00Z`, end_time: `${ds}T15:30:00Z`, type: "nap", domain_id: `r${d}b` }),
      );
    }
    // Only 2 nights — below the habitual bedtime threshold of 3
    sleeps.push(
      sleepRow({ id: 901, start_time: "2026-03-24T19:30:00Z", end_time: "2026-03-24T23:59:00Z", type: "night", domain_id: "rn1" }),
      sleepRow({ id: 902, start_time: "2026-03-25T19:30:00Z", end_time: "2026-03-25T23:59:00Z", type: "night", domain_id: "rn2" }),
    );
    return sleeps;
  }

  it("bedtime derived from predicted naps when no naps completed yet", () => {
    // 9mo baby, wake at 07:00 UTC, no completed sleeps.
    // Without coherent day plan: recommendBedtime([]) → 19:00 UTC default.
    // With coherent day plan: bedtime = last predicted nap end + bedtime wake window.
    const wakeUp: DayStartRow = {
      id: 1, baby_id: 1, date: "2026-03-28",
      wake_time: "2026-03-28T07:00:00.000Z",
      created_at: "2026-03-28T07:00:00.000Z",
      created_by_event_id: null,
    };
    const result = assembleState(
      dayData({
        baby: { ...baseBaby, timezone: "UTC" },
        recentSleeps: sparseRecentSleeps(),
        todaySleeps: [],
        todayWakeUp: wakeUp,
        now: new Date("2026-03-28T08:00:00.000Z").getTime(),
      }),
    );

    const bedtime = result.prediction!.bedtime!;
    const predictedNaps = result.prediction!.predictedNaps!;

    // Full day plan should be visible
    expect(predictedNaps.length).toBeGreaterThan(0);

    // Bedtime must NOT be the empty-data default of exactly 19:00 UTC
    expect(bedtime).not.toBe("2026-03-28T19:00:00.000Z");

    // Bedtime should be AFTER the last predicted nap ends (pressure-based)
    const lastNapEnd = new Date(predictedNaps[predictedNaps.length - 1].endTime).getTime();
    const bedtimeMs = new Date(bedtime).getTime();
    expect(bedtimeMs).toBeGreaterThan(lastNapEnd);
  });

  it("bedtime shifts when actual nap ends later than predicted", () => {
    // Compare bedtime before any naps vs after a nap that ended significantly
    // later than predicted. With pressure-based bedtime (no habitual), the
    // later nap end should push bedtime later.
    const wakeUp: DayStartRow = {
      id: 1, baby_id: 1, date: "2026-03-28",
      wake_time: "2026-03-28T07:00:00.000Z",
      created_at: "2026-03-28T07:00:00.000Z",
      created_by_event_id: null,
    };
    const sparse = sparseRecentSleeps();

    const beforeNap = assembleState(
      dayData({
        baby: { ...baseBaby, timezone: "UTC" },
        recentSleeps: sparse,
        todaySleeps: [],
        todayWakeUp: wakeUp,
        now: new Date("2026-03-28T08:00:00.000Z").getTime(),
      }),
    );

    // Nap that ran much longer than typical (ending 13:00 instead of ~11:00)
    const lateNap = sleepRow({
      id: 10, start_time: "2026-03-28T09:30:00.000Z",
      end_time: "2026-03-28T13:00:00.000Z",
      type: "nap", domain_id: "slp_late",
    });
    const afterLateNap = assembleState(
      dayData({
        baby: { ...baseBaby, timezone: "UTC" },
        recentSleeps: sparse,
        todaySleeps: [lateNap],
        todayWakeUp: wakeUp,
        now: new Date("2026-03-28T13:30:00.000Z").getTime(),
      }),
    );

    // Both should have real bedtimes, not the 19:00 default
    expect(beforeNap.prediction!.bedtime).not.toBe("2026-03-28T19:00:00.000Z");
    expect(afterLateNap.prediction!.bedtime).not.toBe("2026-03-28T19:00:00.000Z");
    // The late nap should push bedtime later
    expect(new Date(afterLateNap.prediction!.bedtime!).getTime())
      .toBeGreaterThan(new Date(beforeNap.prediction!.bedtime!).getTime());
  });

  it("bedtime updates during active nap using predicted nap end", () => {
    const wakeUp: DayStartRow = {
      id: 1, baby_id: 1, date: "2026-03-28",
      wake_time: "2026-03-28T07:00:00.000Z",
      created_at: "2026-03-28T07:00:00.000Z",
      created_by_event_id: null,
    };
    const result = assembleState(
      dayData({
        baby: { ...baseBaby, timezone: "UTC" },
        recentSleeps: sparseRecentSleeps(),
        todaySleeps: [],
        activeSleep: sleepRow({
          end_time: null,
          start_time: "2026-03-28T09:30:00.000Z",
          type: "nap",
        }),
        todayWakeUp: wakeUp,
        now: new Date("2026-03-28T10:30:00.000Z").getTime(),
      }),
    );

    // Should not be the 19:00 UTC default
    expect(result.prediction!.bedtime).not.toBe("2026-03-28T19:00:00.000Z");
  });
});
