import { describe, expect, it } from "vitest";
import { assembleState, type DayData } from "../../src/engine/state.js";
import type { Baby, SleepLogRow, DayStartRow } from "../../types.js";

const baseBaby: Baby = {
  id: 1,
  name: "Testa",
  birthdate: "2025-06-12",
  created_at: "2026-01-01T00:00:00.000Z",
  custom_nap_count: null,
  potty_mode: 0,
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
    woke_by: null,
    wake_notes: null,
    deleted: 0,
    domain_id: "slp_test",
    created_by_event_id: null,
    updated_by_event_id: null,
    ...overrides,
  };
}

function dayData(overrides: Partial<DayData> = {}): DayData {
  return {
    baby: baseBaby,
    activeSleep: undefined,
    todaySleeps: [],
    recentSleeps: [],
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

  it("no prediction when there is an active sleep", () => {
    const result = assembleState(
      dayData({
        activeSleep: sleepRow({ end_time: null }),
      }),
    );
    expect(result.prediction).toBeNull();
  });

  it("generates prediction when no active sleep and wake-up time set", () => {
    const wakeUp: DayStartRow = {
      id: 1,
      baby_id: 1,
      date: "2026-03-26",
      wake_time: "2026-03-26T07:00:00.000Z",
      created_at: "2026-03-26T07:00:00.000Z",
      created_by_event_id: null,
    };
    const result = assembleState(
      dayData({
        todayWakeUp: wakeUp,
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
    expect(new Date(result.prediction!.nextNap).getTime()).toBeGreaterThan(
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
});
