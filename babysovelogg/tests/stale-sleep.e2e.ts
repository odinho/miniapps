import {
  test,
  expect,
  createBaby,
  addActiveSleep,
  forceHour,
} from "./fixtures";

// An open sleep left running over a day (forgotten wake) — the 466:34:51
// report. The dashboard must stop the runaway timer and surface a resolve
// banner instead of treating it as a live session.

async function pinNow(page: import("@playwright/test").Page, nowMs: number) {
  await page.route("**/api/state**", async (route) => {
    const url = new URL(route.request().url());
    if (!url.searchParams.has("now")) url.searchParams.set("now", String(nowMs));
    await route.continue({ url: url.toString() });
  });
}

test("open sleep over 24h shows the resolve banner, not a runaway timer", async ({ page }) => {
  const babyId = createBaby("Testa");
  const now = new Date();
  now.setHours(10, 0, 0, 0);
  const start = new Date(now.getTime() - 30 * 60 * 60 * 1000); // 30h ago → stale
  addActiveSleep(babyId, start.toISOString(), "night");

  await pinNow(page, now.getTime());
  await forceHour(page, 10);
  await page.goto("/");
  await expect(page.getByTestId("dashboard")).toBeVisible({ timeout: 5000 });

  // Resolve banner is shown, with both actions.
  await expect(page.getByTestId("stale-sleep-banner")).toBeVisible();
  await expect(page.getByTestId("stale-set-wake")).toBeVisible();
  await expect(page.getByTestId("stale-discard")).toBeVisible();

  // The runaway "💤 Søv 30:00:00"-style sleeping label is gone (no active sleep).
  await expect(
    page.locator(".arc-center-label").filter({ hasText: "Søv" }),
  ).toHaveCount(0);
});

test("discarding the stale session clears the banner", async ({ page }) => {
  const babyId = createBaby("Testa");
  const now = new Date();
  now.setHours(10, 0, 0, 0);
  const start = new Date(now.getTime() - 30 * 60 * 60 * 1000);
  addActiveSleep(babyId, start.toISOString(), "night");

  await pinNow(page, now.getTime());
  await forceHour(page, 10);
  await page.goto("/");
  await expect(page.getByTestId("stale-sleep-banner")).toBeVisible();

  await page.getByTestId("stale-discard").click();
  await page.getByTestId("stale-discard-confirm").click();

  await expect(page.getByTestId("stale-sleep-banner")).toBeHidden();
});
