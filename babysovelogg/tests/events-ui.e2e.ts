import {
  test,
  expect,
  createBaby,
  setWakeUpTime,
  generateDiaperId,
  postEvents,
  makeEvent,
} from "./fixtures";

test("Events screen renders with recent events", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  await postEvents(page, [
    makeEvent("diaper.logged", {
      babyId,
      time: new Date().toISOString(),
      type: "wet",
      diaperDomainId: generateDiaperId(),
    }),
  ]);

  await page.goto("/events");
  await page.waitForSelector("[data-testid='events-list']");
  const cards = await page.getByTestId("event-card").count();
  expect(cards).toBeGreaterThanOrEqual(1);
});

test("Tap event card expands payload", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  await postEvents(page, [
    makeEvent("diaper.logged", {
      babyId,
      time: new Date().toISOString(),
      type: "wet",
      diaperDomainId: generateDiaperId(),
    }),
  ]);

  await page.goto("/events");
  await page.waitForSelector("[data-testid='event-card']");
  const firstCard = page.getByTestId("event-card").first();
  await firstCard.click();
  const pre = firstCard.locator("pre");
  await expect(pre).toBeVisible();
});
