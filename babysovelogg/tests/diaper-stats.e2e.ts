import { test, expect, createBaby, setWakeUpTime, addCompletedSleep, addDiaper } from "./fixtures";

test("Stats page shows diaper statistics section", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const now = new Date();

  // Add a sleep so stats page renders
  addCompletedSleep(
    babyId,
    new Date(now.getTime() - 3600000).toISOString(),
    new Date(now.getTime() - 1800000).toISOString(),
    "nap",
  );

  // Add some diapers
  addDiaper(babyId, new Date(now.getTime() - 7200000).toISOString(), "wet", "middels");
  addDiaper(babyId, new Date(now.getTime() - 3600000).toISOString(), "dirty", "lite");
  addDiaper(babyId, new Date(now.getTime() - 1800000).toISOString(), "both", "mykje");

  await page.goto("/#/stats");
  // Diaper section should show
  const diaperSection = page.getByRole("heading", { name: "Bleie/Do" });
  await expect(diaperSection).toBeVisible({ timeout: 5000 });
  // Should show diaper count stats near the heading
  const parent = page.locator(".stats-section").filter({ has: diaperSection });
  await expect(parent.locator(".stat-value").first()).toBeVisible();
});

test("Stats page without diapers shows no diaper section", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const now = new Date();

  addCompletedSleep(
    babyId,
    new Date(now.getTime() - 3600000).toISOString(),
    new Date(now.getTime() - 1800000).toISOString(),
    "nap",
  );

  await page.goto("/#/stats");
  // Should NOT show Bleie/Do section
  await expect(page.getByRole("heading", { name: "Siste 7 dagar" })).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole("heading", { name: "Bleie/Do" })).not.toBeVisible();
});
