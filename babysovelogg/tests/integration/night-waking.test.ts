import { test, expect } from "bun:test";
import {
  postEvents,
  createBaby,
  makeEvent,
  generateSleepId,
  generateNightWakingId,
  db,
  setupHarness,
} from "./harness.js";
setupHarness();

test("night_waking.started inserts a row", async () => {
  const babyId = createBaby("Testa");
  const sleepId = generateSleepId();
  const wakingId = generateNightWakingId();

  await postEvents([
    makeEvent("sleep.started", {
      babyId,
      startTime: "2026-03-26T20:00:00.000Z",
      type: "night",
      sleepDomainId: sleepId,
    }),
    makeEvent("night_waking.started", {
      babyId,
      startTime: "2026-03-27T03:15:00.000Z",
      wakingDomainId: wakingId,
    }),
  ]);

  const row = db
    .prepare("SELECT * FROM night_waking WHERE domain_id = ?")
    .get(wakingId) as { start_time: string; end_time: string | null; deleted: number };
  expect(row).toBeDefined();
  expect(row.start_time).toBe("2026-03-27T03:15:00.000Z");
  expect(row.end_time).toBeNull();
  expect(row.deleted).toBe(0);
});

test("night_waking.ended sets end_time", async () => {
  const babyId = createBaby("Testa");
  const wakingId = generateNightWakingId();

  await postEvents([
    makeEvent("night_waking.started", {
      babyId,
      startTime: "2026-03-27T03:15:00.000Z",
      wakingDomainId: wakingId,
    }),
    makeEvent("night_waking.ended", {
      wakingDomainId: wakingId,
      endTime: "2026-03-27T03:32:00.000Z",
    }),
  ]);

  const row = db
    .prepare("SELECT * FROM night_waking WHERE domain_id = ?")
    .get(wakingId) as { end_time: string | null };
  expect(row.end_time).toBe("2026-03-27T03:32:00.000Z");
});

test("night_waking.edited applies partial updates", async () => {
  const babyId = createBaby("Testa");
  const wakingId = generateNightWakingId();

  await postEvents([
    makeEvent("night_waking.started", {
      babyId,
      startTime: "2026-03-27T03:15:00.000Z",
      wakingDomainId: wakingId,
    }),
    makeEvent("night_waking.ended", {
      wakingDomainId: wakingId,
      endTime: "2026-03-27T03:32:00.000Z",
    }),
    makeEvent("night_waking.edited", {
      wakingDomainId: wakingId,
      notes: "snufsete",
      mood: "fussy",
    }),
  ]);

  const row = db
    .prepare("SELECT * FROM night_waking WHERE domain_id = ?")
    .get(wakingId) as { notes: string | null; mood: string | null; start_time: string };
  expect(row.notes).toBe("snufsete");
  expect(row.mood).toBe("fussy");
  expect(row.start_time).toBe("2026-03-27T03:15:00.000Z");
});

test("night_waking.deleted is soft-delete (deleted=1, row preserved)", async () => {
  const babyId = createBaby("Testa");
  const wakingId = generateNightWakingId();

  await postEvents([
    makeEvent("night_waking.started", {
      babyId,
      startTime: "2026-03-27T03:15:00.000Z",
      wakingDomainId: wakingId,
    }),
    makeEvent("night_waking.deleted", { wakingDomainId: wakingId }),
  ]);

  const row = db
    .prepare("SELECT deleted FROM night_waking WHERE domain_id = ?")
    .get(wakingId) as { deleted: number };
  expect(row.deleted).toBe(1);
});

test("getState returns todayNightWakings", async () => {
  const babyId = createBaby("Testa");
  const sleepId = generateSleepId();
  const wakingId = generateNightWakingId();

  // Active night sleep from yesterday evening; one completed waking inside it
  await postEvents([
    makeEvent("sleep.started", {
      babyId,
      startTime: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
      type: "night",
      sleepDomainId: sleepId,
    }),
    makeEvent("night_waking.started", {
      babyId,
      startTime: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      wakingDomainId: wakingId,
    }),
    makeEvent("night_waking.ended", {
      wakingDomainId: wakingId,
      endTime: new Date(Date.now() - 3.5 * 60 * 60 * 1000).toISOString(),
    }),
  ]);

  const { getState } = await import("$lib/server/state.js");
  const state = getState();
  expect(state.todayNightWakings).toBeDefined();
  expect(state.todayNightWakings).toHaveLength(1);
  expect(state.todayNightWakings![0].domain_id).toBe(wakingId);
  expect(state.todayNightWakings![0].end_time).not.toBeNull();
});

