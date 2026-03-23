import {
  test,
  expect,
  createBaby,
  setWakeUpTime,
  addCompletedSleep,
  dismissSheet,
  forceMorning,
} from "./fixtures";

test.beforeEach(async ({ page }) => {
  await forceMorning(page);
});

test("Dashboard shows baby name and sleep button", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa");
  await expect(page.getByTestId("baby-age")).toContainText("mnd");
  await expect(page.getByTestId("sleep-button")).toBeVisible();
  await expect(page.getByTestId("sleep-button")).toHaveClass(/awake/);
});

test("Can start and stop a nap", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  await page.goto("/");

  // Start sleep — tag sheet appears
  await page.getByTestId("sleep-button").click();
  await expect(page.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 5000 });
  // Dismiss bedtime tag sheet
  await dismissSheet(page);

  await expect(page.locator(".arc-center-label")).toContainText(/Lurar|Søv/);

  // End sleep — wake-up sheet appears
  await page.getByTestId("sleep-button").click();
  await expect(page.getByTestId("sleep-button")).toHaveClass(/awake/, { timeout: 5000 });
  await dismissSheet(page);
});

test("Dashboard shows stats section", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });

  await expect(page.getByText("lurar")).toBeVisible();
  await expect(page.getByText("lurtid")).toBeVisible();
  // "totalt" is only shown when night sleep differs from nap time
});

test('Pluralization: 0 naps shows "0 lurar"', async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  await page.goto("/");

  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });
  await expect(page.locator(".summary-row")).toContainText("0");
  await expect(page.locator(".summary-row")).toContainText("lurar");
});

test('Pluralization: 1 nap shows "1 lur"', async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const now = new Date();
  addCompletedSleep(
    babyId,
    new Date(now.getTime() - 3600000).toISOString(),
    new Date(now.getTime() - 1800000).toISOString(),
    "nap",
  );

  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });
  await expect(page.locator(".summary-row")).toContainText("1 lur");
  // Make sure it's "lur" not "lurar"
  const text = await page.locator(".summary-row").textContent();
  expect(text).toMatch(/1\s*lur[^a]/);
});

test('Pluralization: 2 naps shows "2 lurar"', async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const now = new Date();
  addCompletedSleep(
    babyId,
    new Date(now.getTime() - 4 * 3600000).toISOString(),
    new Date(now.getTime() - 3 * 3600000).toISOString(),
    "nap",
  );
  addCompletedSleep(
    babyId,
    new Date(now.getTime() - 2 * 3600000).toISOString(),
    new Date(now.getTime() - 1 * 3600000).toISOString(),
    "nap",
  );

  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });
  await expect(page.locator(".summary-row")).toContainText("2");
  await expect(page.locator(".summary-row")).toContainText("lurar");
});

test('Stats: hides "totalt" when equal to nap time (no night sleep)', async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const now = new Date();
  addCompletedSleep(
    babyId,
    new Date(now.getTime() - 3600000).toISOString(),
    new Date(now.getTime() - 1800000).toISOString(),
    "nap",
  );
  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });
  await expect(page.locator(".summary-row").getByText("lurtid")).toBeVisible();
  await expect(page.locator(".summary-row").getByText("totalt")).toBeHidden();
});

test('Stats: shows "totalt" when night sleep adds to total', async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const today = new Date();
  today.setHours(1, 0, 0, 0);
  addCompletedSleep(
    babyId,
    today.toISOString(),
    new Date(today.getTime() + 3600000).toISOString(),
    "night",
  );
  const now = new Date();
  addCompletedSleep(
    babyId,
    new Date(now.getTime() - 3600000).toISOString(),
    new Date(now.getTime() - 1800000).toISOString(),
    "nap",
  );
  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });
  await expect(page.locator(".summary-row")).toContainText("totalt");
});

test("Sync badge does not show offline when SSE fails but browser is online", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  // Hang SSE so it never opens — simulates initial load before SSE connects
  await page.route("/api/stream", () => {
    // Never respond — SSE stays pending, sseStatus stays "disconnected"
  });
  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });
  const badge = page.getByTestId("sync-badge");
  // navigator.onLine is true, so should not show "offline" even without SSE
  await expect(badge).not.toHaveText("offline");
});

test("Redirects to settings when no baby exists", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Velkomen til Babysovelogg" })).toBeVisible();
});
