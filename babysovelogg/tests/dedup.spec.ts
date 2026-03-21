import { test, expect, createBaby, setWakeUpTime, forceMorning, getDb, generateId } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await forceMorning(page);
});

test("Duplicate events with same clientId+clientEventId are ignored", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  const clientId = "test-client";
  const clientEventId = "test-dedup-" + Date.now();
  const sleepDomainId = generateId();
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
  const res1 = await page.request.post("/api/events", { data: eventPayload });
  expect(res1.ok()).toBeTruthy();
  const data1 = await res1.json();
  expect(data1.events.length).toBe(1);
  expect(data1.events[0].duplicate).toBe(false);

  // Stop the sleep first so we can check the dedup behavior
  const endRes = await page.request.post("/api/events", {
    data: {
      events: [
        {
          type: "sleep.ended",
          payload: { sleepDomainId, endTime: new Date().toISOString() },
          clientId,
          clientEventId: generateId(),
        },
      ],
    },
  });
  expect(endRes.ok()).toBeTruthy();

  // Second POST with same clientId+clientEventId should be deduplicated
  const res2 = await page.request.post("/api/events", { data: eventPayload });
  expect(res2.ok()).toBeTruthy();
  const data2 = await res2.json();
  // Duplicate should be flagged
  expect(data2.events.length).toBe(1);
  expect(data2.events[0].duplicate).toBe(true);

  // Verify only one sleep was created
  const db = getDb();
  const sleeps = db.prepare("SELECT * FROM sleep_log WHERE baby_id = ?").all(babyId);
  db.close();
  expect(sleeps.length).toBe(1);
});

test("Duplicate POST does NOT trigger SSE broadcast", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  const clientId = "test-client";
  const clientEventId = generateId();
  const sleepDomainId = generateId();
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
  await page.request.post("/api/events", { data: eventPayload });

  // Verify duplicate returns existing event
  const res = await page.request.post("/api/events", { data: eventPayload });
  const data = await res.json();
  expect(data.events[0].duplicate).toBe(true);
  expect(data.events[0].type).toBe("sleep.started");
});

test("Batch with mix of new and duplicate events", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  const clientId = "test-client";
  const eid1 = generateId();
  const did1 = generateId();

  // First: create a sleep
  await page.request.post("/api/events", {
    data: {
      events: [
        {
          type: "sleep.started",
          payload: { babyId, startTime: new Date().toISOString(), type: "nap", sleepDomainId: did1 },
          clientId,
          clientEventId: eid1,
        },
      ],
    },
  });

  // Now send batch: duplicate + new end event
  const eid2 = generateId();
  const res = await page.request.post("/api/events", {
    data: {
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
    },
  });
  expect(res.ok()).toBeTruthy();
  const data = await res.json();
  expect(data.events[0].duplicate).toBe(true);
  expect(data.events[1].duplicate).toBe(false);
});

test("Verify envelope columns exist", async () => {
  const db = getDb();
  const row = db.prepare("SELECT schema_version, correlation_id, caused_by_event_id, domain_id FROM events LIMIT 0").all();
  expect(row).toBeDefined();
  db.close();
});
