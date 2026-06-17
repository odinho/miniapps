import { test, expect, fillDateInput, forceHour } from "./fixtures";

test("SSE: Context B sees sleep started in Context A without refresh", async ({
  page,
  browser,
}) => {
  await forceHour(page, 14); // Afternoon — skip morning prompt
  await page.goto("/");
  await page.locator('#baby-name').fill("SSE-Baby");
  await fillDateInput(page.locator('input.date-input'), "2025-06-12");
  await page.getByRole("button", { name: "Kom i gang ✨" }).click();
  await page.getByTestId("seed-primary").click();
  await expect(page.getByTestId("baby-name")).toHaveText("SSE-Baby", { timeout: 5000 });

  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.goto("/");
  await expect(page2.getByTestId("baby-name")).toHaveText("SSE-Baby", { timeout: 5000 });

  // Context A: start sleep
  await page.getByTestId("sleep-button").click();
  await expect(page.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 5000 });

  // Context B: should see sleeping state via SSE (no manual refresh)
  await expect(page2.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 10000 });

  await ctx2.close();
});

test("SSE: Both contexts work independently", async ({ page, browser }) => {
  await forceHour(page, 14);
  await page.goto("/");
  await page.locator('#baby-name').fill("SSE-Baby2");
  await fillDateInput(page.locator('input.date-input'), "2025-06-12");
  await page.getByRole("button", { name: "Kom i gang ✨" }).click();
  await page.getByTestId("seed-primary").click();
  await expect(page.getByTestId("baby-name")).toHaveText("SSE-Baby2", { timeout: 5000 });

  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.goto("/");
  await expect(page2.getByTestId("baby-name")).toHaveText("SSE-Baby2", { timeout: 5000 });

  // Sync badge exists in dashboard header
  await expect(page.getByTestId("sync-badge")).toBeAttached();
  await expect(page2.getByTestId("sync-badge")).toBeAttached();

  await ctx2.close();
});
