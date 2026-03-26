import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

async function dismissMorningPrompt(page: Page) {
  await page.getByTestId("morning-prompt").waitFor({ state: "visible", timeout: 5000 });
  await page.getByRole("button", { name: "Sett vaknetid" }).click();
  await page.getByTestId("morning-prompt").waitFor({ state: "hidden", timeout: 5000 });
}

test("Second browser context sees baby created in first", async ({ page, browser }) => {
  await page.goto("/");
  await page.locator('input[type="text"]').fill("Testa");
  await page.locator('input[type="date"]').fill("2025-06-12");
  await page.getByRole("button", { name: "Kom i gang ✨" }).click();
  await dismissMorningPrompt(page);
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
  await page.goto("/");
  await page.locator('input[type="text"]').fill("Testa");
  await page.locator('input[type="date"]').fill("2025-06-12");
  await page.getByRole("button", { name: "Kom i gang ✨" }).click();
  await dismissMorningPrompt(page);
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
