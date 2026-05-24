import { test, expect } from "bun:test";
import {
  post,
  get,
  postEvents,
  db,
  createBaby,
  makeEvent,
  generateSleepId,
  generateDiaperId,
  setupHarness,
} from "./harness.js";
setupHarness();
import { renderCounts, renderDayState } from "../helpers/render-state.js";

test("Rebuild on clean data produces identical row counts", async () => {
  const babyId = createBaby("Testa");
  const did = generateSleepId();

  await postEvents([
    makeEvent("sleep.started", {
      babyId,
      startTime: "2026-03-26T09:00:00Z",
      sleepDomainId: did,
    }),
  ]);
  await postEvents([
    makeEvent("sleep.ended", { sleepDomainId: did, endTime: "2026-03-26T10:30:00Z" }),
  ]);

  const res = await post("/api/admin/rebuild", {});
  expect(res.ok).toBe(true);
  const report = await res.json();
  expect(report.success).toBe(true);
  expect(report.before.sleeps).toBe(report.after.sleeps);
  expect(report.before.diapers).toBe(report.after.diapers);
});

test("Rebuild after manual DB corruption restores data", async () => {
  const babyId = createBaby("Testa");
  const did = generateSleepId();
  const diaperDid = generateDiaperId();

  await postEvents([
    makeEvent("sleep.started", {
      babyId,
      startTime: "2026-03-26T09:00:00Z",
      sleepDomainId: did,
    }),
  ]);
  await postEvents([
    makeEvent("sleep.ended", { sleepDomainId: did, endTime: "2026-03-26T10:30:00Z" }),
  ]);
  await postEvents([
    makeEvent("diaper.logged", {
      babyId,
      time: "2026-03-26T11:00:00Z",
      type: "wet",
      diaperDomainId: diaperDid,
    }),
  ]);

  // Corrupt: delete a projection row
  db.prepare("DELETE FROM sleep_log WHERE domain_id = ?").run(did);
  expect(renderCounts(db)).toMatchInlineSnapshot(
    `"events: 4, sleeps: 0, diapers: 1, nightWakings: 0"`,
  );

  // Rebuild should restore
  const res = await post("/api/admin/rebuild", {});
  const report = await res.json();
  expect(report.success).toBe(true);

  expect(renderDayState(db, babyId)).toMatchInlineSnapshot(`
    "baby: Testa (2025-06-12)
    søvn: 09:00–10:30 lur
    bleier: 11:00 wet"
  `);
});

test("Rebuild report includes correct event count and timing", async () => {
  const babyId = createBaby("Testa");

  await postEvents([
    makeEvent("diaper.logged", {
      babyId,
      time: "2026-03-26T11:00:00Z",
      type: "wet",
      diaperDomainId: generateDiaperId(),
    }),
  ]);

  const res = await post("/api/admin/rebuild", {});
  const report = await res.json();
  expect(report.success).toBe(true);
  // Events: baby.created (from fixture) + diaper.logged
  expect(report.eventsReplayed).toBeGreaterThanOrEqual(2);
  expect(report.durationMs).toBeGreaterThanOrEqual(0);
});

test("After rebuild, all domain_ids are preserved", async () => {
  const babyId = createBaby("Testa");
  const did1 = generateSleepId();
  const did2 = generateDiaperId();

  await postEvents([
    makeEvent("sleep.started", {
      babyId,
      startTime: "2026-03-26T09:00:00Z",
      sleepDomainId: did1,
    }),
  ]);
  await postEvents([
    makeEvent("diaper.logged", {
      babyId,
      time: "2026-03-26T11:00:00Z",
      type: "dirty",
      diaperDomainId: did2,
    }),
  ]);

  await post("/api/admin/rebuild", {});

  expect(renderDayState(db, babyId)).toMatchInlineSnapshot(`
    "baby: Testa (2025-06-12)
    søvn: 09:00–pågår lur
    bleier: 11:00 dirty"
  `);
});

