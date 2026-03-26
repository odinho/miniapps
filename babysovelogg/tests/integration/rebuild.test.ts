import { test, expect, beforeEach } from "vitest";
import {
  post,
  get,
  postEvents,
  resetDb,
  createBaby,
  setWakeUpTime,
  getDb,
  makeEvent,
  generateSleepId,
  generateDiaperId,
} from "./harness.js";
import { renderCounts } from "../helpers/render-state.js";

beforeEach(() => resetDb());

test("Rebuild on clean data produces identical row counts", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const did = generateSleepId();

  await postEvents([
    makeEvent("sleep.started", {
      babyId,
      startTime: new Date(Date.now() - 3600000).toISOString(),
      sleepDomainId: did,
    }),
  ]);
  await postEvents([
    makeEvent("sleep.ended", { sleepDomainId: did, endTime: new Date().toISOString() }),
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
  setWakeUpTime(babyId);
  const did = generateSleepId();
  const diaperDid = generateDiaperId();

  await postEvents([
    makeEvent("sleep.started", {
      babyId,
      startTime: new Date(Date.now() - 3600000).toISOString(),
      sleepDomainId: did,
    }),
  ]);
  await postEvents([
    makeEvent("sleep.ended", { sleepDomainId: did, endTime: new Date().toISOString() }),
  ]);
  await postEvents([
    makeEvent("diaper.logged", {
      babyId,
      time: new Date().toISOString(),
      type: "wet",
      diaperDomainId: diaperDid,
    }),
  ]);

  // Corrupt: delete a projection row
  const db = getDb();
  db.prepare("DELETE FROM sleep_log WHERE domain_id = ?").run(did);
  expect(renderCounts(db)).toContain("sleeps: 0");
  db.close();

  // Rebuild should restore
  const res = await post("/api/admin/rebuild", {});
  const report = await res.json();
  expect(report.success).toBe(true);
  expect(report.after.sleeps).toBe(1);
});

test("Rebuild report includes correct event count and timing", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  await postEvents([
    makeEvent("diaper.logged", {
      babyId,
      time: new Date().toISOString(),
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
    makeEvent("sleep.started", { babyId, startTime: new Date().toISOString(), sleepDomainId: did1 }),
  ]);
  await postEvents([
    makeEvent("diaper.logged", {
      babyId,
      time: new Date().toISOString(),
      type: "dirty",
      diaperDomainId: did2,
    }),
  ]);

  await post("/api/admin/rebuild", {});

  const db = getDb();
  const sleep = db.prepare("SELECT domain_id FROM sleep_log WHERE domain_id = ?").get(did1);
  const diaper = db.prepare("SELECT domain_id FROM diaper_log WHERE domain_id = ?").get(did2);
  db.close();
  expect(sleep).toBeDefined();
  expect(diaper).toBeDefined();
});

test("After rebuild, GET /api/state returns correct current state", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const did = generateDiaperId();

  await postEvents([
    makeEvent("diaper.logged", {
      babyId,
      time: new Date().toISOString(),
      type: "wet",
      diaperDomainId: did,
    }),
  ]);

  await post("/api/admin/rebuild", {});

  const stateRes = await get("/api/state");
  const state = await stateRes.json();
  expect(state.baby).toBeDefined();
  expect(state.diaperCount).toBeGreaterThanOrEqual(1);
});
