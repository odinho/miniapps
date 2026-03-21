import { test, expect, createBaby, setWakeUpTime, forceMorning } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await forceMorning(page);
});

test("Settings shows sleep info panel with wake window format", async ({ page }) => {
  // 12-month baby has wake windows >= 60 min (210-300 min = 3h 30m – 5h)
  createBaby("Testa", "2025-03-12");
  await page.goto("/#/settings");

  await expect(page.getByRole("heading", { name: "Innstillingar" })).toBeVisible();
  await expect(page.getByText("Søvninfo for")).toBeVisible({ timeout: 5000 });

  // Wake windows >= 60 min should show "Xh Ym" format
  const panel = page.locator(".sleep-info-panel");
  const text = await panel.textContent();
  expect(text).toMatch(/\dh \d+m/); // e.g., "3h 30m"
});

test("Settings shows correct pluralization for nap count", async ({ page }) => {
  // 18-month baby has "1 lur"
  createBaby("Testa", "2024-09-12");
  await page.goto("/#/settings");

  await expect(page.getByText("Søvninfo for")).toBeVisible({ timeout: 5000 });
  await expect(page.locator(".sleep-info-panel")).toContainText("1 lur");
});

test('Settings shows "lurar" for multiple naps', async ({ page }) => {
  // 6-month baby has "2–3 lurar"
  createBaby("Testa", "2025-09-12");
  await page.goto("/#/settings");

  await expect(page.getByText("Søvninfo for")).toBeVisible({ timeout: 5000 });
  await expect(page.locator(".sleep-info-panel")).toContainText("lurar");
});

test("Sync dot is not visible when connected", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });

  // Sync dot should be hidden when connected
  const syncDot = page.locator("#sync-dot");
  await expect(syncDot).toHaveCSS("display", "none");
});

test("Can edit baby name", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  await page.goto("/#/settings");

  await expect(page.getByRole("heading", { name: "Innstillingar" })).toBeVisible();
  const nameInput = page.locator('input[type="text"]');
  await nameInput.fill("Veslemøy");
  await page.locator('input[type="date"]').fill("2025-06-12");
  await page.getByRole("button", { name: "Lagra" }).click();

  // Should navigate to dashboard with new name
  await expect(page.getByTestId("baby-name")).toHaveText("Veslemøy", { timeout: 5000 });
});
