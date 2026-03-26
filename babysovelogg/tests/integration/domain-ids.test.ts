import { test, expect, beforeEach } from "vitest";
import {
  post,
  postEvents,
  resetDb,
  createBaby,
  setWakeUpTime,
  getDb,
  makeEvent,
  generateSleepId,
  generateDiaperId,
} from "./harness.js";
import { renderDayState } from "../helpers/render-state.js";

beforeEach(() => resetDb());

test("sleep.started with sleepDomainId creates row with domain_id set", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const did = generateSleepId();

  const res = await postEvents([
    makeEvent("sleep.started", { babyId, startTime: "2026-03-26T09:00:00Z", sleepDomainId: did }),
  ]);
  expect(res.ok).toBe(true);

  const db = getDb();
  const sleep = db.prepare("SELECT domain_id FROM sleep_log WHERE domain_id = ?").get(did) as
    | { domain_id: string }
    | undefined;
  db.close();
  expect(sleep).toBeDefined();
  expect(sleep!.domain_id).toBe(did);
});

test("sleep.ended with sleepDomainId updates the correct row", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const did = generateSleepId();

  await postEvents([
    makeEvent("sleep.started", { babyId, startTime: "2026-03-26T09:00:00Z", sleepDomainId: did }),
  ]);

  const endTime = "2026-03-26T10:30:00Z";
  const res = await postEvents([makeEvent("sleep.ended", { sleepDomainId: did, endTime })]);
  expect(res.ok).toBe(true);

  const db = getDb();
  const sleep = db.prepare("SELECT end_time FROM sleep_log WHERE domain_id = ?").get(did) as {
    end_time: string;
  };
  db.close();
  expect(sleep.end_time).toBe(endTime);
});

test("sleep.tagged with sleepDomainId updates the correct row", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const did = generateSleepId();

  await postEvents([
    makeEvent("sleep.started", { babyId, startTime: "2026-03-26T09:00:00Z", sleepDomainId: did }),
  ]);

  const res = await postEvents([
    makeEvent("sleep.tagged", { sleepDomainId: did, mood: "happy", method: "nursing" }),
  ]);
  expect(res.ok).toBe(true);

  const db = getDb();
  expect(renderDayState(db, babyId)).toContain("happy");
  expect(renderDayState(db, babyId)).toContain("nursing");
  db.close();
});

test("sleep.paused / sleep.resumed with sleepDomainId works", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const did = generateSleepId();

  await postEvents([
    makeEvent("sleep.started", { babyId, startTime: "2026-03-26T09:00:00Z", sleepDomainId: did }),
  ]);

  const pauseTime = "2026-03-26T09:30:00Z";
  await postEvents([makeEvent("sleep.paused", { sleepDomainId: did, pauseTime })]);

  const resumeTime = "2026-03-26T09:35:00Z";
  const res = await postEvents([
    makeEvent("sleep.resumed", { sleepDomainId: did, resumeTime }),
  ]);
  expect(res.ok).toBe(true);

  const db = getDb();
  const pauses = db
    .prepare(
      "SELECT sp.* FROM sleep_pauses sp JOIN sleep_log sl ON sp.sleep_id = sl.id WHERE sl.domain_id = ?",
    )
    .all(did) as { pause_time: string; resume_time: string }[];
  db.close();
  expect(pauses.length).toBe(1);
  expect(pauses[0].pause_time).toBe(pauseTime);
  expect(pauses[0].resume_time).toBe(resumeTime);
});

test("diaper.logged with diaperDomainId creates row with domain_id", async () => {
  const babyId = createBaby("Testa");
  const did = generateDiaperId();

  const res = await postEvents([
    makeEvent("diaper.logged", {
      babyId,
      time: "2026-03-26T11:00:00Z",
      type: "wet",
      diaperDomainId: did,
    }),
  ]);
  expect(res.ok).toBe(true);

  const db = getDb();
  const diaper = db.prepare("SELECT domain_id FROM diaper_log WHERE domain_id = ?").get(did) as {
    domain_id: string;
  };
  db.close();
  expect(diaper.domain_id).toBe(did);
});

test("diaper.deleted with diaperDomainId soft-deletes the correct row", async () => {
  const babyId = createBaby("Testa");
  const did = generateDiaperId();

  await postEvents([
    makeEvent("diaper.logged", {
      babyId,
      time: "2026-03-26T11:00:00Z",
      type: "wet",
      diaperDomainId: did,
    }),
  ]);
  const res = await postEvents([makeEvent("diaper.deleted", { diaperDomainId: did })]);
  expect(res.ok).toBe(true);

  const db = getDb();
  const diaper = db.prepare("SELECT deleted FROM diaper_log WHERE domain_id = ?").get(did) as {
    deleted: number;
  };
  db.close();
  expect(diaper.deleted).toBe(1);
});

test("Events without sleepDomainId are rejected by validation", async () => {
  const babyId = createBaby("Testa");

  const res = await postEvents([
    makeEvent("sleep.started", { babyId, startTime: new Date().toISOString() }),
  ]);
  expect(res.status).toBe(400);
});

test("rebuildAll produces correct projection state", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const did1 = generateSleepId();
  const did2 = generateDiaperId();

  await postEvents([
    makeEvent("sleep.started", {
      babyId,
      startTime: new Date(Date.now() - 3600000).toISOString(),
      sleepDomainId: did1,
    }),
  ]);
  await postEvents([
    makeEvent("sleep.ended", {
      sleepDomainId: did1,
      endTime: new Date(Date.now() - 1800000).toISOString(),
    }),
  ]);
  await postEvents([
    makeEvent("diaper.logged", {
      babyId,
      time: new Date().toISOString(),
      type: "wet",
      diaperDomainId: did2,
    }),
  ]);

  const rebuildRes = await post("/api/admin/rebuild", {});
  expect(rebuildRes.ok).toBe(true);
  const report = await rebuildRes.json();
  expect(report.success).toBe(true);

  // Verify domain IDs are preserved
  const db = getDb();
  const sleep = db.prepare("SELECT domain_id FROM sleep_log WHERE domain_id = ?").get(did1);
  const diaper = db.prepare("SELECT domain_id FROM diaper_log WHERE domain_id = ?").get(did2);
  db.close();
  expect(sleep).toBeDefined();
  expect(diaper).toBeDefined();
});
