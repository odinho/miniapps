import { test, expect, createBaby, setWakeUpTime, addEvent } from "./fixtures";

test("Events page has a close button that navigates back", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  await page.goto("/events");
  await expect(page.getByRole("heading", { name: "Hendingslogg" })).toBeVisible({ timeout: 5000 });
  const closeBtn = page.getByTestId("events-close-btn");
  await expect(closeBtn).toBeVisible();
  await closeBtn.click();
  await expect(page.getByTestId("dashboard")).toBeVisible({ timeout: 5000 });
});

test("Event card preview shows formatted times, not raw ISO strings", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  addEvent("sleep.started", {
    babyId,
    startTime: "2026-03-23T17:01:08.835Z",
    type: "nap",
    sleepDomainId: "slp_test123",
  });
  addEvent("sleep.ended", {
    sleepDomainId: "slp_test123",
    endTime: "2026-03-23T18:30:00.000Z",
  });
  await page.goto("/events");
  await expect(page.getByTestId("events-list")).toBeVisible({ timeout: 5000 });
  const cards = page.locator("[data-testid='event-card']");
  const count = await cards.count();
  expect(count).toBeGreaterThan(0);
  // No card preview should contain raw ISO timestamps like "2026-03-23T17:01"
  const previews = await Promise.all(
    Array.from({ length: count }, (_, i) => cards.nth(i).locator("div:nth-child(2)").textContent()),
  );
  for (const preview of previews) {
    if (preview) {
      expect(preview).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    }
  }
});
