import { describe, expect, it, beforeEach } from "bun:test";
import { initDb, db } from "$lib/server/db.js";
import {
  reconcileNotifications,
  fireDueNotifications,
  type ReconcileInput,
} from "$lib/server/notification-scheduler.js";
import { setPrefs } from "$lib/server/notification-prefs.js";
import type { SleepLogRow, Baby } from "$lib/types.js";
import type { Prediction } from "$lib/stores/app.svelte.js";

beforeEach(() => {
  initDb(":memory:");
  db.prepare("INSERT INTO baby (id, name, birthdate) VALUES (1, 'Test', '2025-06-12')").run();
});

const baby: Baby = {
  id: 1,
  name: "Test",
  birthdate: "2025-06-12",
  created_at: "2026-01-01T00:00:00.000Z",
  custom_nap_count: null,
  potty_mode: 0,
  timezone: "Europe/Oslo",
  target_bedtime: "18:00",
  created_by_event_id: null,
  updated_by_event_id: null,
};

function makeActiveSleep(startTime: string, domainId = "slp_test", type = "nap"): SleepLogRow {
  return {
    id: 1,
    baby_id: 1,
    start_time: startTime,
    end_time: null,
    type,
    notes: null,
    mood: null,
    method: null,
    fall_asleep_time: null,
    onset_note: null,
    woke_by: null,
    wake_notes: null,
    wake_mood: null,
    deleted: 0,
    domain_id: domainId,
    created_by_event_id: null,
    updated_by_event_id: null,
  };
}

function makePrediction(overrides: Partial<Prediction> = {}): Prediction {
  return {
    strategy: "routine_schedule",
    nextNap: null,
    bedtime: null,
    predictedNaps: null,
    expectedNapCount: 2,
    napsAllDone: false,
    expectedNapEnd: null,
    expectedNightEnd: null,
    confidence: null,
    calibration: null,
    sleepWindow: null,
    sleepPressure: null,
    totalSleep24h: null,
    longestStretch: null,
    longestStretchTrend: null,
    longestStretchDetail: null,
    ageNorms: null,
    rolling: null,
    learnedSchedule: null,
    rescueNap: null,
    continuationWindow: null,
    ...overrides,
  };
}

function rowsOf(kind: string) {
  return db
    .prepare(
      "SELECT * FROM notification_schedule WHERE kind = ? AND cancelled_at IS NULL ORDER BY id",
    )
    .all(kind) as Array<{ fire_at: string; dedupe_key: string; payload_json: string }>;
}

describe("reconcileNotifications – rescue_wake", () => {
  it("schedules 2 min before recommended wake time", () => {
    const active = makeActiveSleep("2026-04-13T12:00:00.000Z");
    reconcileNotifications({
      baby,
      activeSleep: active,
      prediction: makePrediction({
        rescueNap: { recommendedWakeTime: "2026-04-13T12:45:00.000Z", reason: "short_prior_nap" },
      }),
    });
    const rows = rowsOf("rescue_wake");
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].fire_at).toISOString()).toBe("2026-04-13T12:43:00.000Z");
  });

  it("is idempotent", () => {
    const active = makeActiveSleep("2026-04-13T12:00:00.000Z");
    const input: ReconcileInput = {
      baby,
      activeSleep: active,
      prediction: makePrediction({
        rescueNap: { recommendedWakeTime: "2026-04-13T12:45:00.000Z", reason: "short_prior_nap" },
      }),
    };
    reconcileNotifications(input);
    reconcileNotifications(input);
    expect(rowsOf("rescue_wake")).toHaveLength(1);
  });

  it("cancels when rescue nap is gone", () => {
    const active = makeActiveSleep("2026-04-13T12:00:00.000Z");
    reconcileNotifications({
      baby,
      activeSleep: active,
      prediction: makePrediction({
        rescueNap: { recommendedWakeTime: "2026-04-13T12:45:00.000Z", reason: "short_prior_nap" },
      }),
    });
    reconcileNotifications({ baby, activeSleep: null, prediction: makePrediction() });
    expect(rowsOf("rescue_wake")).toHaveLength(0);
  });
});