test("After rebuild, GET /api/state returns correct current state", async () => {
  const babyId = createBaby("Testa");
  // Use today's date so diaperCount (which only counts today) includes our entry
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const todayDate = `${yyyy}-${mm}-${dd}`;
  const todayDiaper = `${todayDate}T11:00:00Z`;
  const did = generateDiaperId();

  await postEvents([
    makeEvent("diaper.logged", {
      babyId,
      time: todayDiaper,
      type: "wet",
      diaperDomainId: did,
    }),
  ]);

  await post("/api/admin/rebuild", {});

  const rendered = renderDayState(db, babyId);
  expect(rendered).toContain("11:00 wet");

  const stateRes = await get("/api/state");
  const state = await stateRes.json();
  expect(state.baby).toBeDefined();
  expect(state.diaperCount).toBeGreaterThanOrEqual(1);
});

test("Rebuild succeeds when day_start has rows (FK ordering)", async () => {
  // Regression: rebuildAll didn't DELETE FROM day_start before
  // DELETE FROM baby. With PRAGMA foreign_keys=ON the baby delete
  // failed and rebuild aborted. After fix: rebuild succeeds.
  const babyId = createBaby("Testa");
  await postEvents([
    makeEvent("day.started", { babyId, wakeTime: "2026-03-26T06:30:00Z" }),
    makeEvent("day.marked_off", { babyId, date: "2026-03-26", reason: null }),
  ]);
  const res = await post("/api/admin/rebuild", {});
  const report = await res.json();
  expect(report.success).toBe(true);
  // The off-day flag survived the rebuild (day.marked_off replayed
  // after day.started; ON CONFLICT preserves wake_time, off_day=1).
  const row = db
    .prepare("SELECT off_day, wake_time FROM day_start WHERE baby_id = ? AND date = ?")
    .get(babyId, "2026-03-26") as { off_day: number; wake_time: string };
  expect(row.off_day).toBe(1);
  expect(row.wake_time).toBe("2026-03-26T06:30:00Z");
});

test("day.started after day.marked_off preserves the off-day flag", async () => {
  // The original INSERT OR REPLACE would have wiped off_day back to 0.
  // After fix (ON CONFLICT DO UPDATE): off_day stays at 1.
  const babyId = createBaby("Testa");
  await postEvents([
    makeEvent("day.marked_off", { babyId, date: "2026-03-26", reason: "sick" }),
  ]);
  // Parent still ends up logging the morning wake later. day.started
  // must not silently un-flag the day.
  await postEvents([
    makeEvent("day.started", { babyId, wakeTime: "2026-03-26T07:00:00Z" }),
  ]);
  const row = db
    .prepare("SELECT off_day, off_day_reason, wake_time FROM day_start WHERE baby_id = ? AND date = ?")
    .get(babyId, "2026-03-26") as { off_day: number; off_day_reason: string | null; wake_time: string };
  expect(row.off_day).toBe(1);
  expect(row.off_day_reason).toBe("sick");
  expect(row.wake_time).toBe("2026-03-26T07:00:00Z");
});

test("day.unmarked_off without prior day.started cleans up the placeholder row", async () => {
  // mark off → unmark → row should be gone (no fake wake_time lingering).
  const babyId = createBaby("Testa");
  await postEvents([
    makeEvent("day.marked_off", { babyId, date: "2026-03-26", reason: null }),
  ]);
  let row: { wake_time: string } | undefined | null = db
    .prepare("SELECT wake_time FROM day_start WHERE baby_id = ? AND date = ?")
    .get(babyId, "2026-03-26") as { wake_time: string } | undefined | null;
  expect(row?.wake_time).toBe("2026-03-26T00:00:00.000Z"); // placeholder
  await postEvents([
    makeEvent("day.unmarked_off", { babyId, date: "2026-03-26" }),
  ]);
  row = db
    .prepare("SELECT wake_time FROM day_start WHERE baby_id = ? AND date = ?")
    .get(babyId, "2026-03-26") as { wake_time: string } | undefined | null;
  expect(row ?? null).toBeNull();
});
