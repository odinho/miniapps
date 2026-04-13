import { describe, expect, it, beforeEach } from "bun:test";
import { initDb, db } from "$lib/server/db.js";
import {
  reconcileNotifications,
  fireDueNotifications,
  type ReconcileInput,
} from "$lib/server/notification-scheduler.js";
import type { SleepLogRow, Baby } from "$lib/types.js";
import type { Prediction } from "$lib/stores/app.svelte.js";

// Fresh in-memory DB for each test
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

function makeActiveSleep(startTime: string, domainId = "slp_test"): SleepLogRow {
  return {
    id: 1,
    baby_id: 1,
    start_time: startTime,
    end_time: null,
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
    ...overrides,
  };
}

describe("reconcileNotifications", () => {
  it("schedules a rescue wake 2 min before recommended wake time", () => {
    const active = makeActiveSleep("2026-04-13T12:00:00.000Z");
    const input: ReconcileInput = {
      baby,
      activeSleep: active,
      prediction: makePrediction({
        rescueNap: {
          recommendedWakeTime: "2026-04-13T12:45:00.000Z",
          reason: "short_prior_nap",
        },
      }),
    };

    reconcileNotifications(input);

    const rows = db
      .prepare("SELECT * FROM notification_schedule")
      .all() as Array<{ fire_at: string; dedupe_key: string; kind: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("rescue_wake");
    expect(rows[0].dedupe_key).toBe(`rescue_wake:${active.domain_id}`);
    expect(new Date(rows[0].fire_at).toISOString()).toBe("2026-04-13T12:43:00.000Z");
  });

  it("is idempotent — running twice gives one row", () => {
    const active = makeActiveSleep("2026-04-13T12:00:00.000Z");
    const input: ReconcileInput = {
      baby,
      activeSleep: active,
      prediction: makePrediction({
        rescueNap: {
          recommendedWakeTime: "2026-04-13T12:45:00.000Z",
          reason: "short_prior_nap",
        },
      }),
    };

    reconcileNotifications(input);
    reconcileNotifications(input);

    const rows = db.prepare("SELECT * FROM notification_schedule").all();
    expect(rows).toHaveLength(1);
  });

  it("updates fire_at when recommendation changes", () => {
    const active = makeActiveSleep("2026-04-13T12:00:00.000Z");
    reconcileNotifications({
      baby,
      activeSleep: active,
      prediction: makePrediction({
        rescueNap: { recommendedWakeTime: "2026-04-13T12:45:00.000Z", reason: "short_prior_nap" },
      }),
    });
    reconcileNotifications({
      baby,
      activeSleep: active,
      prediction: makePrediction({
        rescueNap: { recommendedWakeTime: "2026-04-13T12:50:00.000Z", reason: "short_prior_nap" },
      }),
    });

    const rows = db
      .prepare("SELECT * FROM notification_schedule")
      .all() as Array<{ fire_at: string }>;
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].fire_at).toISOString()).toBe("2026-04-13T12:48:00.000Z");
  });

  it("cancels pending rescue rows when there's no active rescue nap", () => {
    const active = makeActiveSleep("2026-04-13T12:00:00.000Z");
    reconcileNotifications({
      baby,
      activeSleep: active,
      prediction: makePrediction({
        rescueNap: { recommendedWakeTime: "2026-04-13T12:45:00.000Z", reason: "short_prior_nap" },
      }),
    });

    // Sleep ended — no more rescue nap
    reconcileNotifications({
      baby,
      activeSleep: null,
      prediction: makePrediction({ rescueNap: null }),
    });

    const rows = db
      .prepare("SELECT cancelled_at FROM notification_schedule")
      .all() as Array<{ cancelled_at: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].cancelled_at).not.toBeNull();
  });

  it("does not cancel already-sent rows", () => {
    const active = makeActiveSleep("2026-04-13T12:00:00.000Z");
    reconcileNotifications({
      baby,
      activeSleep: active,
      prediction: makePrediction({
        rescueNap: { recommendedWakeTime: "2026-04-13T12:45:00.000Z", reason: "short_prior_nap" },
      }),
    });
    // Mark as sent
    db.prepare("UPDATE notification_schedule SET sent_at = datetime('now')").run();

    // Re-run with no rescue — sent rows shouldn't get cancelled_at, but we check only unsent rows
    reconcileNotifications({ baby, activeSleep: null, prediction: makePrediction({ rescueNap: null }) });

    const rows = db
      .prepare("SELECT sent_at, cancelled_at FROM notification_schedule")
      .all() as Array<{ sent_at: string | null; cancelled_at: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].sent_at).not.toBeNull();
    // The UPDATE predicate only hits unsent rows, so cancelled_at stays null
    expect(rows[0].cancelled_at).toBeNull();
  });

  it("no-op when there's no baby", () => {
    reconcileNotifications({ baby: null, activeSleep: null, prediction: null });
    const rows = db.prepare("SELECT * FROM notification_schedule").all();
    expect(rows).toHaveLength(0);
  });

  it("does not schedule for night sleep", () => {
    const night = { ...makeActiveSleep("2026-04-13T18:00:00.000Z"), type: "night" };
    reconcileNotifications({
      baby,
      activeSleep: night,
      prediction: makePrediction({
        rescueNap: { recommendedWakeTime: "2026-04-13T19:00:00.000Z", reason: "short_prior_nap" },
      }),
    });
    const rows = db.prepare("SELECT * FROM notification_schedule").all();
    expect(rows).toHaveLength(0);
  });
});

describe("fireDueNotifications", () => {
  it("does not fire notifications with future fire_at", async () => {
    db.prepare(
      `INSERT INTO notification_schedule (baby_id, kind, fire_at, dedupe_key, payload_json)
       VALUES (1, 'rescue_wake', '2030-01-01T00:00:00.000Z', 'future', '{"title":"x","body":"y"}')`,
    ).run();

    const now = new Date("2026-04-13T12:00:00.000Z");
    await fireDueNotifications(now);

    const row = db.prepare("SELECT sent_at FROM notification_schedule").get() as {
      sent_at: string | null;
    };
    expect(row.sent_at).toBeNull();
  });

  it("marks due notifications as sent even if no subscriptions", async () => {
    db.prepare(
      `INSERT INTO notification_schedule (baby_id, kind, fire_at, dedupe_key, payload_json)
       VALUES (1, 'rescue_wake', '2026-04-13T11:00:00.000Z', 'past', '{"title":"x","body":"y"}')`,
    ).run();

    const now = new Date("2026-04-13T12:00:00.000Z");
    await fireDueNotifications(now);

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

    const now = new Date("2026-04-13T12:00:00.000Z");
    await fireDueNotifications(now);

    const row = db.prepare("SELECT sent_at FROM notification_schedule").get() as {
      sent_at: string | null;
    };
    expect(row.sent_at).toBeNull();
  });
});
