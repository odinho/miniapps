import {
  test,
  expect,
  createBaby,
  setWakeUpTime,
  forceMorning,
  generateId,
  generateSleepId,
  generateDiaperId,
} from "./fixtures";

test.beforeEach(async ({ page }) => {
  await forceMorning(page);
});

function postEvent(page: import("@playwright/test").Page, events: Record<string, unknown>[]) {
  return page.request.post("/api/events", { data: { events } });
}

function makeEvent(type: string, payload: Record<string, unknown>) {
  return { type, payload, clientId: "test", clientEventId: generateId() };
}

test("GET /api/events with type filter narrows results", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  await postEvent(page, [
    makeEvent("sleep.started", {
      babyId,
      startTime: new Date().toISOString(),
      sleepDomainId: generateSleepId(),
    }),
  ]);
  await postEvent(page, [
    makeEvent("diaper.logged", {
      babyId,
      time: new Date().toISOString(),
      type: "wet",
      diaperDomainId: generateDiaperId(),
    }),
  ]);

  const res = await page.request.get("/api/events?type=diaper.logged&limit=50");
  const data = await res.json();
  expect(data.events.length).toBeGreaterThanOrEqual(1);
  for (const evt of data.events) {
    expect(evt.type).toBe("diaper.logged");
  }
});

test("GET /api/events with domainId filter returns entity events", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const did = generateSleepId();

  await postEvent(page, [
    makeEvent("sleep.started", { babyId, startTime: new Date().toISOString(), sleepDomainId: did }),
  ]);
  await postEvent(page, [makeEvent("sleep.tagged", { sleepDomainId: did, mood: "calm" })]);
  await postEvent(page, [
    makeEvent("diaper.logged", {
      babyId,
      time: new Date().toISOString(),
      type: "wet",
      diaperDomainId: generateDiaperId(),
    }),
  ]);

  const res = await page.request.get(`/api/events?domainId=${did}&limit=50`);
  const data = await res.json();
  expect(data.events.length).toBe(2);
  expect(data.events.every((e: Record<string, unknown>) => e.domain_id === did)).toBe(true);
});

test("GET /api/events with pagination returns correct total", async ({ page }) => {
  const babyId = createBaby("Testa");

  // Create a few events
  await Promise.all(
    Array.from({ length: 5 }, () =>
      postEvent(page, [
        makeEvent("diaper.logged", {
          babyId,
          time: new Date().toISOString(),
          type: "wet",
          diaperDomainId: generateDiaperId(),
        }),
      ]),
    ),
  );

  const res = await page.request.get("/api/events?limit=2&offset=0");
  const data = await res.json();
  expect(data.events.length).toBe(2);
  // Total includes baby.created from fixture + 5 diapers
  expect(data.total).toBeGreaterThanOrEqual(6);
});

test("Events screen renders with recent events", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  await postEvent(page, [
    makeEvent("diaper.logged", {
      babyId,
      time: new Date().toISOString(),
      type: "wet",
      diaperDomainId: generateDiaperId(),
    }),
  ]);

  await page.goto("/#/events");
  await page.waitForSelector("[data-testid='events-list']");
  const cards = await page.getByTestId("event-card").count();
  expect(cards).toBeGreaterThanOrEqual(1);
});

test("Tap event card expands payload", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  await postEvent(page, [
    makeEvent("diaper.logged", {
      babyId,
      time: new Date().toISOString(),
      type: "wet",
      diaperDomainId: generateDiaperId(),
    }),
  ]);

  await page.goto("/#/events");
  await page.waitForSelector("[data-testid='event-card']");
  const firstCard = page.getByTestId("event-card").first();
  await firstCard.click();
  // After click, the pre element should be visible
  const pre = firstCard.locator("pre");
  await expect(pre).toBeVisible();
});
