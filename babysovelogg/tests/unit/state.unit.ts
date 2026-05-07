import { describe, expect, it } from "bun:test";
import { assembleState, type DayData } from "$lib/engine/state.js";
import { computeConfidence } from "$lib/engine/confidence.js";
import type { Baby, SleepLogRow, DayStartRow, SleepEntry } from "$lib/types.js";

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

  it("continuation window opens for ~25 min after a cut-short", () => {
    // Pediatric guidance (Mindell, Weissbluth): for ~25 min after a too-short
    // nap, residual sleep pressure is high enough to re-induce sleep — so a
    // low-stimulation attempt is worth it. After that, arousal stabilises and
    // the next sleep needs a normal-ish wake window.
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
    // capLatestEnd = cut-short start + learnedNapDuration. With ~110 min
    // learned: 06:21 + 110m = 08:11. Pin a generous range to allow learning
    // jitter without making the test brittle.
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
});
