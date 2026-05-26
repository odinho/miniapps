import { describe, expect, it } from "bun:test";
import {
  assembleState,
  arbitrateRescueAgainstNapBudget,
  shouldSuppressContinuation,
  type DayData,
} from "$lib/engine/state.js";
import { computeConfidence } from "$lib/engine/confidence.js";
import type { Baby, SleepLogRow, DayStartRow, SleepEntry, BabyContext } from "$lib/types.js";

const baseBaby: Baby = {
  id: 1,
  name: "Testa",
  birthdate: "2025-06-12",
  created_at: "2026-01-01T00:00:00.000Z",
  custom_nap_count: null,
  potty_mode: 0, track_diaper: 0,
  timezone: null,
  target_bedtime: null,
  created_by_event_id: null,
  updated_by_event_id: null,
};

/**
 * Generate `days` worth of nap+night SleepLogRow entries anchored at
 * `startDate`. ±10 min jitter keeps stdev/mean below the napBudget noise
 * gate (0.12). Shared between the opt-out wire-up test and the
 * anti-ratchet closed-loop test below.
 */
function synthSleepRows(startDate: string, days: number, avgTotalMin: number): SleepLogRow[] {
  const rows: SleepLogRow[] = [];
  let id = 1000;
  for (let i = 0; i < days; i++) {
    const dayMs = new Date(`${startDate}T00:00:00Z`).getTime() + i * 86400_000;
    const jitter = i % 2 === 0 ? 10 : -10;
    const total = avgTotalMin + jitter;
    const nightMin = total * 0.85;
    const napMin = total - nightMin;
    const napStart = new Date(dayMs + 9 * 3600_000);
    rows.push(
      sleepRow({
        id: id++,
        start_time: napStart.toISOString(),
        end_time: new Date(napStart.getTime() + napMin * 60_000).toISOString(),
        type: "nap",
        domain_id: `slp_synth_${i}n`,
        woke_by: "self",
      }),
    );
    const nightStart = new Date(dayMs + 19 * 3600_000);
    rows.push(
      sleepRow({
        id: id++,
        start_time: nightStart.toISOString(),
        end_time: new Date(nightStart.getTime() + nightMin * 60_000).toISOString(),
        type: "night",
        domain_id: `slp_synth_${i}N`,
        woke_by: "self",
      }),
    );
  }
  return rows;
}

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

  it("bedtime prediction at day start respects wake-window pressure", () => {
    // B2: At day start with wake time set but no naps, bedtime should be
    // primarily driven by wake-window pressure (predicted naps + bedtime WW),
    // not dominated by habitual bedtime from historical data.
    const wakeUp: DayStartRow = {
      id: 1, baby_id: 1, date: "2026-03-26",
      wake_time: "2026-03-26T06:25:00.000Z",
      created_at: "2026-03-26T06:25:00.000Z",
      created_by_event_id: null,
    };
    const result = assembleState(
      dayData({
        todayWakeUp: wakeUp,
        now: new Date("2026-03-26T07:00:00.000Z").getTime(),
      }),
    );
    expect(result.prediction).not.toBeNull();
    const bedtime = result.prediction!.bedtime!;
    const bedtimeDate = new Date(bedtime);
    const bedtimeHour = bedtimeDate.getUTCHours() + bedtimeDate.getUTCMinutes() / 60;
    // With the habitual shift cap (45 min), bedtime should stay within
    // reasonable range of pressure-based estimate, not jump to the habitual value.
    // Test data has habitual at 19:30 UTC, but pressure should anchor earlier.
    expect(bedtimeHour).toBeGreaterThanOrEqual(16);
    expect(bedtimeHour).toBeLessThanOrEqual(20);
  });

  it("bedtime prediction at day start with Europe/Oslo timezone", () => {
    // B2: Same test but with explicit timezone (the user's actual setup).
    // Recent data has nights at 19:30 UTC (21:30 CEST). The habitual cap
    // should prevent that from completely dominating over pressure.
    const baby: Baby = { ...baseBaby, timezone: "Europe/Oslo" };
    const wakeUp: DayStartRow = {
      id: 1, baby_id: 1, date: "2026-04-05",
      wake_time: "2026-04-05T04:25:00.000Z", // 06:25 CEST
      created_at: "2026-04-05T04:25:00.000Z",
      created_by_event_id: null,
    };
    const result = assembleState(
      dayData({
        baby,
        todayWakeUp: wakeUp,
        now: new Date("2026-04-05T05:00:00.000Z").getTime(), // 07:00 CEST
      }),
    );
    expect(result.prediction).not.toBeNull();
    const bedtime = result.prediction!.bedtime!;
    const bedtimeDate = new Date(bedtime);
    const bedtimeUtcHour = bedtimeDate.getUTCHours() + bedtimeDate.getUTCMinutes() / 60;
    // With the habitual shift cap, bedtime should not be more than 45 min
    // later than pressure-based. Should be roughly 16:00-18:30 UTC.
    expect(bedtimeUtcHour).toBeGreaterThanOrEqual(15);
    expect(bedtimeUtcHour).toBeLessThanOrEqual(19);
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

  it("subtracts night_waking intervals from night-sleep duration", () => {
    const night = sleepRow({
      id: 42,
      start_time: "2026-03-25T20:00:00.000Z",
      end_time: "2026-03-26T06:00:00.000Z",
      type: "night",
    });
    const waking = {
      id: 1,
      baby_id: 1,
      domain_id: "nwk_1",
      start_time: "2026-03-26T03:00:00.000Z",
      end_time: "2026-03-26T03:10:00.000Z",
      notes: null,
      mood: null,
      deleted: 0,
      created_by_event_id: null,
      updated_by_event_id: null,
    };
    const result = assembleState(
      dayData({
        todaySleeps: [night],
        todayNightWakings: [waking],
      }),
    );
    // 10h night − 10 min waking = 9h50m (590 min)
    expect(result.stats.totalNightMinutes).toBe(590);
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

  // Helper: build a 10-day 1-nap rested-baby history with a ~4h morning WW so
  // compression has room to take effect (compression floor is 2h45m).
  function rested1NapHistory(): SleepLogRow[] {
    const recent: SleepLogRow[] = [];
    for (let d = 19; d <= 28; d++) {
      const date = `2026-04-${String(d).padStart(2, "0")}`;
      recent.push(
        sleepRow({
          id: d * 10 + 1,
          start_time: `${date}T09:30:00Z`, // ~4h after wake-from-night
          end_time: `${date}T11:20:00Z`, // 110 min
          type: "nap",
          woke_by: "self",
          domain_id: `slp_h${d}a`,
        }),
        sleepRow({
          id: d * 10 + 2,
          start_time: `${date}T16:00:00Z`,
          end_time: `2026-04-${String(d + 1).padStart(2, "0")}T05:30:00Z`,
          type: "night",
          woke_by: "self",
          domain_id: `slp_h${d}b`,
        }),
      );
    }
    return recent;
  }

  function halldisLikeOneNapHistory(): SleepLogRow[] {
    const recent: SleepLogRow[] = [];
    let id = 20_000;
    for (let d = 1; d <= 23; d++) {
      const date = `2026-05-${String(d).padStart(2, "0")}`;
      const nextDate = `2026-05-${String(d + 1).padStart(2, "0")}`;
      recent.push(
        sleepRow({
          id: id++,
          start_time: `${date}T09:53:00.000Z`,
          end_time: `${date}T11:48:00.000Z`,
          type: "nap",
          woke_by: "self",
          domain_id: `slp_h_like_${d}_nap`,
        }),
        sleepRow({
          id: id++,
          start_time: `${date}T16:38:00.000Z`,
          end_time: `${nextDate}T04:45:00.000Z`,
          type: "night",
          woke_by: "self",
          domain_id: `slp_h_like_${d}_night`,
        }),
      );
    }
    return recent;
  }

  it("cut-short nap: engine predicts a comeback nap when the day's nap budget isn't met", () => {
    // 10mo, 1-nap regime, predicted nap ~120 min. A 28-min car nap (woken)
    // doesn't fulfill the day's sleep need, so the engine should plan another
    // nap rather than jump straight to bedtime. Without this, "Vaken 4m" with
    // a 28-min nap behind the baby flips napsAllDone=true.
    const baby10mo: Baby = { ...baseBaby, birthdate: "2025-06-12", custom_nap_count: 1 };
    const wakeUp: DayStartRow = {
      id: 1, baby_id: 1, date: "2026-04-29",
      wake_time: "2026-04-29T05:30:00.000Z",
      created_at: "2026-04-29T05:30:00.000Z",
      created_by_event_id: null,
    };
    const cutShort = sleepRow({
      id: 9001,
      start_time: "2026-04-29T06:21:00.000Z",
      end_time: "2026-04-29T06:49:00.000Z", // 28 min, parent-cut-short
      type: "nap",
      woke_by: "woken",
      domain_id: "slp_repro",
    });

    const result = assembleState(
      dayData({
        baby: baby10mo,
        recentSleeps: rested1NapHistory(),
        todaySleeps: [cutShort],
        todayWakeUp: wakeUp,
        now: new Date("2026-04-29T06:53:00.000Z").getTime(),
      }),
    );

    expect(result.prediction!.napsAllDone).toBe(false);
    expect(result.prediction!.predictedNaps).not.toBeNull();
    expect(result.prediction!.predictedNaps!.length).toBeGreaterThan(0);
    // Comeback nap is anchored on the 28-min nap's actual end (06:49 UTC)
    // plus a wake window — must be after the cut-short ended, before bedtime.
    const next = new Date(result.prediction!.nextNap!).getTime();
    expect(next).toBeGreaterThan(new Date("2026-04-29T06:49:00.000Z").getTime());
    expect(next).toBeLessThan(new Date(result.prediction!.bedtime!).getTime());
  });

  it("cut-short nap: comeback wake window is SWA-compressed (Borbély 2-process)", () => {
    // After a 28-min cut-short, the next wake window is shorter than baseline
    // by a concave SWA-weighted factor. discharge = (28/60)^0.7 ≈ 0.58 →
    // factor = 0.6 + 0.4 * 0.58 ≈ 0.83 → comeback ≈ baseline * 0.83 (floored
    // at 2h45m). For the 28-min input we want the comeback to land *earlier*
    // than the same baby's plan after a non-cut-short start.
    const baby10mo: Baby = { ...baseBaby, birthdate: "2025-06-12", custom_nap_count: 1 };
    const wakeUp: DayStartRow = {
      id: 1, baby_id: 1, date: "2026-04-29",
      wake_time: "2026-04-29T05:30:00.000Z",
      created_at: "2026-04-29T05:30:00.000Z",
      created_by_event_id: null,
    };
    const recent = rested1NapHistory();

    // Scenario A: 28-min cut-short ending 06:49 UTC.
    const cutShort = sleepRow({
      start_time: "2026-04-29T06:21:00.000Z",
      end_time: "2026-04-29T06:49:00.000Z",
      type: "nap",
      woke_by: "woken",
    });
    const compressed = assembleState(
      dayData({
        baby: baby10mo, recentSleeps: recent,
        todaySleeps: [cutShort], todayWakeUp: wakeUp,
        now: new Date("2026-04-29T06:53:00.000Z").getTime(),
      }),
    );

    // Scenario B: same baby, but morning wake at 06:49 with no cut-short —
    // i.e. the wake window the engine would use for a normal-day first nap
    // anchored on the same time. This is the baseline the comeback must beat.
    const baseline = assembleState(
      dayData({
        baby: baby10mo, recentSleeps: recent,
        todaySleeps: [],
        todayWakeUp: { ...wakeUp, wake_time: "2026-04-29T06:49:00.000Z" },
        now: new Date("2026-04-29T06:53:00.000Z").getTime(),
      }),
    );

    const compressedNext = new Date(compressed.prediction!.nextNap!).getTime();
    const baselineNext = new Date(baseline.prediction!.nextNap!).getTime();
    expect(compressedNext).toBeLessThan(baselineNext);

    // Pin: compression brings the comeback at least 15 min earlier than the
    // baseline-WW first-nap-of-the-day. This is the science-backed shift the
    // user expected — without it, the engine treats a 28-min nap as if it
    // never happened (at best) or as fully consuming the budget (at worst).
    const minutesEarlier = (baselineNext - compressedNext) / 60_000;
    expect(minutesEarlier).toBeGreaterThanOrEqual(15);

    // Floor (2h45m / 165 min from cut-short end) holds: comeback never lands
    // sooner than 2h45m after the cut-short.
    const cutShortEndMs = new Date("2026-04-29T06:49:00.000Z").getTime();
    expect(compressedNext - cutShortEndMs).toBeGreaterThanOrEqual(165 * 60_000);
  });

  it("cut-short floor protects against very-short naps planning unsafe comebacks", () => {
    // A 5-min "nap" (e.g. nodded off in stroller) shouldn't push the comeback
    // to within minutes of the cut-short. SWA discharge is tiny but the floor
    // (2h45m) keeps recovery safe.
    const baby10mo: Baby = { ...baseBaby, birthdate: "2025-06-12", custom_nap_count: 1 };
    const wakeUp: DayStartRow = {
      id: 1, baby_id: 1, date: "2026-04-29",
      wake_time: "2026-04-29T05:30:00.000Z",
      created_at: "2026-04-29T05:30:00.000Z",
      created_by_event_id: null,
    };
    const microNap = sleepRow({
      start_time: "2026-04-29T06:30:00.000Z",
      end_time: "2026-04-29T06:35:00.000Z", // 5 min
      type: "nap",
      woke_by: "woken",
    });

    const result = assembleState(
      dayData({
        baby: baby10mo,
        recentSleeps: rested1NapHistory(),
        todaySleeps: [microNap],
        todayWakeUp: wakeUp,
        now: new Date("2026-04-29T06:40:00.000Z").getTime(),
      }),
    );

    const next = new Date(result.prediction!.nextNap!).getTime();
    const microEndMs = new Date("2026-04-29T06:35:00.000Z").getTime();
    // Floor enforced at 2h45m
    expect(next - microEndMs).toBeGreaterThanOrEqual(165 * 60_000);
  });

  it("bedtime ignores synthetic comeback naps that the parent skipped", () => {
    // Field-reported regression (2026-05-08): one 46-min cut-short ended
    // 10:07. At 16:22 (6h 15m after that nap end, parent skipped the
    // engine-suggested comeback), bedtime predicted at 19:22 — way too late.
    // Root cause: the re-anchored selectBestPlan added a synthetic comeback
    // (e.g. ~13:00 nap) to buildSleepsForBedtime, dragging the pressure
    // calculation 6h past that synthetic end. The synthetic nap's startTime
    // (13:00) was already in the past at 16:22, so it should have been
    // dropped — it represents a plan the parent already missed.
    const baby10mo: Baby = {
      ...baseBaby,
      birthdate: "2025-06-12",
      timezone: "Europe/Oslo",
    };
    const wakeUp: DayStartRow = {
      id: 1, baby_id: 1, date: "2026-05-08",
      wake_time: "2026-05-08T03:45:00.000Z", // 05:45 Oslo
      created_at: "2026-05-08T03:45:00.000Z",
      created_by_event_id: null,
    };
    const cutShort = sleepRow({
      start_time: "2026-05-08T07:20:40.000Z", // 09:20 Oslo
      end_time: "2026-05-08T08:07:00.000Z",   // 10:07 Oslo, 46 min
      type: "nap",
      woke_by: "self",
    });

    const result = assembleState(
      dayData({
        baby: baby10mo,
        recentSleeps: rested1NapHistory(),
        todaySleeps: [cutShort],
        todayWakeUp: wakeUp,
        now: new Date("2026-05-08T14:22:00.000Z").getTime(), // 16:22 Oslo
      }),
    );

    expect(result.prediction!.bedtime).not.toBeNull();
    const bedtimeMs = new Date(result.prediction!.bedtime!).getTime();
    const cutShortEndMs = new Date("2026-05-08T08:07:00.000Z").getTime();
    const wwFromCutShortMin = (bedtimeMs - cutShortEndMs) / 60_000;

    // Bedtime must be reachable from the cut-short end + a sane bedtime-WW —
    // not the cut-short end + bedtime-WW + synthetic comeback duration. With
    // ~6h learned bedtime-WW for Halldis, that means bedtime within 8h of
    // the cut-short end (anything > 9h is the bug we just fixed).
    expect(wwFromCutShortMin).toBeLessThan(9 * 60);
    // And reasonably close to the cut-short end + bedtime-WW (≥ 5h).
    expect(wwFromCutShortMin).toBeGreaterThan(5 * 60);
  });

  it("bedtime never lands on TOMORROW after a heavy-deficit cut-short day", () => {
    // Field-reported regression (2026-05-07): two cut-shorts (28 min + 39 min)
    // ended 12:44, now 17:43. Engine produced bedtime = 16:00 on the NEXT day
    // ("LEGGETID OM 22t 17m"). Three compounding bugs:
    //   1. recommendBedtime's pressure overflowed past midnight (lastSleep +
    //      6h bedtime-WW = 18:49 + 6h = 00:49) — landed on next day.
    //   2. Sanity clamp set hour to 16:00 of *that overflowed day* — locking
    //      bedtime to next-day 16:00.
    //   3. buildSleepsForBedtime included a synthetic comeback nap that
    //      ended past 17:00, inflating the pressure base.
    // Pin: bedtime stays on TODAY, in a 16:00–22:00 sane window.
    const baby10mo: Baby = {
      ...baseBaby,
      birthdate: "2025-06-12",
      timezone: "Europe/Oslo",
    };
    const wakeUp: DayStartRow = {
      id: 1, baby_id: 1, date: "2026-05-07",
      wake_time: "2026-05-07T03:30:00.000Z",
      created_at: "2026-05-07T03:30:00.000Z",
      created_by_event_id: null,
    };
    const morningCutShort = sleepRow({
      start_time: "2026-05-07T06:21:00.000Z",
      end_time: "2026-05-07T06:49:00.000Z", // 28 min
      type: "nap",
      woke_by: "self",
    });
    const middayCutShort = sleepRow({
      id: 9002,
      start_time: "2026-05-07T10:05:00.000Z",
      end_time: "2026-05-07T10:44:00.000Z", // 39 min
      type: "nap",
      woke_by: "woken",
      domain_id: "slp_mid_cs",
    });

    const result = assembleState(
      dayData({
        baby: baby10mo,
        recentSleeps: rested1NapHistory(),
        todaySleeps: [middayCutShort, morningCutShort], // DESC like prod
        todayWakeUp: wakeUp,
        now: new Date("2026-05-07T15:43:00.000Z").getTime(),
      }),
    );

    expect(result.prediction!.bedtime).not.toBeNull();
    const bedtimeMs = new Date(result.prediction!.bedtime!).getTime();
    // Must be on today (May 7), not tomorrow.
    expect(bedtimeMs).toBeLessThan(new Date("2026-05-08T00:00:00.000Z").getTime());
    // And in a sane evening window (16:00–22:00 Oslo on May 7).
    expect(bedtimeMs).toBeGreaterThan(new Date("2026-05-07T14:00:00.000Z").getTime()); // ≥ 16:00 Oslo
    expect(bedtimeMs).toBeLessThan(new Date("2026-05-07T20:00:00.000Z").getTime());    // < 22:00 Oslo
  });

  it("floor pushes the comeback LATER when the constrained day plan goes too early", () => {
    // Real scenario from the field: 10mo, 1-nap regime, target_bedtime 18:00,
    // 28-min cut-short ending 08:49. The natural plan from selectBestPlan
    // collapses the next WW to ~2h18m to fit the day's budget — but a
    // post-cut-short comeback needs at least 2h45m for safe pressure
    // recovery. Without floor enforcement, the engine recommended 11:07
    // (Napper recommended 12:20 in the same scenario; user agreed that was
    // closer). With the floor, we land at 11:34 — earliest defensible.
    const baby10mo: Baby = {
      ...baseBaby,
      birthdate: "2025-06-12",
      custom_nap_count: 1,
      target_bedtime: "18:00",
      timezone: "Europe/Oslo",
    };
    const wakeUp: DayStartRow = {
      id: 1, baby_id: 1, date: "2026-05-07",
      wake_time: "2026-05-07T03:30:00.000Z", // 05:30 Oslo
      created_at: "2026-05-07T03:30:00.000Z",
      created_by_event_id: null,
    };
    const cutShort = sleepRow({
      start_time: "2026-05-07T06:21:00.000Z", // 08:21 Oslo
      end_time: "2026-05-07T06:49:00.000Z",   // 08:49 Oslo, 28 min
      type: "nap",
      woke_by: "woken",
    });

    const result = assembleState(
      dayData({
        baby: baby10mo,
        recentSleeps: rested1NapHistory(),
        todaySleeps: [cutShort],
        todayWakeUp: wakeUp,
        now: new Date("2026-05-07T08:12:00.000Z").getTime(), // 10:12 Oslo
      }),
    );

    const cutShortEndMs = new Date("2026-05-07T06:49:00.000Z").getTime();
    const next = new Date(result.prediction!.nextNap!).getTime();
    // Hard floor: the comeback must be ≥ 2h45m after the cut-short end,
    // even when the day's natural plan would put it sooner.
    expect(next - cutShortEndMs).toBeGreaterThanOrEqual(165 * 60_000);
    // Sanity ceiling: not so late we bleed into bedtime.
    expect(next).toBeLessThan(new Date(result.prediction!.bedtime!).getTime());
  });

  it("continuation window opens for ~25 min after a cut-short", () => {
    // Pediatric guidance (Mindell, Weissbluth) consistently lands at 15–25
    // min — past that, arousal systems have stabilised and re-induction
    // success rate drops sharply. We use 25 min so the parent gets a
    // realistic try-again window, then is told to plan the comeback nap.
    const baby10mo: Baby = { ...baseBaby, birthdate: "2025-06-12", custom_nap_count: 1 };
    const wakeUp: DayStartRow = {
      id: 1, baby_id: 1, date: "2026-04-29",
      wake_time: "2026-04-29T05:30:00.000Z",
      created_at: "2026-04-29T05:30:00.000Z",
      created_by_event_id: null,
    };
    const cutShort = sleepRow({
      start_time: "2026-04-29T06:21:00.000Z",
      end_time: "2026-04-29T06:49:00.000Z", // 28 min
      type: "nap",
      woke_by: "woken",
    });

    // 4 min after cut-short ended → window OPEN.
    const open = assembleState(
      dayData({
        baby: baby10mo,
        recentSleeps: rested1NapHistory(),
        todaySleeps: [cutShort],
        todayWakeUp: wakeUp,
        now: new Date("2026-04-29T06:53:00.000Z").getTime(),
      }),
    );
    expect(open.prediction!.continuationWindow).not.toBeNull();
    expect(open.prediction!.continuationWindow!.closesAt).toBe("2026-04-29T07:14:00.000Z");
    // capLatestEnd = cut-short start + learnedNapDuration. Pin a generous
    // range to allow learning jitter without making the test brittle.
    const cap = new Date(open.prediction!.continuationWindow!.capLatestEnd).getTime();
    const cutShortStartMs = new Date("2026-04-29T06:21:00.000Z").getTime();
    expect(cap).toBeGreaterThan(cutShortStartMs + 60 * 60_000); // ≥ +60 min
    expect(cap).toBeLessThan(cutShortStartMs + 180 * 60_000);   // ≤ +180 min

    // 30 min after cut-short ended → window CLOSED (>25 min).
    const closed = assembleState(
      dayData({
        baby: baby10mo,
        recentSleeps: rested1NapHistory(),
        todaySleeps: [cutShort],
        todayWakeUp: wakeUp,
        now: new Date("2026-04-29T07:19:00.000Z").getTime(),
      }),
    );
    expect(closed.prediction!.continuationWindow).toBeNull();
  });

  it("continuation window is null while a nap is active", () => {
    // The user already has the baby down — no need to suggest "try now".
    const baby10mo: Baby = { ...baseBaby, birthdate: "2025-06-12", custom_nap_count: 1 };
    const wakeUp: DayStartRow = {
      id: 1, baby_id: 1, date: "2026-04-29",
      wake_time: "2026-04-29T05:30:00.000Z",
      created_at: "2026-04-29T05:30:00.000Z",
      created_by_event_id: null,
    };
    const cutShort = sleepRow({
      id: 9001,
      start_time: "2026-04-29T06:21:00.000Z",
      end_time: "2026-04-29T06:49:00.000Z",
      type: "nap",
      woke_by: "woken",
      domain_id: "slp_cs",
    });
    const activeContinuation = sleepRow({
      id: 9002,
      start_time: "2026-04-29T06:55:00.000Z",
      end_time: null,
      type: "nap",
      domain_id: "slp_cont",
    });

    const result = assembleState(
      dayData({
        baby: baby10mo,
        recentSleeps: rested1NapHistory(),
        todaySleeps: [activeContinuation, cutShort],
        activeSleep: activeContinuation,
        todayWakeUp: wakeUp,
        now: new Date("2026-04-29T06:58:00.000Z").getTime(),
      }),
    );
    expect(result.prediction!.continuationWindow).toBeNull();
  });

  it("[short, full, active] — active nap runs full, not capped as a rescue", () => {
    // 2-nap baby has a 28-min cut-short (woken), then a full 90-min nap, and
    // is now actively napping. The active is making up for the missing short
    // budget, NOT an extra third nap. detectRescueNap must see only the full
    // prior (sufficient) nap and decline the rescue cap so the active runs
    // full. Pre-fix: `completedNaps.length=2 >= expectedNapCount=2` → "extra
    // nap" rescue → wake recommended at activeStart + ~50 min.
    const baby8mo: Baby = { ...baseBaby, birthdate: "2025-06-12", custom_nap_count: 2 };
    const wakeUp: DayStartRow = {
      id: 1, baby_id: 1, date: "2026-02-12",
      wake_time: "2026-02-12T05:30:00.000Z",
      created_at: "2026-02-12T05:30:00.000Z",
      created_by_event_id: null,
    };
    const cutShort = sleepRow({
      id: 8001,
      start_time: "2026-02-12T07:30:00.000Z",
      end_time: "2026-02-12T07:58:00.000Z", // 28 min, parent-cut-short
      type: "nap", woke_by: "woken",
      domain_id: "slp_cs",
    });
    const fullNap = sleepRow({
      id: 8002,
      start_time: "2026-02-12T11:00:00.000Z",
      end_time: "2026-02-12T12:30:00.000Z", // 90 min — sufficient
      type: "nap", woke_by: "self",
      domain_id: "slp_full",
    });
    const activeComeback = sleepRow({
      id: 8003,
      start_time: "2026-02-12T15:00:00.000Z",
      end_time: null,
      type: "nap",
      domain_id: "slp_active",
    });
    const recent = scheduleRecentSleeps();

    // Mirror prod ORDER BY start_time DESC: active (15:00) → full (11:00) → cut-short (07:30)
    const result = assembleState(
      dayData({
        baby: baby8mo,
        recentSleeps: recent,
        todaySleeps: [activeComeback, fullNap, cutShort],
        activeSleep: activeComeback,
        todayWakeUp: wakeUp,
        now: new Date("2026-02-12T15:05:00.000Z").getTime(),
      }),
    );

    // The day is incomplete (1 cut-short + 1 full + 1 active = 1 sufficient
    // completed + 1 active = 2 effective, but the cut-short doesn't count
    // toward the budget so the active is the "missing" nap, not extra).
    expect(result.prediction!.rescueNap).toBeNull();
  });

  it("short-then-full: compression keys off the LATEST cut-short, not an earlier one", () => {
    // Two completed naps: a 70-min mostly-full nap at 09:00, then a 20-min
    // cut-short at 13:00. The comeback should be planned from the 13:00
    // cut-short end (not from the earlier full nap end). With learning
    // suggesting threshold ~50 min, the 70-min nap is sufficient and the
    // 20-min nap is the cut-short.
    const baby10mo: Baby = { ...baseBaby, birthdate: "2025-06-12", custom_nap_count: 2 };
    const wakeUp: DayStartRow = {
      id: 1, baby_id: 1, date: "2026-04-29",
      wake_time: "2026-04-29T05:30:00.000Z",
      created_at: "2026-04-29T05:30:00.000Z",
      created_by_event_id: null,
    };
    // Use a 2-nap rested history so threshold lands so the 70-min counts as
    // sufficient and the 20-min counts as cut-short.
    const recent: SleepLogRow[] = [];
    for (let d = 19; d <= 28; d++) {
      const date = `2026-04-${String(d).padStart(2, "0")}`;
      recent.push(
        sleepRow({ id: d * 10 + 1, start_time: `${date}T08:00:00Z`, end_time: `${date}T09:30:00Z`, type: "nap", woke_by: "self", domain_id: `slp_2n${d}a` }),
        sleepRow({ id: d * 10 + 2, start_time: `${date}T12:30:00Z`, end_time: `${date}T13:50:00Z`, type: "nap", woke_by: "self", domain_id: `slp_2n${d}b` }),
        sleepRow({ id: d * 10 + 3, start_time: `${date}T17:00:00Z`, end_time: `2026-04-${String(d + 1).padStart(2, "0")}T05:30:00Z`, type: "night", woke_by: "self", domain_id: `slp_2n${d}c` }),
      );
    }
    const fullNap = sleepRow({
      id: 8001,
      start_time: "2026-04-29T07:00:00.000Z",
      end_time: "2026-04-29T08:10:00.000Z", // 70 min — sufficient
      type: "nap", woke_by: "self",
      domain_id: "slp_full",
    });
    const cutShort = sleepRow({
      id: 8002,
      start_time: "2026-04-29T11:00:00.000Z",
      end_time: "2026-04-29T11:20:00.000Z", // 20 min cut-short
      type: "nap", woke_by: "woken",
      domain_id: "slp_cs",
    });

    // Mirror prod: server queries todaySleeps `ORDER BY start_time DESC`
    // and `lastCompleted = todaySleeps.find(s.end_time)` relies on that order.
    const result = assembleState(
      dayData({
        baby: baby10mo,
        recentSleeps: recent,
        todaySleeps: [cutShort, fullNap],
        todayWakeUp: wakeUp,
        now: new Date("2026-04-29T11:25:00.000Z").getTime(),
      }),
    );

    // Comeback must be at least 2h45m after the LATEST cut-short (11:20),
    // not from the earlier full nap end. Floor: 14:05 minimum.
    const next = new Date(result.prediction!.nextNap!).getTime();
    const cutShortEndMs = new Date("2026-04-29T11:20:00.000Z").getTime();
    expect(next - cutShortEndMs).toBeGreaterThanOrEqual(165 * 60_000);
  });

  it("B11 regression: 60-min nap with 60-min learned history flips napsAllDone (not skipped)", () => {
    // bugs.e2e.ts:53 reproduction. With seedScheduleHistory(babyId, 1) the
    // engine learns napDuration≈60min and (custom) napCount=1. A single
    // 60-min nap should clear the day's quota and the engine should NOT
    // synthesise a fallback nextNap that then trips napSkipped.
    //
    // Pre-fix bug: `derivePostPlanFields` set
    //   nextNap = fallbackNextNap = predictNextNap(wakeTime, ctx)
    // when remaining was empty, regardless of whether consumed >= expected.
    // The fallback landed at ~12:30, by now=15:00 it was 2.5h overdue, and
    // `napSkipped` fired, producing a phantom "Hoppa over lur 12:30" centre.
    const baby11mo: Baby = { ...baseBaby, birthdate: "2025-06-12", custom_nap_count: 1 };
    // Build 14 days of 1-nap-per-day history matching seedScheduleHistory(., 1).
    const history: SleepLogRow[] = [];
    for (let d = 11; d <= 25; d++) {
      const dateStr = `2026-03-${String(d).padStart(2, "0")}`;
      history.push(
        sleepRow({ id: d * 10 + 1, start_time: `${dateStr}T09:00:00Z`, end_time: `${dateStr}T10:00:00Z`, type: "nap", woke_by: "self", domain_id: `slp_h${d}a` }),
        sleepRow({ id: d * 10 + 2, start_time: `${dateStr}T19:30:00Z`, end_time: `${dateStr}T23:59:00Z`, type: "night", domain_id: `slp_h${d}b` }),
      );
    }
    const wakeUp: DayStartRow = {
      id: 1, baby_id: 1, date: "2026-03-26",
      wake_time: "2026-03-26T06:00:00.000Z",
      created_at: "2026-03-26T06:00:00.000Z",
      created_by_event_id: null,
    };
    const todaysNap = sleepRow({
      start_time: "2026-03-26T09:00:00.000Z",
      end_time: "2026-03-26T10:00:00.000Z", // 60 min
      type: "nap",
      woke_by: "self",
    });

    const result = assembleState(
      dayData({
        baby: baby11mo,
        recentSleeps: history,
        todaySleeps: [todaysNap],
        todayWakeUp: wakeUp,
        now: new Date("2026-03-26T15:00:00.000Z").getTime(),
      }),
    );

    expect(result.prediction!.skippedNap).toBeNull();
    expect(result.prediction!.napsAllDone).toBe(true);
    expect(result.prediction!.nextNap).toBe(result.prediction!.bedtime);
  });

  it("a sufficiently long completed nap still flips napsAllDone for 1-nap baby", () => {
    // Sanity: the cut-short fix doesn't break the normal 1-nap-done flow.
    const baby10mo: Baby = { ...baseBaby, birthdate: "2025-06-12", custom_nap_count: 1 };
    const wakeUp: DayStartRow = {
      id: 1, baby_id: 1, date: "2026-04-29",
      wake_time: "2026-04-29T05:30:00.000Z",
      created_at: "2026-04-29T05:30:00.000Z",
      created_by_event_id: null,
    };
    const fullNap = sleepRow({
      start_time: "2026-04-29T08:00:00.000Z",
      end_time: "2026-04-29T09:50:00.000Z", // 110 min — meets threshold
      type: "nap",
      woke_by: "self",
    });

    const result = assembleState(
      dayData({
        baby: baby10mo,
        todaySleeps: [fullNap],
        todayWakeUp: wakeUp,
        now: new Date("2026-04-29T11:00:00.000Z").getTime(),
      }),
    );

    expect(result.prediction!.napsAllDone).toBe(true);
    expect(result.prediction!.nextNap).toBe(result.prediction!.bedtime);
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

  it("does not surface a doomed comeback nap after a soft-short single nap", () => {
    const baby11mo: Baby = {
      ...baseBaby,
      birthdate: "2025-06-21",
      timezone: "Europe/Oslo",
      custom_nap_count: null,
    };
    const wakeUp: DayStartRow = {
      id: 1,
      baby_id: 1,
      date: "2026-05-24",
      wake_time: "2026-05-24T04:45:00.000Z",
      created_at: "2026-05-24T04:45:00.000Z",
      created_by_event_id: null,
    };
    const softShortNap = sleepRow({
      start_time: "2026-05-24T08:30:00.000Z",
      end_time: "2026-05-24T09:54:00.000Z", // 84 min vs learned ~115 min: short, but no room for a second nap
      type: "nap",
      woke_by: "self",
    });

    const result = assembleState(
      dayData({
        baby: baby11mo,
        recentSleeps: halldisLikeOneNapHistory(),
        todaySleeps: [softShortNap],
        todayWakeUp: wakeUp,
        now: new Date("2026-05-24T10:39:00.000Z").getTime(),
      }),
    );

    expect(result.prediction!.strategy).toBe("routine_schedule");
    expect(result.prediction!.expectedNapCount).toBe(1);
    expect(result.prediction!.predictedNaps).toBeNull();
    expect(result.prediction!.skippedNap).toBeNull();
    expect(result.prediction!.napsAllDone).toBe(true);
    expect(result.prediction!.nextNap).toBe(result.prediction!.bedtime);
  });

  it("skipped nap: napsAllDone when predicted nap is >60 min overdue", () => {
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
    // The skipped slot should be preserved on the prediction so the UI can
    // surface it instead of silently collapsing to bedtime mode.
    expect(result.prediction!.skippedNap).not.toBeNull();
    expect(result.prediction!.postSkipPlan).not.toBeNull();
  });

  it("skipped nap exposes plannedAt slot for the UI", () => {
    // Same setup as the napsAllDone test above — assert the new fields are
    // populated alongside napsAllDone, so the UI can preserve the day's
    // narrative.
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

    // plannedAt is a real ISO timestamp pointing into the past.
    const plannedAt = result.prediction!.skippedNap?.plannedAt;
    expect(plannedAt).toBeTruthy();
    expect(new Date(plannedAt!).getTime()).toBeLessThan(
      new Date("2026-03-28T18:17:00.000Z").getTime(),
    );
    // The post-skip plan must be one of the two supported kinds.
    const planKind = result.prediction!.postSkipPlan?.kind;
    expect(planKind).toBeTruthy();
    expect(["rescue", "earlier-bedtime"]).toContain(planKind!);
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
    // 9mo with 2 expected naps (default), both completed.
    // Use 90-min naps so they exceed the engine's short-nap threshold
    // (max(20, learned 90 - cycle 22.5) ≈ 68 min). 60-min naps would be
    // classified as cut-shorts, leaving the day's budget unfulfilled.
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
      end_time: "2026-03-26T10:00:00.000Z",
      type: "nap",
      domain_id: "slp_1",
    });
    const nap2 = sleepRow({
      id: 2,
      start_time: "2026-03-26T12:00:00.000Z",
      end_time: "2026-03-26T13:30:00.000Z",
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

  it("confidence.napRanges aligns with the visible predictedNaps list", () => {
    // After 1 nap is done, Timer reads napRanges[0] for the *next* nap's ±N min.
    // Under the buggy from-morning-wake list, napRanges[0] was for nap-1
    // (already done) and the displayed SD compounded from a meaningless anchor.
    const tz = "Europe/Oslo";
    const baby2nap: Baby = { ...baseBaby, timezone: tz, custom_nap_count: 2 };
    const wakeUp: DayStartRow = {
      id: 1, baby_id: 1, date: "2026-03-26",
      wake_time: "2026-03-26T05:00:00.000Z",
      created_at: "2026-03-26T05:00:00.000Z",
      created_by_event_id: null,
    };
    const nap1 = sleepRow({
      start_time: "2026-03-26T07:30:00.000Z",
      end_time: "2026-03-26T08:30:00.000Z",
      type: "nap",
    });
    const recent = scheduleRecentSleeps();

    const result = assembleState(
      dayData({
        baby: baby2nap,
        recentSleeps: recent,
        todaySleeps: [nap1],
        todayWakeUp: wakeUp,
        now: new Date("2026-03-26T09:30:00.000Z").getTime(),
      }),
    );

    const predictedNaps = result.prediction!.predictedNaps!;
    const napRanges = result.prediction!.confidence!.napRanges;

    expect(predictedNaps.length).toBeGreaterThan(0);
    expect(napRanges.length).toBe(predictedNaps.length);
    for (let i = 0; i < predictedNaps.length; i++) {
      expect(napRanges[i].startTime).toBe(predictedNaps[i].startTime);
      // Critically: napRanges[0].startTime is *after* the completed nap 1's
      // end. Under the old indexing, napRanges[0] was for nap 1 itself.
      expect(new Date(napRanges[i].startTime).getTime()).toBeGreaterThan(
        new Date(nap1.end_time!).getTime(),
      );
    }

    // The displayed ±N min for the next nap matches what computeConfidence
    // produces for the visible predictedNaps list (compounding-from-zero) —
    // not what compounding from the from-wake position would inflate it to.
    const recentEntries: SleepEntry[] = recent.map((s) => ({
      start_time: s.start_time,
      end_time: s.end_time,
      type: s.type as "nap" | "night",
      woke_by: s.woke_by === "self" || s.woke_by === "woken" ? s.woke_by : null,
    }));
    const direct = computeConfidence(
      predictedNaps,
      result.prediction!.bedtime!,
      result.ageMonths,
      recentEntries,
      tz,
    );
    expect(napRanges[0].startRange.sdMinutes).toBe(direct.napRanges[0].startRange.sdMinutes);
  });

  // Coherent day plan and target bedtime tests → plan-scoring.unit.ts

  describe("napBudget opt-out wire-up", () => {
    function napBudgetScenario(napBudgetOptedIn?: boolean): DayData {
      // Today: an active last nap that, projected, would exceed the trend.
      // Yesterday's night is included so the rolling-24h banked calc has
      // last night's contribution.
      const todayDateStr = "2026-05-13";
      const yesterdayNightStart = new Date(`${todayDateStr}T00:00:00Z`).getTime() - 5 * 3600_000;
      const yesterdayNight = sleepRow({
        id: 9001,
        start_time: new Date(yesterdayNightStart).toISOString(),
        end_time: new Date(yesterdayNightStart + 750 * 60_000).toISOString(),
        type: "night",
        domain_id: "slp_yest_night",
        woke_by: "self",
      });
      const activeNap = sleepRow({
        id: 9100,
        start_time: `${todayDateStr}T08:30:00.000Z`,
        end_time: null,
        type: "nap",
        domain_id: "slp_active",
        woke_by: null,
      });
      const synthHistory = synthSleepRows("2026-04-18", 24, 13 * 60);
      const trendSleeps = [...synthHistory, yesterdayNight];

      return {
        baby: baseBaby,
        activeSleep: activeNap,
        todaySleeps: [activeNap],
        recentSleeps: trendSleeps,
        strategySleeps: trendSleeps,
        trendSleeps,
        todayWakeUp: {
          id: 1,
          baby_id: 1,
          date: todayDateStr,
          wake_time: new Date(yesterdayNightStart + 750 * 60_000).toISOString(),
          created_at: "",
          created_by_event_id: null,
        },
        diaperCount: 0,
        lastDiaperTime: null,
        napBudgetOptedIn,
        now: new Date(`${todayDateStr}T08:55:00.000Z`).getTime(),
      };
    }

    it("opt-in (or default) lets napBudget surface; opt-out suppresses it", () => {
      const optedIn = assembleState(napBudgetScenario(true));
      const optedOut = assembleState(napBudgetScenario(false));
      // The scenario fixture is constructed to clearly over-trend, so the
      // opted-in case must emit a napBudget. A regression that suppresses
      // both calls (e.g. broken Gate 3) used to be invisible behind a
      // `return` early — codex audit 2026-05-25 flagged that no-op.
      expect(optedIn.prediction?.napBudget).not.toBeNull();
      expect(optedOut.prediction?.napBudget ?? null).toBeNull();
    });

    it("undefined napBudgetOptedIn defaults to true (back-compat for callers)", () => {
      const defaulted = assembleState(napBudgetScenario(undefined));
      const explicit = assembleState(napBudgetScenario(true));
      expect(defaulted.prediction?.napBudget).not.toBeNull();
      expect(!!defaulted.prediction?.napBudget).toBe(!!explicit.prediction?.napBudget);
    });
  });

  // ── State-level closed-loop ─────────────────────────────────────────

  /**
   * Stage 4 of the trend-target split (commits b9b0161 → 5012f0a) made
   * `napBudget.context.blendedTrendMin` read the *held intervention*
   * target, not the rolling observed mean. The point: when a parent
   * follows the cap day after day, the observed mean drops, but the
   * cap target itself shouldn't ratchet down — otherwise the cap chases
   * its own tail (target -5 → cap -5 → next-day total -5 → target -5
   * again …) and pulls the baby below their actual sleep need.
   *
   * This test simulates that loop end-to-end through `assembleState`,
   * not just `computeNapBudget` directly. It captures the wiring that
   * the dimensional-bug fix sat on top of: trend split → intervention
   * target → context.blendedTrendMin → UI.
   */
  describe("napBudget anti-ratchet (state-level closed loop)", () => {
    it("intervention target holds while observed drops under sustained cap-follow", () => {
      // Codex re-review 2026-05-26: the prior version of this test had
      // intervention and observed both ~778 throughout — a regression
      // that re-wired the cap to observed wouldn't have been caught.
      // Redesigned per Codex's suggestion: seed a HIGH baseline (24 days
      // at 14h), then simulate 10 LOW days (12h night + 55-min capped
      // nap = ~12.9h total) and assert observable divergence between
      // the held intervention target and the falling observed mean.
      const startDay = "2026-05-13";
      const napStartLocalHour = 8.5;
      const SEED_DAYS = 24;
      const SIM_DAYS = 10;
      const SEED_TOTAL_MIN = 14 * 60; // 840
      const SIM_NIGHT_MIN = 720; // 12h
      const SIM_NAP_MIN = 55; // one cycle; parent caps at the engine's wakeBy

      let history: SleepLogRow[] = synthSleepRows("2026-04-18", SEED_DAYS, SEED_TOTAL_MIN);
      let priorState: import("$lib/engine/trend.js").TrendTargetState | null = null;

      const trail: string[] = [];

      for (let day = 0; day < SIM_DAYS; day++) {
        const today = new Date(`${startDay}T00:00:00Z`).getTime() + day * 86400_000;
        const nightStart = today - 5 * 3600_000;
        const yesterdayNight = sleepRow({
          id: 8000 + day,
          start_time: new Date(nightStart).toISOString(),
          end_time: new Date(nightStart + SIM_NIGHT_MIN * 60_000).toISOString(),
          type: "night",
          domain_id: `slp_yest_night_${day}`,
          woke_by: "self",
        });
        const napStartMs = today + napStartLocalHour * 3600_000;
        const activeNap = sleepRow({
          id: 9000 + day,
          start_time: new Date(napStartMs).toISOString(),
          end_time: null,
          type: "nap",
          domain_id: `slp_active_${day}`,
          woke_by: null,
        });
        const trendSleeps = [...history, yesterdayNight];
        const data: DayData = {
          baby: baseBaby,
          activeSleep: activeNap,
          todaySleeps: [activeNap],
          recentSleeps: trendSleeps,
          strategySleeps: trendSleeps,
          trendSleeps,
          todayWakeUp: {
            id: 1,
            baby_id: 1,
            date: new Date(today).toISOString().slice(0, 10),
            wake_time: new Date(nightStart + SIM_NIGHT_MIN * 60_000).toISOString(),
            created_at: "",
            created_by_event_id: null,
          },
          diaperCount: 0,
          lastDiaperTime: null,
          now: napStartMs + 25 * 60_000,
          priorTrendTargetState: priorState,
        };

        const result = assembleState(data);
        const tt = result.prediction?.trendTargets;
        expect(tt, `day ${day} trendTargets should be computed`).not.toBeNull();
        trail.push(
          `day ${day}: intervention=${tt!.interventionTargetMin} observed=${tt!.observedRecentMin}`,
        );

        // Parent caps the nap at 55 min (one cycle) regardless of whether
        // the engine emits a recommendation — the contract under test is
        // the trend-split wiring, not the cap decision.
        history.push(yesterdayNight, {
          ...activeNap,
          end_time: new Date(napStartMs + SIM_NAP_MIN * 60_000).toISOString(),
          woke_by: "woken",
        });
        priorState = result.prediction?.trendTargets?.state ?? priorState;
      }

      expect(trail.join("\n")).toMatchInlineSnapshot(`
        "day 0: intervention=835 observed=829
        day 1: intervention=835 observed=821
        day 2: intervention=835 observed=816
        day 3: intervention=835 observed=808
        day 4: intervention=835 observed=803
        day 5: intervention=835 observed=795
        day 6: intervention=835 observed=790
        day 7: intervention=835 observed=789
        day 8: intervention=835 observed=788
        day 9: intervention=835 observed=787"
      `);

      const interventions = trail.map((line) => Number(line.match(/intervention=(\d+)/)![1]));
      const observeds = trail.map((line) => Number(line.match(/observed=(\d+)/)![1]));

      // Anti-ratchet pin: intervention drifts ≤ 10 min across 10 days.
      const interventionDrift = Math.max(...interventions) - Math.min(...interventions);
      expect(interventionDrift, "intervention must not ratchet down").toBeLessThanOrEqual(10);

      // Observed must actually fall under sustained cap-follow — proves
      // the test scenario is doing what it claims.
      expect(
        observeds[0] - observeds[observeds.length - 1],
        "observed should fall as low-total days accumulate",
      ).toBeGreaterThan(20);

      // Divergence pin: by the end of 10 days the held intervention
      // target should sit at least 30 min above observed. A regression
      // that wired the cap target back to the observed mean would collapse
      // this divergence to ~0 — the exact death spiral the trend split
      // was designed to prevent.
      const finalDivergence = interventions[interventions.length - 1] - observeds[observeds.length - 1];
      expect(finalDivergence, "intervention should sit ≥ 30 min above observed by day 10").toBeGreaterThanOrEqual(30);
    });
  });

  describe("arbitrateRescueAgainstNapBudget", () => {
    const fakeRescue = {
      recommendedWakeTime: "2026-05-13T13:00:00.000Z",
      reason: "short_prior_nap" as const,
    };
    const fakeNapBudget = {
      wakeBy: "2026-05-13T12:30:00.000Z",
      recommendedDurationMin: 55,
      reason: "over_trend" as const,
      mode: "first-contact" as const,
      urgency: "firm" as const,
      context: {
        blendedTrendMin: 780,
        bankedMin: 770,
        toleranceMin: 20,
        sourceLabel: "7d/30d-blanding",
      },
      cycleNudge: null,
    };

    it("suppresses rescueNap when napBudget is present", () => {
      expect(arbitrateRescueAgainstNapBudget(fakeRescue, fakeNapBudget)).toBeNull();
    });

    it("preserves rescueNap when napBudget is null", () => {
      expect(arbitrateRescueAgainstNapBudget(fakeRescue, null)).toEqual(fakeRescue);
    });

    it("returns null when both are null (vacuous)", () => {
      expect(arbitrateRescueAgainstNapBudget(null, null)).toBeNull();
    });

    it("suppresses regardless of wake-time ordering — napBudget always wins", () => {
      // rescueNap earlier than napBudget.wakeBy. Per Codex review the
      // narrow rule is "napBudget wins" — the full ordering refactor lives
      // in the deferred WakeRecommendation discriminated-union followup.
      const earlierRescue = {
        recommendedWakeTime: "2026-05-13T12:00:00.000Z",
        reason: "short_prior_nap" as const,
      };
      expect(arbitrateRescueAgainstNapBudget(earlierRescue, fakeNapBudget)).toBeNull();
    });
  });

  describe("shouldSuppressContinuation", () => {
    // The screenshot bug: napBudget engine recommends an early wake, the
    // parent obeys (woke_by = "woken"), the nap is short by definition
    // (that's what the cap *did*), and continuationWindow then fires
    // "Forleng luren" — directly contradicting the cap the parent acted
    // on. Each test here pins one gate of the suppression so a future
    // change can't silently regress one of them.

    const napStart = new Date("2026-05-17T10:30:00.000Z").getTime();
    const napEnd = napStart + 60 * 60_000;           // 60 min nap
    const napEndShort = napStart + 28 * 60_000;      // 28 min transit-style cut-short
    const napEndMicro = napStart + 12 * 60_000;      // 12 min micro-nap
    const now = napEnd + 5 * 60_000;                  // 5 min after wake

    const ctx: BabyContext = {
      birthdate: "2025-06-12",
      ageMonths: 11,
      tz: "Europe/Oslo",
      customNapCount: null,
      recentSleeps: [],
      extendedSleeps: [],
      trendSleeps: [],
    };

    function todaySleeps(napDurMin: number, wokeBy: "self" | "woken"): SleepEntry[] {
      return [
        {
          start_time: new Date(napStart - 5 * 3600_000).toISOString(),
          end_time: new Date(napStart - 5 * 3600_000 + 720 * 60_000).toISOString(),
          type: "night",
          woke_by: "self",
        },
        {
          start_time: new Date(napStart).toISOString(),
          end_time: new Date(napStart + napDurMin * 60_000).toISOString(),
          type: "nap",
          woke_by: wokeBy,
        },
      ];
    }

    it("fires on a micro-nap regardless of woke_by (didn't discharge pressure)", () => {
      const cutShort = { startMs: napStart, endMs: napEndMicro, durMin: 12, wokeBy: "woken" as const };
      const out = shouldSuppressContinuation(
        cutShort, ctx, todaySleeps(12, "woken"), [], now, 22, 110,
      );
      expect(out).toBe(false);
    });

    it("fires on a transit-style 28 min woken cut-short (substantial gate not met)", () => {
      // 28 min < 110 * 0.5 → parent likely had to end early (car ride,
      // appointment), not a deliberate cap. Continuation helps.
      const cutShort = { startMs: napStart, endMs: napEndShort, durMin: 28, wokeBy: "woken" as const };
      const out = shouldSuppressContinuation(
        cutShort, ctx, todaySleeps(28, "woken"), [], now, 22, 110,
      );
      expect(out).toBe(false);
    });

    it("SUPPRESSES on a substantial woken nap below trend — the cap-respect bug", () => {
      // The screenshot: 11mo, learned ~110 min nap, parent woke at 60 min
      // because napBudget told them to. Day total still below trend
      // (banked + (cut-off remaining) = trend — the engine's intended target).
      // Without this gate, "Forleng luren" fires right on top of the
      // wake the engine just asked for.
      const cutShort = { startMs: napStart, endMs: napEnd, durMin: 60, wokeBy: "woken" as const };
      const out = shouldSuppressContinuation(
        cutShort, ctx, todaySleeps(60, "woken"), [], now, 22, 110,
      );
      expect(out).toBe(true);
    });

    it("fires when a self-woke baby cut a long nap short (real cut-short, regardless of duration)", () => {
      // Same 60 min nap but with self-wake: the baby actually woke up.
      // High residual pressure → continuation is the right call.
      const cutShort = { startMs: napStart, endMs: napEnd, durMin: 60, wokeBy: "self" as const };
      const out = shouldSuppressContinuation(
        cutShort, ctx, todaySleeps(60, "self"), [], now, 22, 110,
      );
      expect(out).toBe(false);
    });

    it("falls back to old behavior when wokeBy is null/untagged (treat as self)", () => {
      const cutShort = { startMs: napStart, endMs: napEnd, durMin: 60, wokeBy: null };
      const out = shouldSuppressContinuation(
        cutShort, ctx, todaySleeps(60, "self"), [], now, 22, 110,
      );
      // No isDayOnTrend signal (empty trend), no "woken" flag → fire.
      expect(out).toBe(false);
    });

    it("end-to-end: assembleState does NOT emit continuationWindow on cap-respect", () => {
      // The screenshot scenario, end-to-end through assembleState rather
      // than the helper alone. 11mo, learned ~110 min nap (from 10 days
      // of self-wake history), parent-woken at 60 min. Continuation
      // window should be null even though the day is below trend —
      // because the parent followed the engine's cap.
      const baby11mo: Baby = { ...baseBaby, birthdate: "2025-06-12", custom_nap_count: 1 };
      const wakeUp: DayStartRow = {
        id: 1, baby_id: 1, date: "2026-04-29",
        wake_time: "2026-04-29T05:30:00.000Z",
        created_at: "2026-04-29T05:30:00.000Z",
        created_by_event_id: null,
      };
      const capRespectNap = sleepRow({
        id: 9100,
        start_time: "2026-04-29T10:30:00.000Z",
        end_time: "2026-04-29T11:30:00.000Z", // 60 min, parent woke (cap-respect)
        type: "nap",
        woke_by: "woken",
        domain_id: "slp_cap_respect",
      });
      const result = assembleState(
        dayData({
          baby: baby11mo,
          recentSleeps: rested1NapHistory(),
          strategySleeps: rested1NapHistory(),
          trendSleeps: rested1NapHistory(),
          todaySleeps: [capRespectNap],
          todayWakeUp: wakeUp,
          now: new Date("2026-04-29T11:35:00.000Z").getTime(),
        }),
      );
      expect(result.prediction?.continuationWindow).toBeNull();
    });

    it("end-to-end: self-woken cut-short still triggers continuation banner", () => {
      // Same shape but woke_by = "self". The continuation help is
      // appropriate here — the baby actually woke prematurely.
      const baby11mo: Baby = { ...baseBaby, birthdate: "2025-06-12", custom_nap_count: 1 };
      const wakeUp: DayStartRow = {
        id: 1, baby_id: 1, date: "2026-04-29",
        wake_time: "2026-04-29T05:30:00.000Z",
        created_at: "2026-04-29T05:30:00.000Z",
        created_by_event_id: null,
      };
      const selfCutShort = sleepRow({
        id: 9101,
        start_time: "2026-04-29T10:30:00.000Z",
        end_time: "2026-04-29T11:30:00.000Z",
        type: "nap",
        woke_by: "self",
        domain_id: "slp_self_short",
      });
      const result = assembleState(
        dayData({
          baby: baby11mo,
          recentSleeps: rested1NapHistory(),
          strategySleeps: rested1NapHistory(),
          trendSleeps: rested1NapHistory(),
          todaySleeps: [selfCutShort],
          todayWakeUp: wakeUp,
          now: new Date("2026-04-29T11:35:00.000Z").getTime(),
        }),
      );
      expect(result.prediction?.continuationWindow).not.toBeNull();
    });
  });
});