test("migration converts night sleep_pauses → night_waking and closes nap trailing pauses", async () => {
  const babyId = createBaby("Testa");
  const napId = generateSleepId();
  const nightId = generateSleepId();

  // Seed sleep_log directly (skip the events table) so we exercise the
  // migration without leaning on event replay.
  db.prepare(
    "INSERT INTO sleep_log (baby_id, start_time, type, domain_id) VALUES (?, ?, 'nap', ?)",
  ).run(babyId, "2026-03-27T13:00:00.000Z", napId);
  const napInternalId = (
    db.prepare("SELECT id FROM sleep_log WHERE domain_id = ?").get(napId) as { id: number }
  ).id;
  db.prepare(
    "INSERT INTO sleep_log (baby_id, start_time, end_time, type, domain_id) VALUES (?, ?, ?, 'night', ?)",
  ).run(babyId, "2026-03-26T20:00:00.000Z", "2026-03-27T06:30:00.000Z", nightId);
  const nightInternalId = (
    db.prepare("SELECT id FROM sleep_log WHERE domain_id = ?").get(nightId) as { id: number }
  ).id;

  // Two pauses on the night (one closed, one closed) and one open trailing
  // pause on the nap (the tentative-end pattern).
  db.prepare(
    "INSERT INTO sleep_pauses (sleep_id, pause_time, resume_time) VALUES (?, ?, ?)",
  ).run(nightInternalId, "2026-03-27T03:00:00.000Z", "2026-03-27T03:15:00.000Z");
  db.prepare(
    "INSERT INTO sleep_pauses (sleep_id, pause_time, resume_time) VALUES (?, ?, ?)",
  ).run(nightInternalId, "2026-03-27T04:30:00.000Z", "2026-03-27T04:45:00.000Z");
  db.prepare(
    "INSERT INTO sleep_pauses (sleep_id, pause_time, resume_time) VALUES (?, ?, ?)",
  ).run(napInternalId, "2026-03-27T13:42:00.000Z", null);

  const { migrateSleepPausesToNightWaking } = await import("$lib/server/db.js");
  migrateSleepPausesToNightWaking(db);

  // Night pauses are now first-class night_wakings.
  const wakings = db
    .prepare("SELECT * FROM night_waking WHERE baby_id = ? ORDER BY start_time ASC")
    .all(babyId) as Array<{
    start_time: string;
    end_time: string | null;
    domain_id: string;
  }>;
  expect(wakings).toHaveLength(2);
  expect(wakings[0].start_time).toBe("2026-03-27T03:00:00.000Z");
  expect(wakings[0].end_time).toBe("2026-03-27T03:15:00.000Z");
  expect(wakings[0].domain_id).toMatch(/^nwk_pse\d+$/);

  // The nap's open trailing pause closed the nap at the pause time.
  const nap = db.prepare("SELECT end_time FROM sleep_log WHERE domain_id = ?").get(napId) as {
    end_time: string | null;
  };
  expect(nap.end_time).toBe("2026-03-27T13:42:00.000Z");

  // Idempotent: re-running the migration is a no-op.
  migrateSleepPausesToNightWaking(db);
  const wakings2 = db
    .prepare("SELECT COUNT(*) as c FROM night_waking WHERE baby_id = ?")
    .get(babyId) as { c: number };
  expect(wakings2.c).toBe(2);
});

test("rebuild replays night_waking events deterministically", async () => {
  const babyId = createBaby("Testa");
  const wakingId = generateNightWakingId();

  await postEvents([
    makeEvent("night_waking.started", {
      babyId,
      startTime: "2026-03-27T03:15:00.000Z",
      wakingDomainId: wakingId,
    }),
    makeEvent("night_waking.ended", {
      wakingDomainId: wakingId,
      endTime: "2026-03-27T03:32:00.000Z",
    }),
    makeEvent("night_waking.edited", {
      wakingDomainId: wakingId,
      notes: "snufsete",
    }),
  ]);

  const before = db.prepare("SELECT * FROM night_waking WHERE domain_id = ?").get(wakingId);

  const { rebuildAll } = await import("$lib/server/projections.js");
  const report = rebuildAll();
  expect(report.success).toBe(true);

  const after = db.prepare("SELECT * FROM night_waking WHERE domain_id = ?").get(wakingId);
  expect(after).toEqual(before);
});
