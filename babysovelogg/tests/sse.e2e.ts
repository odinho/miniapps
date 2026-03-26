import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

async function dismissMorningPrompt(page: Page) {
  await page.getByTestId("morning-prompt").waitFor({ state: "visible", timeout: 5000 });
  await page.getByRole("button", { name: "Sett vaknetid" }).click();
  await page.getByTestId("morning-prompt").waitFor({ state: "hidden", timeout: 5000 });
}

test("SSE: Context B sees sleep started in Context A without refresh", async ({
  page,
  browser,
}) => {
  await page.goto("/");
  await page.locator('input[type="text"]').fill("SSE-Baby");
  await page.locator('input[type="date"]').fill("2025-06-12");
  await page.getByRole("button", { name: "Kom i gang ✨" }).click();
  await dismissMorningPrompt(page);
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
  await page.goto("/");
  await page.locator('input[type="text"]').fill("SSE-Baby2");
  await page.locator('input[type="date"]').fill("2025-06-12");
  await page.getByRole("button", { name: "Kom i gang ✨" }).click();
  await dismissMorningPrompt(page);
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
