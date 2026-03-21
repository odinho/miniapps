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

test("sleep.started with sleepDomainId creates row with domain_id set", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const did = generateId();

  const res = await postEvent(page, [
    makeEvent("sleep.started", { babyId, startTime: new Date().toISOString(), sleepDomainId: did }),
  ]);
  expect(res.ok()).toBe(true);

  const db = getDb();
  const sleep = db.prepare("SELECT domain_id FROM sleep_log WHERE domain_id = ?").get(did) as { domain_id: string } | undefined;
  db.close();
  expect(sleep).toBeDefined();
  expect(sleep!.domain_id).toBe(did);
});

test("sleep.ended with sleepDomainId updates the correct row", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const did = generateId();

  await postEvent(page, [
    makeEvent("sleep.started", { babyId, startTime: new Date().toISOString(), sleepDomainId: did }),
  ]);

  const endTime = new Date().toISOString();
  const res = await postEvent(page, [
    makeEvent("sleep.ended", { sleepDomainId: did, endTime }),
  ]);
  expect(res.ok()).toBe(true);

  const db = getDb();
  const sleep = db.prepare("SELECT end_time FROM sleep_log WHERE domain_id = ?").get(did) as { end_time: string };
  db.close();
  expect(sleep.end_time).toBe(endTime);
});

test("sleep.tagged with sleepDomainId updates the correct row", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const did = generateId();

  await postEvent(page, [
    makeEvent("sleep.started", { babyId, startTime: new Date().toISOString(), sleepDomainId: did }),
  ]);

  const res = await postEvent(page, [
    makeEvent("sleep.tagged", { sleepDomainId: did, mood: "happy", method: "nursing" }),
  ]);
  expect(res.ok()).toBe(true);

  const db = getDb();
  const sleep = db.prepare("SELECT mood, method FROM sleep_log WHERE domain_id = ?").get(did) as { mood: string; method: string };
  db.close();
  expect(sleep.mood).toBe("happy");
  expect(sleep.method).toBe("nursing");
});

test("sleep.paused / sleep.resumed with sleepDomainId works", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const did = generateId();

  await postEvent(page, [
    makeEvent("sleep.started", { babyId, startTime: new Date().toISOString(), sleepDomainId: did }),
  ]);

  const pauseTime = new Date().toISOString();
  await postEvent(page, [
    makeEvent("sleep.paused", { sleepDomainId: did, pauseTime }),
  ]);

  const resumeTime = new Date().toISOString();
  const res = await postEvent(page, [
    makeEvent("sleep.resumed", { sleepDomainId: did, resumeTime }),
  ]);
  expect(res.ok()).toBe(true);

  const db = getDb();
  const pauses = db.prepare(
    "SELECT sp.* FROM sleep_pauses sp JOIN sleep_log sl ON sp.sleep_id = sl.id WHERE sl.domain_id = ?",
  ).all(did) as { pause_time: string; resume_time: string }[];
  db.close();
  expect(pauses.length).toBe(1);
  expect(pauses[0].pause_time).toBe(pauseTime);
  expect(pauses[0].resume_time).toBe(resumeTime);
});

test("diaper.logged with diaperDomainId creates row with domain_id", async ({ page }) => {
  const babyId = createBaby("Testa");
  const did = generateId();

  const res = await postEvent(page, [
    makeEvent("diaper.logged", { babyId, time: new Date().toISOString(), type: "wet", diaperDomainId: did }),
  ]);
  expect(res.ok()).toBe(true);

  const db = getDb();
  const diaper = db.prepare("SELECT domain_id FROM diaper_log WHERE domain_id = ?").get(did) as { domain_id: string };
  db.close();
  expect(diaper.domain_id).toBe(did);
});

test("diaper.deleted with diaperDomainId soft-deletes the correct row", async ({ page }) => {
  const babyId = createBaby("Testa");
  const did = generateId();

  await postEvent(page, [
    makeEvent("diaper.logged", { babyId, time: new Date().toISOString(), type: "wet", diaperDomainId: did }),
  ]);
  const res = await postEvent(page, [
    makeEvent("diaper.deleted", { diaperDomainId: did }),
  ]);
  expect(res.ok()).toBe(true);

  const db = getDb();
  const diaper = db.prepare("SELECT deleted FROM diaper_log WHERE domain_id = ?").get(did) as { deleted: number };
  db.close();
  expect(diaper.deleted).toBe(1);
});

test("Events without sleepDomainId are rejected by validation", async ({ page }) => {
  const babyId = createBaby("Testa");

  const res = await postEvent(page, [
    makeEvent("sleep.started", { babyId, startTime: new Date().toISOString() }),
  ]);
  expect(res.status()).toBe(400);
});

test("rebuildAll produces correct projection state", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const did1 = generateId();
  const did2 = generateId();

  // Create events through API (they go to both events table and projections)
  await postEvent(page, [
    makeEvent("sleep.started", { babyId, startTime: new Date(Date.now() - 3600000).toISOString(), sleepDomainId: did1 }),
  ]);
  await postEvent(page, [
    makeEvent("sleep.ended", { sleepDomainId: did1, endTime: new Date(Date.now() - 1800000).toISOString() }),
  ]);
  await postEvent(page, [
    makeEvent("diaper.logged", { babyId, time: new Date().toISOString(), type: "wet", diaperDomainId: did2 }),
  ]);

  // Rebuild
  const rebuildRes = await page.request.post("/api/admin/rebuild");
  expect(rebuildRes.ok()).toBe(true);
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
