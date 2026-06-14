import { test, expect, createBaby, addCompletedSleep, addActiveSleep } from "./fixtures";

const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();

test("family handoff shows a collapsed 6h timeline with per-child status", async ({ page }) => {
  const ada = createBaby("Ada", "2025-06-12");
  const bo = createBaby("Bo", "2025-06-12");
  // Ada: awake after a completed nap an hour ago. Bo: asleep now.
  addCompletedSleep(ada, iso(150), iso(90), "nap");
  addActiveSleep(bo, iso(30), "nap");

  await page.goto("/");
  const handoff = page.getByTestId("handoff");
  await expect(handoff).toBeVisible({ timeout: 5000 });
  // Collapsed by default — the rows aren't shown until opened.
  await expect(page.getByTestId("handoff-row").first()).not.toBeVisible();

  await handoff.locator("summary").click();

  const rows = page.getByTestId("handoff-row");
  await expect(rows).toHaveCount(2);
  await expect(handoff).toContainText("Ada");
  await expect(handoff).toContainText("Bo");
  await expect(handoff).toContainText("Vaken");
  await expect(handoff).toContainText("Søv");
});

test("single child has no family handoff section", async ({ page }) => {
  const ada = createBaby("Ada", "2025-06-12");
  addCompletedSleep(ada, iso(150), iso(90), "nap");

  await page.goto("/");
  await expect(page.getByTestId("dashboard")).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("handoff")).not.toBeVisible();
});
