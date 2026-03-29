import { test, expect } from "bun:test";
import {
  post,
  db,
  createBaby,
  setWakeUpTime,
  generateId,
  generateSleepId,
  generateDiaperId,
  setupHarness,
} from "./harness.js";
setupHarness();

// --- Envelope validation ---

test("POST with missing type field returns 400", async () => {
  const res = await post("/api/events", {
    events: [{ payload: { name: "test" }, clientId: "c", clientEventId: generateId() }],
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.errors).toBeDefined();
});

test("POST with missing clientId returns 400", async () => {
  const res = await post("/api/events", {
    events: [{ type: "baby.created", payload: { name: "test" }, clientEventId: generateId() }],
  });
  expect(res.status).toBe(400);
});

test("POST with missing clientEventId returns 400", async () => {
  const res = await post("/api/events", {
    events: [{ type: "baby.created", payload: { name: "test" }, clientId: "c" }],
  });
  expect(res.status).toBe(400);
});

test("POST with payload as string instead of object returns 400", async () => {
  const res = await post("/api/events", {
    events: [
      { type: "baby.created", payload: "not-object", clientId: "c", clientEventId: generateId() },
    ],
  });
  expect(res.status).toBe(400);
});

test("POST with body missing events array returns 400", async () => {
  const res = await post("/api/events", { notEvents: [] });
  expect(res.status).toBe(400);
});

// --- Payload validation ---

test("POST with unknown event type returns 400 with error naming the type", async () => {
  const res = await post("/api/events", {
    events: [
      {
        type: "unicorn.sparkle",
        payload: {},
        clientId: "c",
        clientEventId: generateId(),
      },
    ],
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.errors[0]).toContain("unicorn.sparkle");
});

test("POST with missing required field returns 400", async () => {
  const res = await post("/api/events", {
    events: [
      {
        type: "sleep.started",
        payload: { startTime: new Date().toISOString(), sleepDomainId: generateSleepId() },
        clientId: "c",
        clientEventId: generateId(),
      },
    ],
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.errors[0]).toContain("sleep.started");
});

test("POST with wrong field type returns 400", async () => {
  const res = await post("/api/events", {
    events: [
      {
        type: "sleep.started",
        payload: {
          babyId: "abc",
          startTime: new Date().toISOString(),
          sleepDomainId: generateSleepId(),
        },
        clientId: "c",
        clientEventId: generateId(),
      },
    ],
  });
  expect(res.status).toBe(400);
});

test("POST with valid event returns 200", async () => {
  createBaby("Testa");

  const res = await post("/api/events", {
    events: [
      {
        type: "baby.created",
        payload: { name: "Testa2", birthdate: "2025-01-01" },
        clientId: "c",
        clientEventId: generateId(),
      },
    ],
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.events.length).toBe(1);
  expect(body.state).toBeDefined();
});

// --- Batch / transaction ---

test("POST batch where one event is invalid returns 400, nothing written", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  const eventCountBefore = (db.prepare("SELECT COUNT(*) as c FROM events").get() as { c: number })
    .c;

  const res = await post("/api/events", {
    events: [
      {
        type: "sleep.started",
        payload: {
          babyId,
          startTime: new Date().toISOString(),
          sleepDomainId: generateSleepId(),
        },
        clientId: "c",
        clientEventId: generateId(),
      },
      {
        type: "sleep.started",
        payload: { babyId: "wrong-type" },
        clientId: "c",
        clientEventId: generateId(),
      },
    ],
  });
  expect(res.status).toBe(400);

  const eventCountAfter = (db.prepare("SELECT COUNT(*) as c FROM events").get() as { c: number })
    .c;
  expect(eventCountAfter).toBe(eventCountBefore);
});

test("POST batch where projection fails midway returns 500, nothing written", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  const eventCountBefore = (db.prepare("SELECT COUNT(*) as c FROM events").get() as { c: number })
    .c;

  // sleep.ended with nonexistent domain_id will throw during projection
  const res = await post("/api/events", {
    events: [
      {
        type: "sleep.started",
        payload: {
          babyId,
          startTime: new Date().toISOString(),
          sleepDomainId: generateSleepId(),
        },
        clientId: "c",
        clientEventId: generateId(),
      },
      {
        type: "sleep.ended",
        payload: { sleepDomainId: generateSleepId(), endTime: new Date().toISOString() },
        clientId: "c",
        clientEventId: generateId(),
      },
    ],
  });
  expect(res.status).toBe(500);

  const eventCountAfter = (db.prepare("SELECT COUNT(*) as c FROM events").get() as { c: number })
    .c;
  expect(eventCountAfter).toBe(eventCountBefore);
});

test("POST batch of 3 valid events returns all 3", async () => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  const did1 = generateDiaperId();
  const did2 = generateDiaperId();
  const did3 = generateDiaperId();

  const res = await post("/api/events", {
    events: [
      {
        type: "diaper.logged",
        payload: { babyId, time: new Date().toISOString(), type: "wet", diaperDomainId: did1 },
        clientId: "c",
        clientEventId: generateId(),
      },
      {
        type: "diaper.logged",
        payload: { babyId, time: new Date().toISOString(), type: "dirty", diaperDomainId: did2 },
        clientId: "c",
        clientEventId: generateId(),
      },
      {
        type: "diaper.logged",
        payload: { babyId, time: new Date().toISOString(), type: "both", diaperDomainId: did3 },
        clientId: "c",
        clientEventId: generateId(),
      },
    ],
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.events.length).toBe(3);
  expect(body.state.diaperCount).toBe(3);
});

test("Error response includes indexed messages", async () => {
  const res = await post("/api/events", {
    events: [
      {
        type: "baby.created",
        payload: { name: "ok", birthdate: "2025-01-01" },
        clientId: "c",
        clientEventId: generateId(),
      },
      {
        type: "unknown.type",
        payload: {},
        clientId: "c",
        clientEventId: generateId(),
      },
    ],
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.errors.some((e: string) => e.includes("events[1]"))).toBe(true);
});
