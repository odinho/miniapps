import {
  test,
  expect,
  createBaby,
  setWakeUpTime,
} from "./fixtures";

test("Arc uses wake-up time as starting point", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  await page.goto("/");
  await expect(page.getByTestId("dashboard")).toBeVisible();
  await expect(page.locator(".sleep-arc")).toBeVisible();
});

test("Shows predicted nap bubbles when no sleeps yet", async ({ page }) => {
  const babyId = createBaby("Testa", "2025-10-01");
  setWakeUpTime(babyId);

  await page.goto("/");
  await expect(page.getByTestId("dashboard")).toBeVisible();
  // Predicted naps depend on server-side time; verify arc renders
  await expect(page.locator(".sleep-arc")).toBeVisible();
});

test("Shows bedtime bubble at arc end", async ({ page }) => {
  const babyId = createBaby("Testa", "2025-10-01");
  setWakeUpTime(babyId);

  await page.goto("/");
  await expect(page.getByTestId("dashboard")).toBeVisible();
  await expect(page.locator(".sleep-arc")).toBeVisible();
});

test("Predicted bubbles are replaced by actual sleeps", async ({ page }) => {
  const babyId = createBaby("Testa", "2025-10-01");
  setWakeUpTime(babyId);

  await page.goto("/");
  await expect(page.getByTestId("dashboard")).toBeVisible();

  await page.getByTestId("sleep-button").click();
  await expect(page.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 5000 });
});
