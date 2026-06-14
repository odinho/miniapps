import { describe, expect, it, beforeEach } from "bun:test";
import { initDb, db } from "$lib/server/db.js";
import {
  reconcileNotifications,
  fireDueNotifications,
  planDueSends,
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
  potty_mode: 0, track_diaper: 0,
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
    feasible: true,
    nextNap: null,
    bedtime: null,
    predictedNaps: null,
    expectedNapCount: 2,
    napsAllDone: false,
    expectedNapEnd: null,
    expectedNightEnd: null,
    expectedWakeRange: null,
    skippedNap: null,
    postSkipPlan: null,
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
    napBudget: null,
    dailyTrendTotalMin: null,
    trendTargets: null,
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

describe("reconcileNotifications – nap_approaching", () => {
  it("schedules 30 min before predicted nextNap when baby is awake", () => {
    reconcileNotifications({
      baby,
      activeSleep: null,
      prediction: makePrediction({
        nextNap: "2026-04-13T11:00:00.000Z",
        napsAllDone: false,
      }),
    });
    const rows = rowsOf("nap_approaching");
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].fire_at).toISOString()).toBe("2026-04-13T10:30:00.000Z");
    const payload = JSON.parse(rows[0].payload_json);
    expect(payload.title).toBe("Snart lurtid");
  });

  it("dedupes by nextNap so re-anchor overwrites, doesn't double-fire", () => {
    // Initial plan
    reconcileNotifications({
      baby, activeSleep: null,
      prediction: makePrediction({ nextNap: "2026-04-13T11:00:00.000Z", napsAllDone: false }),
    });
    // Same prediction reconciled again — should still be 1 row
    reconcileNotifications({
      baby, activeSleep: null,
      prediction: makePrediction({ nextNap: "2026-04-13T11:00:00.000Z", napsAllDone: false }),
    });
    expect(rowsOf("nap_approaching")).toHaveLength(1);
  });

  it("cancels when napsAllDone (day's done)", () => {
    reconcileNotifications({
      baby, activeSleep: null,
      prediction: makePrediction({ nextNap: "2026-04-13T11:00:00.000Z", napsAllDone: false }),
    });
    expect(rowsOf("nap_approaching")).toHaveLength(1);

    reconcileNotifications({
      baby, activeSleep: null,
      prediction: makePrediction({ nextNap: "2026-04-13T11:00:00.000Z", napsAllDone: true }),
    });
    expect(rowsOf("nap_approaching")).toHaveLength(0);
  });

  it("cancels when baby starts napping", () => {
    reconcileNotifications({
      baby, activeSleep: null,
      prediction: makePrediction({ nextNap: "2026-04-13T11:00:00.000Z", napsAllDone: false }),
    });
    expect(rowsOf("nap_approaching")).toHaveLength(1);

    const active = makeActiveSleep("2026-04-13T11:00:00.000Z");
    reconcileNotifications({
      baby, activeSleep: active,
      prediction: makePrediction({ nextNap: "2026-04-13T11:00:00.000Z", napsAllDone: false }),
    });
    expect(rowsOf("nap_approaching")).toHaveLength(0);
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

  // VAPID isn't configured in the test environment, so every push for a
  // real subscription returns `failed`. Use that to exercise the
  // retry/abandon path without mocking webpush.
  function insertFailingSub() {
    db.prepare(
      `INSERT INTO notification_subscriptions (baby_id, endpoint, p256dh, auth)
       VALUES (1, 'https://example.test/x', 'p256dh', 'auth')`,
    ).run();
  }

  it("increments attempts on transient failure but does not mark sent", async () => {
    insertFailingSub();
    db.prepare(
      `INSERT INTO notification_schedule (baby_id, kind, fire_at, dedupe_key, payload_json)
       VALUES (1, 'rescue_wake', ?, 'retry-1', '{"title":"x","body":"y"}')`,
    ).run(new Date(Date.now() - 30_000).toISOString());
    await fireDueNotifications();
    const row = db
      .prepare("SELECT sent_at, cancelled_at, attempts FROM notification_schedule")
      .get() as { sent_at: string | null; cancelled_at: string | null; attempts: number };
    expect(row.sent_at).toBeNull();
    expect(row.cancelled_at).toBeNull();
    expect(row.attempts).toBe(1);
  });

  it("cancels the row after 3 failed attempts", async () => {
    insertFailingSub();
    db.prepare(
      `INSERT INTO notification_schedule (baby_id, kind, fire_at, dedupe_key, payload_json, attempts)
       VALUES (1, 'rescue_wake', ?, 'retry-cap', '{"title":"x","body":"y"}', 2)`,
    ).run(new Date(Date.now() - 30_000).toISOString());
    await fireDueNotifications();
    const row = db
      .prepare("SELECT sent_at, cancelled_at, attempts FROM notification_schedule")
      .get() as { sent_at: string | null; cancelled_at: string | null; attempts: number };
    expect(row.sent_at).toBeNull();
    expect(row.cancelled_at).not.toBeNull();
    expect(row.attempts).toBe(3);
  });

  it("cancels a stale row (fire_at older than 5 min) without waiting for 3 attempts", async () => {
    insertFailingSub();
    const now = new Date();
    const stale = new Date(now.getTime() - 6 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO notification_schedule (baby_id, kind, fire_at, dedupe_key, payload_json)
       VALUES (1, 'rescue_wake', ?, 'retry-stale', '{"title":"x","body":"y"}')`,
    ).run(stale);
    await fireDueNotifications(now);
    const row = db
      .prepare("SELECT sent_at, cancelled_at, attempts FROM notification_schedule")
      .get() as { sent_at: string | null; cancelled_at: string | null; attempts: number };
    expect(row.cancelled_at).not.toBeNull();
    expect(row.attempts).toBe(1);
  });
});

describe("reconcileNotifications – nap_budget_cap", () => {
  const wakeBy = "2026-05-13T09:25:00.000Z";
  const active = makeActiveSleep("2026-05-13T08:30:00.000Z");
  const napBudget = {
    wakeBy,
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

  it("schedules a push 5 min before wakeBy when urgency is firm", () => {
    reconcileNotifications({
      baby,
      activeSleep: active,
      prediction: makePrediction({ napBudget }),
    });
    const rows = rowsOf("nap_budget_cap");
    expect(rows).toHaveLength(1);
    const fireAt = new Date(rows[0].fire_at).getTime();
    const wakeByMs = new Date(wakeBy).getTime();
    expect(wakeByMs - fireAt).toBe(5 * 60_000);
    const payload = JSON.parse(rows[0].payload_json);
    expect(payload.title).toContain("trenden");
  });

  it("does NOT schedule when urgency is advisory (soft signal only)", () => {
    reconcileNotifications({
      baby,
      activeSleep: active,
      prediction: makePrediction({ napBudget: { ...napBudget, urgency: "advisory" } }),
    });
    expect(rowsOf("nap_budget_cap")).toHaveLength(0);
  });

  it("respects opt-out: prefs.nap_budget_cap=false suppresses push", () => {
    setPrefs(baby.id, { nap_budget_cap: false });
    reconcileNotifications({
      baby,
      activeSleep: active,
      prediction: makePrediction({ napBudget }),
    });
    expect(rowsOf("nap_budget_cap")).toHaveLength(0);
  });

  it("cancels when baby wakes (no longer active)", () => {
    reconcileNotifications({
      baby,
      activeSleep: active,
      prediction: makePrediction({ napBudget }),
    });
    expect(rowsOf("nap_budget_cap")).toHaveLength(1);
    reconcileNotifications({
      baby,
      activeSleep: null,
      prediction: makePrediction({ napBudget: null }),
    });
    expect(rowsOf("nap_budget_cap")).toHaveLength(0);
  });

  it("stable dedupe: moving wakeBy across reconciles produces exactly one row + one send", async () => {
    // Past-fire scenario: wakeBy clamped to now+1 keeps moving forward
    // every reconcile. With timestamp in dedupe this spammed the parent.
    // With stable dedupe (domain_id only) we get one row that updates
    // fire_at, and once sent, ON CONFLICT WHERE sent_at IS NULL blocks
    // re-firing.
    const movingBudget1 = { ...napBudget, wakeBy: "2026-05-13T09:30:00.000Z" };
    const movingBudget2 = { ...napBudget, wakeBy: "2026-05-13T09:31:00.000Z" };
    const movingBudget3 = { ...napBudget, wakeBy: "2026-05-13T09:32:00.000Z" };

    reconcileNotifications({
      baby,
      activeSleep: active,
      prediction: makePrediction({ napBudget: movingBudget1 }),
    });
    reconcileNotifications({
      baby,
      activeSleep: active,
      prediction: makePrediction({ napBudget: movingBudget2 }),
    });
    reconcileNotifications({
      baby,
      activeSleep: active,
      prediction: makePrediction({ napBudget: movingBudget3 }),
    });

    // Three reconciles, three different wakeBy values, ONE row.
    expect(rowsOf("nap_budget_cap")).toHaveLength(1);

    // The row's fire_at reflects the latest wakeBy - 5 min.
    const expectedFireAt = new Date(movingBudget3.wakeBy).getTime() - 5 * 60_000;
    expect(new Date(rowsOf("nap_budget_cap")[0].fire_at).getTime()).toBe(expectedFireAt);

    // Fire once (the fire_at is past relative to a far-future "now"), then
    // try to reconcile again with another moving wakeBy. The sent row must
    // not be replaced and no second row must appear.
    await fireDueNotifications(new Date("2026-05-13T10:00:00.000Z"));
    const afterSend = db
      .prepare("SELECT sent_at FROM notification_schedule WHERE kind = 'nap_budget_cap'")
      .all() as Array<{ sent_at: string | null }>;
    expect(afterSend).toHaveLength(1);
    expect(afterSend[0].sent_at).not.toBeNull();

    reconcileNotifications({
      baby,
      activeSleep: active,
      prediction: makePrediction({ napBudget: { ...napBudget, wakeBy: "2026-05-13T09:33:00.000Z" } }),
    });
    const finalRows = db
      .prepare("SELECT * FROM notification_schedule WHERE kind = 'nap_budget_cap'")
      .all() as Array<{ sent_at: string | null }>;
    expect(finalRows).toHaveLength(1);
    expect(finalRows[0].sent_at).not.toBeNull();
  });

  it("napBudget suppresses nap_ending_soon (no double-push for same active nap)", () => {
    // Both nap_budget_cap and nap_ending_soon would have fired for the
    // same active nap with different wake times — the same coupling miss
    // the rescue-vs-napBudget arbitration tried to fix. After: nap_budget_cap
    // is the sole wake recommendation when present.
    reconcileNotifications({
      baby,
      activeSleep: active,
      prediction: makePrediction({
        napBudget,
        expectedNapEnd: "2026-05-13T11:30:00.000Z",
      }),
    });
    expect(rowsOf("nap_budget_cap")).toHaveLength(1);
    expect(rowsOf("nap_ending_soon")).toHaveLength(0);
  });
});

describe("reconcileNotifications – multi-baby", () => {
  it("schedules per-baby with baby-scoped dedupe keys and names each baby in the title", () => {
    db.prepare("INSERT INTO baby (id, name, birthdate) VALUES (2, 'Bo', '2025-06-12')").run();
    const ada = { ...baby, id: 1, name: "Ada" };
    const bo = { ...baby, id: 2, name: "Bo" };
    const pred = makePrediction({ bedtime: "2026-04-13T18:00:00.000Z" });

    reconcileNotifications({ baby: ada, activeSleep: null, prediction: pred });
    reconcileNotifications({ baby: bo, activeSleep: null, prediction: pred });

    const rows = rowsOf("bedtime_approaching");
    expect(rows.map((r) => r.dedupe_key).toSorted()).toEqual([
      "b1:bedtime_approaching:2026-04-13",
      "b2:bedtime_approaching:2026-04-13",
    ]);
    expect(rows.map((r) => JSON.parse(r.payload_json).title).toSorted()).toEqual([
      "Ada: Leggetid snart",
      "Bo: Leggetid snart",
    ]);
  });
});

// Render each planned send group as "<who>:<kind>(<n>)" for a readable assert.
function renderSends(groups: ReturnType<typeof planDueSends>): string[] {
  return groups.map((g) => {
    const p = g.payload as { title: string; data?: { merged?: boolean } };
    const who = p.data?.merged ? "Begge" : `b${g.rows[0].baby_id}`;
    return `${who}:${g.rows[0].kind}(${g.rows.length})`;
  });
}

describe("planDueSends – X-1 family notification de-noising", () => {
  let nid = 0;
  const row = (babyId: number, kind: string, title: string) => ({
    id: ++nid,
    baby_id: babyId,
    kind,
    fire_at: "2026-06-14T13:00:00.000Z",
    dedupe_key: `b${babyId}:${kind}`,
    attempts: 0,
    payload_json: JSON.stringify({ title: `Baby${babyId}: ${title}`, body: "x", tag: `b${babyId}:${kind}` }),
  });
  const render = renderSends;

  it("merges both children's same-kind NON-URGENT notifications into one 'Begge' send", () => {
    const groups = planDueSends([
      row(1, "bedtime_approaching", "Leggetid snart"),
      row(2, "bedtime_approaching", "Leggetid snart"),
    ]);
    expect(render(groups)).toEqual(["Begge:bedtime_approaching(2)"]);
    expect((groups[0].payload as { title: string }).title).toBe("Begge: Leggetid snart");
  });

  it("never merges urgent wake-caps — each child gets its own send", () => {
    expect(
      render(planDueSends([row(1, "nap_budget_cap", "Tidleg vekking"), row(2, "nap_budget_cap", "Tidleg vekking")])),
    ).toEqual(["b1:nap_budget_cap(1)", "b2:nap_budget_cap(1)"]);
    expect(
      render(planDueSends([row(1, "rescue_wake", "Vekk"), row(2, "rescue_wake", "Vekk")])),
    ).toEqual(["b1:rescue_wake(1)", "b2:rescue_wake(1)"]);
  });

  it("a single child's notification is not merged (uses its own payload)", () => {
    const groups = planDueSends([row(1, "bedtime_approaching", "Leggetid snart")]);
    expect(render(groups)).toEqual(["b1:bedtime_approaching(1)"]);
    expect((groups[0].payload as { title: string }).title).toBe("Baby1: Leggetid snart");
  });

  it("mixed batch: merge the shared non-urgent kind, keep urgent + unmatched as singletons", () => {
    const groups = planDueSends([
      row(1, "bedtime_approaching", "Leggetid snart"),
      row(2, "bedtime_approaching", "Leggetid snart"),
      row(1, "nap_budget_cap", "Tidleg vekking"),
      row(1, "nap_ending_soon", "Luren sluttar snart"),
    ]);
    expect(render(groups).toSorted()).toEqual([
      "Begge:bedtime_approaching(2)",
      "b1:nap_budget_cap(1)",
      "b1:nap_ending_soon(1)",
    ].toSorted());
  });
});
