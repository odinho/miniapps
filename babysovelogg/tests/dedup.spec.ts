import { test, expect, createBaby, setWakeUpTime, forceMorning, getDb } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await forceMorning(page);
});

test("Duplicate events with same clientEventId are ignored", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  const clientEventId = "test-dedup-" + Date.now();
  const eventPayload = {
    events: [
      {
        type: "sleep.started",
        payload: { babyId, startTime: new Date().toISOString(), type: "nap" },
        clientId: "test-client",
        clientEventId,
      },
    ],
  };

  // First POST should succeed
  const res1 = await page.request.post("/api/events", { data: eventPayload });
  expect(res1.ok()).toBeTruthy();
  const data1 = await res1.json();
  expect(data1.events.length).toBe(1);

  // Stop the sleep first so we can check the dedup behavior
  const sleepId = data1.state.activeSleep?.id;
  if (sleepId) {
    await page.request.post("/api/events", {
      data: {
        events: [{ type: "sleep.ended", payload: { sleepId, endTime: new Date().toISOString() } }],
      },
    });
  }

  // Second POST with same clientEventId should be deduplicated
  const res2 = await page.request.post("/api/events", { data: eventPayload });
  expect(res2.ok()).toBeTruthy();
  const data2 = await res2.json();
  // Events array should be empty (duplicate skipped)
  expect(data2.events.length).toBe(0);

  // Verify only one sleep was created
  const db = getDb();
  const sleeps = db.prepare("SELECT * FROM sleep_log WHERE baby_id = ?").all(babyId);
  db.close();
  expect(sleeps.length).toBe(1);
});

test("Events without clientEventId are always accepted", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  const now = new Date();
  const eventPayload = {
    events: [
      {
        type: "diaper.logged",
        payload: { babyId, time: now.toISOString(), type: "wet" },
        clientId: "test-client",
        // No clientEventId
      },
    ],
  };

  const res1 = await page.request.post("/api/events", { data: eventPayload });
  expect(res1.ok()).toBeTruthy();

  const res2 = await page.request.post("/api/events", { data: eventPayload });
  expect(res2.ok()).toBeTruthy();

  // Both should have been accepted (no dedup without clientEventId)
  const db = getDb();
  const diapers = db
    .prepare("SELECT * FROM diaper_log WHERE baby_id = ? AND deleted = 0")
    .all(babyId);
  db.close();
  expect(diapers.length).toBe(2);
});
