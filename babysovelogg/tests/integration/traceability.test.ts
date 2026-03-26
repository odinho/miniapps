import { test, expect } from "vitest";
import {
  post,
  get,
  postEvents,
  db,
  createBaby,
  setWakeUpTime,
  makeEvent,
  generateSleepId,
  generateDiaperId,
} from "./harness.js";

test("After sleep.started, sleep_log row has created_by_event_id", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const did = generateSleepId();

  const res = await postEvents([
    makeEvent("sleep.started", { babyId, startTime: new Date().toISOString(), sleepDomainId: did }),
  ]);
  const data = await res.json();
  const eventId = data.events[0].id;

  const sleep = db
    .prepare("SELECT created_by_event_id FROM sleep_log WHERE domain_id = ?")
    .get(did) as { created_by_event_id: number };
  expect(sleep.created_by_event_id).toBe(eventId);
});

test("After sleep.tagged, sleep_log row has updated_by_event_id", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const did = generateSleepId();

  await postEvents([
    makeEvent("sleep.started", { babyId, startTime: new Date().toISOString(), sleepDomainId: did }),
  ]);

  const tagRes = await postEvents([
    makeEvent("sleep.tagged", { sleepDomainId: did, mood: "happy" }),
  ]);
  const tagData = await tagRes.json();
  const tagEventId = tagData.events[0].id;

  const sleep = db
    .prepare("SELECT updated_by_event_id FROM sleep_log WHERE domain_id = ?")
    .get(did) as { updated_by_event_id: number };
  expect(sleep.updated_by_event_id).toBe(tagEventId);
});

test("After diaper.logged, diaper_log row has created_by_event_id", async () => {
  const babyId = createBaby("Testa");
  const did = generateDiaperId();

  const res = await postEvents([
    makeEvent("diaper.logged", {
      babyId,
      time: new Date().toISOString(),
      type: "wet",
      diaperDomainId: did,
    }),
  ]);
  const data = await res.json();
  const eventId = data.events[0].id;

  const diaper = db
    .prepare("SELECT created_by_event_id FROM diaper_log WHERE domain_id = ?")
    .get(did) as { created_by_event_id: number };
  expect(diaper.created_by_event_id).toBe(eventId);
});

test("After rebuild, traceability columns are correct", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const did = generateSleepId();

  const createRes = await postEvents([
    makeEvent("sleep.started", { babyId, startTime: new Date().toISOString(), sleepDomainId: did }),
  ]);
  const createData = await createRes.json();
  const createEventId = createData.events[0].id;

  const tagRes = await postEvents([
    makeEvent("sleep.tagged", { sleepDomainId: did, mood: "calm" }),
  ]);
  const tagData = await tagRes.json();
  const tagEventId = tagData.events[0].id;

  // Rebuild
  await post("/api/admin/rebuild", {});

  const sleep = db
    .prepare("SELECT created_by_event_id, updated_by_event_id FROM sleep_log WHERE domain_id = ?")
    .get(did) as {
    created_by_event_id: number;
    updated_by_event_id: number;
  };
  expect(sleep.created_by_event_id).toBe(createEventId);
  expect(sleep.updated_by_event_id).toBe(tagEventId);
});

test("GET /api/sleeps returns rows with traceability fields", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const did = generateSleepId();

  await postEvents([
    makeEvent("sleep.started", { babyId, startTime: new Date().toISOString(), sleepDomainId: did }),
  ]);

  const res = await get("/api/sleeps");
  const sleeps = await res.json();
  expect(sleeps.length).toBeGreaterThanOrEqual(1);
  const sleep = sleeps.find((s: Record<string, unknown>) => s.domain_id === did);
  expect(sleep).toBeDefined();
  expect(sleep.created_by_event_id).toBeDefined();
});
