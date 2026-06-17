import { test, expect, fillDateInput, forceHour } from "./fixtures";

test("Second browser context sees baby created in first", async ({ page, browser }) => {
  await forceHour(page, 14); // Afternoon — skip morning prompt
  await page.goto("/");
  await page.locator('#baby-name').fill("Testa");
  await fillDateInput(page.locator('input.date-input'), "2025-06-12");
  await page.getByRole("button", { name: "Kom i gang ✨" }).click();
  await page.getByTestId("seed-primary").click();
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });

  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.goto("/");
  await expect(page2.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });
  await expect(page2.getByTestId("sleep-button")).toBeVisible();

  await ctx2.close();
});

test("Sleep started in one client is visible in another after reload", async ({
  page,
  browser,
}) => {
  await forceHour(page, 14);
  await page.goto("/");
  await page.locator('#baby-name').fill("Testa");
  await fillDateInput(page.locator('input.date-input'), "2025-06-12");
  await page.getByRole("button", { name: "Kom i gang ✨" }).click();
  await page.getByTestId("seed-primary").click();
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });

  await page.getByTestId("sleep-button").click();
  await expect(page.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 5000 });

  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.goto("/");
  await expect(page2.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });
  await expect(page2.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 5000 });

  await ctx2.close();
});