describe("reconcileNotifications – nap_ending_soon", () => {
  it("schedules 2 min before expected nap end for normal nap", () => {
    const active = makeActiveSleep("2026-04-13T12:00:00.000Z");
    reconcileNotifications({
      baby,
      activeSleep: active,
      prediction: makePrediction({ expectedNapEnd: "2026-04-13T13:30:00.000Z" }),
    });
    const rows = rowsOf("nap_ending_soon");
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].fire_at).toISOString()).toBe("2026-04-13T13:28:00.000Z");
  });

  it("is skipped when rescue nap is active (avoid double-notify)", () => {
    const active = makeActiveSleep("2026-04-13T12:00:00.000Z");
    reconcileNotifications({
      baby,
      activeSleep: active,
      prediction: makePrediction({
        expectedNapEnd: "2026-04-13T13:30:00.000Z",
        rescueNap: { recommendedWakeTime: "2026-04-13T12:45:00.000Z", reason: "short_prior_nap" },
      }),
    });
    expect(rowsOf("nap_ending_soon")).toHaveLength(0);
    expect(rowsOf("rescue_wake")).toHaveLength(1);
  });

  it("respects prefs.nap_ending_soon = false", () => {
    setPrefs(1, { nap_ending_soon: false });
    const active = makeActiveSleep("2026-04-13T12:00:00.000Z");
    reconcileNotifications({
      baby,
      activeSleep: active,
      prediction: makePrediction({ expectedNapEnd: "2026-04-13T13:30:00.000Z" }),
    });
    expect(rowsOf("nap_ending_soon")).toHaveLength(0);
  });
});

describe("reconcileNotifications – nap_overtime", () => {
  it("schedules 20 min after expected nap end", () => {
    const active = makeActiveSleep("2026-04-13T12:00:00.000Z");
    reconcileNotifications({
      baby,
      activeSleep: active,
      prediction: makePrediction({ expectedNapEnd: "2026-04-13T13:30:00.000Z" }),
    });
    const rows = rowsOf("nap_overtime");
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].fire_at).toISOString()).toBe("2026-04-13T13:50:00.000Z");
  });

  it("fires alongside nap_ending_soon for normal naps", () => {
    const active = makeActiveSleep("2026-04-13T12:00:00.000Z");
    reconcileNotifications({
      baby,
      activeSleep: active,
      prediction: makePrediction({ expectedNapEnd: "2026-04-13T13:30:00.000Z" }),
    });
    expect(rowsOf("nap_ending_soon")).toHaveLength(1);
    expect(rowsOf("nap_overtime")).toHaveLength(1);
  });

  it("respects prefs.nap_overtime = false", () => {
    setPrefs(1, { nap_overtime: false });
    const active = makeActiveSleep("2026-04-13T12:00:00.000Z");
    reconcileNotifications({
      baby,
      activeSleep: active,
      prediction: makePrediction({ expectedNapEnd: "2026-04-13T13:30:00.000Z" }),
    });
    expect(rowsOf("nap_overtime")).toHaveLength(0);
  });
});

