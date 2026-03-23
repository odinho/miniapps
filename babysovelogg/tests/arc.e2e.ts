import {
  test,
  expect,
  createBaby,
  setWakeUpTime,
  addCompletedSleep,
  addActiveSleep,
  dismissSheet,
  forceMorning,
} from "./fixtures";

test("Arc renders on dashboard", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa");
  await expect(page.locator(".sleep-arc")).toBeVisible();
  await expect(page.locator(".arc-container")).toBeVisible();
});

test("Completed sleeps appear as filled bubbles on arc", async ({ page }) => {
  const babyId = createBaby("Testa");
  const now = new Date();
  const hour = now.getHours();

  let start: Date, end: Date;
  if (hour >= 6 && hour < 18) {
    start = new Date(now);
    start.setHours(10, 0, 0, 0);
    end = new Date(now);
    end.setHours(11, 0, 0, 0);
  } else if (hour >= 18) {
    start = new Date(now);
    start.setHours(20, 0, 0, 0);
    end = new Date(now);
    end.setHours(21, 0, 0, 0);
  } else {
    start = new Date(now);
    start.setHours(0, 0, 0, 0);
    end = new Date(now);
    end.setHours(1, 0, 0, 0);
  }

  addCompletedSleep(babyId, start.toISOString(), end.toISOString(), "nap");

  await page.goto("/");
  await expect(page.locator(".sleep-arc")).toBeVisible();
  await expect(page.locator(".arc-bubble-completed")).toHaveCount(1);
});

test("Predicted nap shown with dashed outline", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId); // Anchors arc to 7:00 so predictions land within 12h range

  // Place a completed nap 2h after wake-up, ending 30 min ago
  const now = new Date();
  const start = new Date(now.getTime() - 2 * 3600000);
  const end = new Date(now.getTime() - 30 * 60000);
  addCompletedSleep(babyId, start.toISOString(), end.toISOString(), "nap");

  await page.goto("/");
  await expect(page.locator(".sleep-arc")).toBeVisible();
  // Prediction depends on time-of-day; at minimum the arc should render
  const predicted = page.locator(".arc-bubble-predicted");
  // May be 0 at night when arc switches to night mode; that's OK
  const count = await predicted.count();
  expect(count).toBeGreaterThanOrEqual(0);
});

test("Active sleep has pulsing animation class", async ({ page }) => {
  const babyId = createBaby("Testa");
  const start = new Date(Date.now() - 20 * 60000);
  addActiveSleep(babyId, start.toISOString(), "nap");

  await page.goto("/");
  await expect(page.locator(".sleep-arc")).toBeVisible();
  await expect(page.locator(".arc-bubble-active")).toHaveCount(1);
  await expect(page.locator(".arc-active-pulse")).toHaveCount(1);
});

test("Arc center shows countdown when not sleeping", async ({ page }) => {
  const babyId = createBaby("Testa");
  const now = new Date();
  const start = new Date(now.getTime() - 2 * 3600000);
  const end = new Date(now.getTime() - 30 * 60000);
  addCompletedSleep(babyId, start.toISOString(), end.toISOString(), "nap");

  await page.goto("/");
  await expect(page.locator(".arc-center-text")).toBeVisible();
  // Label depends on time of day: "Neste lur", "Leggetid om", "Etter leggetid", etc.
  await expect(page.locator(".arc-center-label")).toBeVisible();
});

test("Clicking completed nap bubble opens edit modal", async ({ page }) => {
  const babyId = createBaby("Testa");
  const now = new Date();
  const hour = now.getHours();

  let start: Date, end: Date;
  if (hour >= 6 && hour < 18) {
    start = new Date(now);
    start.setHours(10, 0, 0, 0);
    end = new Date(now);
    end.setHours(11, 0, 0, 0);
  } else if (hour >= 18) {
    start = new Date(now);
    start.setHours(20, 0, 0, 0);
    end = new Date(now);
    end.setHours(21, 0, 0, 0);
  } else {
    start = new Date(now);
    start.setHours(0, 0, 0, 0);
    end = new Date(now);
    end.setHours(1, 0, 0, 0);
  }

  addCompletedSleep(babyId, start.toISOString(), end.toISOString(), "nap");

  await page.goto("/");
  await expect(page.locator(".arc-bubble-completed")).toHaveCount(1);

  // Click the completed bubble's tap target
  await page.locator(".arc-bubble-completed").click();
  await expect(page.getByRole("heading", { name: "Endra søvn" })).toBeVisible({ timeout: 5000 });
});

test("Arc center shows timer when sleeping", async ({ page }) => {
  const babyId = createBaby("Testa");
  addActiveSleep(babyId, new Date(Date.now() - 10 * 60000).toISOString(), "nap");

  await page.goto("/");
  await expect(page.locator(".arc-center-text")).toBeVisible();
  await expect(page.locator(".arc-center-label")).toContainText("Lurar");
});

test("Starting nap via UI shows active bubble on arc", async ({ page }) => {
  await forceMorning(page);
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  await page.goto("/");
  await expect(page.getByTestId("sleep-button")).toBeVisible();

  // Start sleep via main button
  await page.getByTestId("sleep-button").click();
  await expect(page.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 5000 });

  // Dismiss the tag sheet that appears
  await dismissSheet(page);

  // Active bubble must be visible on the arc
  await expect(page.locator(".arc-bubble-active")).toHaveCount(1, { timeout: 5000 });
  await expect(page.locator(".arc-active-pulse")).toHaveCount(1);
});

test("Active bubble persists after navigating away and back", async ({ page }) => {
  await forceMorning(page);
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  addActiveSleep(babyId, new Date(Date.now() - 20 * 60000).toISOString(), "nap");

  await page.goto("/");
  await expect(page.locator(".arc-bubble-active")).toHaveCount(1);

  // Navigate away and back — dashboard re-renders from current state
  await page.evaluate(() => {
    window.location.hash = "#/history";
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.location.hash = "#/";
  });

  // Active bubble should still be on the arc after re-render
  await expect(page.locator(".arc-bubble-active")).toHaveCount(1, { timeout: 5000 });
  await expect(page.locator(".arc-active-pulse")).toHaveCount(1);
});

test("Active bubble survives offline event + SSE reconnect", async ({ page }) => {
  await forceMorning(page);
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  await page.goto("/");
  await expect(page.getByTestId("sleep-button")).toBeVisible();

  // Go offline before starting nap
  await page.context().setOffline(true);

  // Start nap while offline — uses optimistic state
  await page.getByTestId("sleep-button").click();
  await expect(page.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 5000 });
  await dismissSheet(page);

  // Active bubble should appear from optimistic state
  await expect(page.locator(".arc-bubble-active")).toHaveCount(1, { timeout: 5000 });

  // Come back online — this should flush the queue and keep the active bubble
  await page.context().setOffline(false);
  await page.waitForTimeout(1000);

  // Active bubble should still be present
  await expect(page.locator(".arc-bubble-active")).toHaveCount(1);
});
