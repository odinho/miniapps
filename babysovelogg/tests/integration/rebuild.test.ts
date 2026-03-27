import { test, expect } from "vitest";
import {
  post,
  get,
  postEvents,
  db,
  createBaby,
  setWakeUpTimeUTC,
  makeEvent,
  generateSleepId,
  generateDiaperId,
} from "./harness.js";
import { renderCounts, renderDayState } from "../helpers/render-state.js";

test("Rebuild on clean data produces identical row counts", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTimeUTC(babyId, "2026-03-26", "2026-03-26T07:00:00Z");
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
  setWakeUpTimeUTC(babyId, "2026-03-26", "2026-03-26T07:00:00Z");
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
    `"events: 4, sleeps: 0, diapers: 1, pauses: 0, dayStarts: 1"`,
  );

  // Rebuild should restore
  const res = await post("/api/admin/rebuild", {});
  const report = await res.json();
  expect(report.success).toBe(true);

  // day_start was inserted directly (not via events), so rebuild drops it
  expect(renderDayState(db, babyId)).toMatchInlineSnapshot(`
    "baby: Testa (2025-06-12)
    søvn: 09:00–10:30 lur
    bleier: 11:00 wet"
  `);
});

test("Rebuild report includes correct event count and timing", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTimeUTC(babyId, "2026-03-26", "2026-03-26T07:00:00Z");

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
  setWakeUpTimeUTC(babyId, "2026-03-26", "2026-03-26T07:00:00Z");
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

  // day_start was inserted directly (not via events), so rebuild drops it
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
  const todayWake = `${todayDate}T07:00:00Z`;
  const todayDiaper = `${todayDate}T11:00:00Z`;
  setWakeUpTimeUTC(babyId, todayDate, todayWake);
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

  // day_start was inserted directly (not via events), so rebuild drops it
  const rendered = renderDayState(db, babyId);
  expect(rendered).toContain("11:00 wet");

  const stateRes = await get("/api/state");
  const state = await stateRes.json();
  expect(state.baby).toBeDefined();
  expect(state.diaperCount).toBeGreaterThanOrEqual(1);
});