describe("reconcileNotifications – bedtime_approaching", () => {
  it("schedules 30 min before bedtime when baby is awake", () => {
    reconcileNotifications({
      baby,
      activeSleep: null,
      prediction: makePrediction({ bedtime: "2026-04-13T18:00:00.000Z" }),
    });
    const rows = rowsOf("bedtime_approaching");
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].fire_at).toISOString()).toBe("2026-04-13T17:30:00.000Z");
  });

  it("uses per-day dedupe key", () => {
    reconcileNotifications({
      baby,
      activeSleep: null,
      prediction: makePrediction({ bedtime: "2026-04-13T18:00:00.000Z" }),
    });
    reconcileNotifications({
      baby,
      activeSleep: null,
      prediction: makePrediction({ bedtime: "2026-04-13T18:15:00.000Z" }),
    });
    const rows = rowsOf("bedtime_approaching");
    expect(rows).toHaveLength(1);
    // Second call should have updated fire_at
    expect(new Date(rows[0].fire_at).toISOString()).toBe("2026-04-13T17:45:00.000Z");
  });

  it("cancels when night sleep starts", () => {
    reconcileNotifications({
      baby,
      activeSleep: null,
      prediction: makePrediction({ bedtime: "2026-04-13T18:00:00.000Z" }),
    });
    const night = makeActiveSleep("2026-04-13T17:55:00.000Z", "slp_night", "night");
    reconcileNotifications({ baby, activeSleep: night, prediction: makePrediction() });
    expect(rowsOf("bedtime_approaching")).toHaveLength(0);
  });

  it("does not schedule during an active nap", () => {
    const active = makeActiveSleep("2026-04-13T12:00:00.000Z");
    reconcileNotifications({
      baby,
      activeSleep: active,
      prediction: makePrediction({ bedtime: "2026-04-13T18:00:00.000Z" }),
    });
    expect(rowsOf("bedtime_approaching")).toHaveLength(0);
  });
});

describe("reconcileNotifications – nap_overdue", () => {
  it("is off by default", () => {
    reconcileNotifications({
      baby,
      activeSleep: null,
      prediction: makePrediction({ nextNap: "2026-04-13T10:00:00.000Z" }),
    });
    expect(rowsOf("nap_overdue")).toHaveLength(0);
  });

  it("schedules 30 min after nextNap when enabled", () => {
    setPrefs(1, { nap_overdue: true });
    reconcileNotifications({
      baby,
      activeSleep: null,
      prediction: makePrediction({ nextNap: "2026-04-13T10:00:00.000Z" }),
    });
    const rows = rowsOf("nap_overdue");
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].fire_at).toISOString()).toBe("2026-04-13T10:30:00.000Z");
  });

  it("cancels when a nap starts", () => {
    setPrefs(1, { nap_overdue: true });
    reconcileNotifications({
      baby,
      activeSleep: null,
      prediction: makePrediction({ nextNap: "2026-04-13T10:00:00.000Z" }),
    });
    const active = makeActiveSleep("2026-04-13T10:05:00.000Z");
    reconcileNotifications({ baby, activeSleep: active, prediction: makePrediction() });
    expect(rowsOf("nap_overdue")).toHaveLength(0);
  });

  it("skips when napsAllDone", () => {
    setPrefs(1, { nap_overdue: true });
    reconcileNotifications({
      baby,
      activeSleep: null,
      prediction: makePrediction({ nextNap: "2026-04-13T10:00:00.000Z", napsAllDone: true }),
    });
    expect(rowsOf("nap_overdue")).toHaveLength(0);
  });
});

