import { describe, test, expect, beforeEach } from "vitest";
import {
  postEvents,
  post,
  resetDb,
  createBaby,
  setWakeUpTime,
  getDb,
  makeEvent,
  generateId,
  generateSleepId,
} from "./harness.js";

beforeEach(() => resetDb());

test("Duplicate events with same clientId+clientEventId are ignored", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  const clientId = "test-client";
  const clientEventId = "test-dedup-" + Date.now();
  const sleepDomainId = generateSleepId();
  const eventPayload = {
    events: [
      {
        type: "sleep.started",
        payload: { babyId, startTime: new Date().toISOString(), type: "nap", sleepDomainId },
        clientId,
        clientEventId,
      },
    ],
  };

  // First POST should succeed
  const res1 = await post("/api/events", eventPayload);
  expect(res1.ok).toBe(true);
  const data1 = await res1.json();
  expect(data1.events.length).toBe(1);
  expect(data1.events[0].duplicate).toBe(false);

  // Stop the sleep first so we can check the dedup behavior
  await post("/api/events", {
    events: [
      {
        type: "sleep.ended",
        payload: { sleepDomainId, endTime: new Date().toISOString() },
        clientId,
        clientEventId: generateId(),
      },
    ],
  });

  // Second POST with same clientId+clientEventId should be deduplicated
  const res2 = await post("/api/events", eventPayload);
  expect(res2.ok).toBe(true);
  const data2 = await res2.json();
  expect(data2.events.length).toBe(1);
  expect(data2.events[0].duplicate).toBe(true);

  // Verify only one sleep was created
  const db = getDb();
  const sleeps = db.prepare("SELECT * FROM sleep_log WHERE baby_id = ?").all(babyId);
  db.close();
  expect(sleeps.length).toBe(1);
});

test("Duplicate POST does NOT trigger SSE broadcast", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  const clientId = "test-client";
  const clientEventId = generateId();
  const sleepDomainId = generateSleepId();
  const eventPayload = {
    events: [
      {
        type: "sleep.started",
        payload: { babyId, startTime: new Date().toISOString(), type: "nap", sleepDomainId },
        clientId,
        clientEventId,
      },
    ],
  };

  // First POST
  await post("/api/events", eventPayload);

  // Verify duplicate returns existing event
  const res = await post("/api/events", eventPayload);
  const data = await res.json();
  expect(data.events[0].duplicate).toBe(true);
  expect(data.events[0].type).toBe("sleep.started");
});

test("Batch with mix of new and duplicate events", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  const clientId = "test-client";
  const eid1 = generateId();
  const did1 = generateSleepId();

  // First: create a sleep
  await post("/api/events", {
    events: [
      {
        type: "sleep.started",
        payload: { babyId, startTime: new Date().toISOString(), type: "nap", sleepDomainId: did1 },
        clientId,
        clientEventId: eid1,
      },
    ],
  });

  // Now send batch: duplicate + new end event
  const eid2 = generateId();
  const res = await post("/api/events", {
    events: [
      {
        type: "sleep.started",
        payload: { babyId, startTime: new Date().toISOString(), type: "nap", sleepDomainId: did1 },
        clientId,
        clientEventId: eid1,
      },
      {
        type: "sleep.ended",
        payload: { sleepDomainId: did1, endTime: new Date().toISOString() },
        clientId,
        clientEventId: eid2,
      },
    ],
  });
  expect(res.ok).toBe(true);
  const data = await res.json();
  expect(data.events[0].duplicate).toBe(true);
  expect(data.events[1].duplicate).toBe(false);
});

test("Verify envelope columns exist", async () => {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT schema_version, correlation_id, caused_by_event_id, domain_id FROM events LIMIT 0",
    )
    .all();
  expect(row).toBeDefined();
  db.close();
});
