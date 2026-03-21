import { test, expect, createBaby, setWakeUpTime, forceMorning, getDb, generateId } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await forceMorning(page);
});

function postEvent(page: import("@playwright/test").Page, events: Record<string, unknown>[]) {
  return page.request.post("/api/events", { data: { events } });
}

function makeEvent(type: string, payload: Record<string, unknown>) {
  return { type, payload, clientId: "test", clientEventId: generateId() };
}

test("After sleep.started, sleep_log row has created_by_event_id", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const did = generateId();

  const res = await postEvent(page, [
    makeEvent("sleep.started", { babyId, startTime: new Date().toISOString(), sleepDomainId: did }),
  ]);
  const data = await res.json();
  const eventId = data.events[0].id;

  const db = getDb();
  const sleep = db.prepare("SELECT created_by_event_id FROM sleep_log WHERE domain_id = ?").get(did) as { created_by_event_id: number };
  db.close();
  expect(sleep.created_by_event_id).toBe(eventId);
});

test("After sleep.tagged, sleep_log row has updated_by_event_id", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const did = generateId();

  await postEvent(page, [
    makeEvent("sleep.started", { babyId, startTime: new Date().toISOString(), sleepDomainId: did }),
  ]);

  const tagRes = await postEvent(page, [
    makeEvent("sleep.tagged", { sleepDomainId: did, mood: "happy" }),
  ]);
  const tagData = await tagRes.json();
  const tagEventId = tagData.events[0].id;

  const db = getDb();
  const sleep = db.prepare("SELECT updated_by_event_id FROM sleep_log WHERE domain_id = ?").get(did) as { updated_by_event_id: number };
  db.close();
  expect(sleep.updated_by_event_id).toBe(tagEventId);
});

test("After diaper.logged, diaper_log row has created_by_event_id", async ({ page }) => {
  const babyId = createBaby("Testa");
  const did = generateId();

  const res = await postEvent(page, [
    makeEvent("diaper.logged", { babyId, time: new Date().toISOString(), type: "wet", diaperDomainId: did }),
  ]);
  const data = await res.json();
  const eventId = data.events[0].id;

  const db = getDb();
  const diaper = db.prepare("SELECT created_by_event_id FROM diaper_log WHERE domain_id = ?").get(did) as { created_by_event_id: number };
  db.close();
  expect(diaper.created_by_event_id).toBe(eventId);
});

test("After rebuild, traceability columns are correct", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const did = generateId();

  const createRes = await postEvent(page, [
    makeEvent("sleep.started", { babyId, startTime: new Date().toISOString(), sleepDomainId: did }),
  ]);
  const createData = await createRes.json();
  const createEventId = createData.events[0].id;

  const tagRes = await postEvent(page, [
    makeEvent("sleep.tagged", { sleepDomainId: did, mood: "calm" }),
  ]);
  const tagData = await tagRes.json();
  const tagEventId = tagData.events[0].id;

  // Rebuild
  await page.request.post("/api/admin/rebuild");

  const db = getDb();
  const sleep = db.prepare("SELECT created_by_event_id, updated_by_event_id FROM sleep_log WHERE domain_id = ?").get(did) as {
    created_by_event_id: number;
    updated_by_event_id: number;
  };
  db.close();
  expect(sleep.created_by_event_id).toBe(createEventId);
  expect(sleep.updated_by_event_id).toBe(tagEventId);
});

test("GET /api/sleeps returns rows with traceability fields", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const did = generateId();

  await postEvent(page, [
    makeEvent("sleep.started", { babyId, startTime: new Date().toISOString(), sleepDomainId: did }),
  ]);

  const res = await page.request.get("/api/sleeps");
  const sleeps = await res.json();
  expect(sleeps.length).toBeGreaterThanOrEqual(1);
  const sleep = sleeps.find((s: Record<string, unknown>) => s.domain_id === did);
  expect(sleep).toBeDefined();
  expect(sleep.created_by_event_id).toBeDefined();
});