describe("reconcileNotifications – continuation_open", () => {
  it("schedules to fire immediately when continuation window is set and baby is awake", () => {
    const before = Date.now();
    reconcileNotifications({
      baby,
      activeSleep: null,
      prediction: makePrediction({
        continuationWindow: {
          closesAt: "2026-04-29T07:34:00.000Z",
          capLatestEnd: "2026-04-29T08:11:00.000Z",
        },
      }),
    });
    const rows = rowsOf("continuation_open");
    expect(rows).toHaveLength(1);
    // fire_at should be ~now (we use Date.now() in the upsert)
    const fireAtMs = new Date(rows[0].fire_at).getTime();
    expect(fireAtMs).toBeGreaterThanOrEqual(before);
    expect(fireAtMs).toBeLessThanOrEqual(Date.now() + 1000);
    const payload = JSON.parse(rows[0].payload_json);
    expect(payload.title).toBe("Forleng luren");
    expect(payload.body).toContain("vindauget stenger");
  });

  it("dedupes by closesAt — same window doesn't double-fire", () => {
    const cw = {
      closesAt: "2026-04-29T07:34:00.000Z",
      capLatestEnd: "2026-04-29T08:11:00.000Z",
    };
    reconcileNotifications({
      baby, activeSleep: null,
      prediction: makePrediction({ continuationWindow: cw }),
    });
    reconcileNotifications({
      baby, activeSleep: null,
      prediction: makePrediction({ continuationWindow: cw }),
    });
    expect(rowsOf("continuation_open")).toHaveLength(1);
  });

  it("cancels when baby starts napping (continuation succeeded)", () => {
    reconcileNotifications({
      baby, activeSleep: null,
      prediction: makePrediction({
        continuationWindow: {
          closesAt: "2026-04-29T07:34:00.000Z",
          capLatestEnd: "2026-04-29T08:11:00.000Z",
        },
      }),
    });
    expect(rowsOf("continuation_open")).toHaveLength(1);

    const active = makeActiveSleep("2026-04-29T07:30:00.000Z");
    reconcileNotifications({
      baby, activeSleep: active,
      prediction: makePrediction({ continuationWindow: null }),
    });
    expect(rowsOf("continuation_open")).toHaveLength(0);
  });
});

describe("reconcileNotifications – prefs gating", () => {
  it("respects prefs.rescue_wake = false", () => {
    setPrefs(1, { rescue_wake: false });
    const active = makeActiveSleep("2026-04-13T12:00:00.000Z");
    reconcileNotifications({
      baby,
      activeSleep: active,
      prediction: makePrediction({
        rescueNap: { recommendedWakeTime: "2026-04-13T12:45:00.000Z", reason: "short_prior_nap" },
      }),
    });
    expect(rowsOf("rescue_wake")).toHaveLength(0);
  });

  it("no-op when there's no baby", () => {
    reconcileNotifications({ baby: null, activeSleep: null, prediction: null });
    const rows = db.prepare("SELECT * FROM notification_schedule").all();
    expect(rows).toHaveLength(0);
  });
});

describe("fireDueNotifications", () => {
  it("does not fire future notifications", async () => {
    db.prepare(
      `INSERT INTO notification_schedule (baby_id, kind, fire_at, dedupe_key, payload_json)
       VALUES (1, 'rescue_wake', '2030-01-01T00:00:00.000Z', 'future', '{"title":"x","body":"y"}')`,
    ).run();
    await fireDueNotifications(new Date("2026-04-13T12:00:00.000Z"));
    const row = db.prepare("SELECT sent_at FROM notification_schedule").get() as {
      sent_at: string | null;
    };
    expect(row.sent_at).toBeNull();
  });

  it("marks due notifications as sent even with no subscriptions", async () => {
    db.prepare(
      `INSERT INTO notification_schedule (baby_id, kind, fire_at, dedupe_key, payload_json)
       VALUES (1, 'rescue_wake', '2026-04-13T11:00:00.000Z', 'past', '{"title":"x","body":"y"}')`,
    ).run();
    await fireDueNotifications(new Date("2026-04-13T12:00:00.000Z"));
    const row = db.prepare("SELECT sent_at FROM notification_schedule").get() as {
      sent_at: string | null;
    };
    expect(row.sent_at).not.toBeNull();
  });

  it("skips cancelled notifications", async () => {
    db.prepare(
      `INSERT INTO notification_schedule (baby_id, kind, fire_at, dedupe_key, payload_json, cancelled_at)
       VALUES (1, 'rescue_wake', '2026-04-13T11:00:00.000Z', 'cancelled', '{"title":"x","body":"y"}', datetime('now'))`,
    ).run();
    await fireDueNotifications(new Date("2026-04-13T12:00:00.000Z"));
    const row = db.prepare("SELECT sent_at FROM notification_schedule").get() as {
      sent_at: string | null;
    };
    expect(row.sent_at).toBeNull();
  });
});
