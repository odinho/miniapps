import { test, expect, createBaby, setWakeUpTime, addCompletedSleep } from "./fixtures";

test("Stats page shows export buttons", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const now = new Date();
  addCompletedSleep(
    babyId,
    new Date(now.getTime() - 3600000).toISOString(),
    now.toISOString(),
    "nap",
  );

  await page.goto("/#/stats");
  await expect(page.getByTestId("export-btn")).toBeVisible({ timeout: 5000 });
});
