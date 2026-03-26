import { test, expect, createBaby, setWakeUpTime } from "./fixtures";

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

test("Sync badge shows ok state when connected", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });

  // Sync badge should show the green "ok" state when connected
  const syncBadge = page.getByTestId("sync-badge");
  await expect(syncBadge).toBeAttached();
  await expect(syncBadge).toHaveClass(/sync-badge-ok/);
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
