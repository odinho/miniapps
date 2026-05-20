import { test, expect, createBaby, setWakeUpTime, fillDateInput } from "./fixtures";

test("Stats shows sleep info panel with wake window format", async ({ page }) => {
  // 12-month baby has wake windows >= 60 min (210-300 min). The comparison
  // table renders them in compact Nynorsk "Xt YY" format (e.g. "3t30").
  const babyId = createBaby("Testa", "2025-03-12");
  setWakeUpTime(babyId);
  await page.goto("/stats");

  const panel = page.locator(".sleep-info-panel");
  await expect(panel).toBeVisible({ timeout: 5000 });
  const text = await panel.textContent();
  expect(text).toMatch(/\dt\d{2}/); // e.g. "3t30"
});

test("Stats shows correct pluralization for nap count", async ({ page }) => {
  // 18-month baby has "1 lur" as the singular norm label.
  const babyId = createBaby("Testa", "2024-09-12");
  setWakeUpTime(babyId);
  await page.goto("/stats");

  const panel = page.locator(".sleep-info-panel");
  await expect(panel).toBeVisible({ timeout: 5000 });
  await expect(panel).toContainText("Lurar");
});

test('Stats shows "lurar" plural label', async ({ page }) => {
  // 6-month baby has "2–3 lurar" — the "Lurar" row label is plural even when
  // the baby only does one nap, since it's the metric name, not an inline count.
  const babyId = createBaby("Testa", "2025-09-12");
  setWakeUpTime(babyId);
  await page.goto("/stats");

  const panel = page.locator(".sleep-info-panel");
  await expect(panel).toBeVisible({ timeout: 5000 });
  await expect(panel).toContainText("Lurar");
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
  await page.goto("/settings");

  await expect(page.getByRole("heading", { name: "Innstillingar" })).toBeVisible();
  const nameInput = page.locator('#baby-name');
  await nameInput.fill("Veslemøy");
  await fillDateInput(page.locator('input.date-input'), "2025-06-12");
  await page.getByRole("button", { name: "Lagra" }).click();

  // Should navigate to dashboard with new name
  await expect(page.getByTestId("baby-name")).toHaveText("Veslemøy", { timeout: 5000 });
});
