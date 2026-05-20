import {
  test,
  expect,
  createBaby,
  setWakeUpTime,
  addCompletedSleep,
  dismissSheet,
  getDb,
} from "./fixtures";

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

  await expect(page.locator(".summary-row").getByText("lurar")).toBeVisible();
  await expect(page.locator(".summary-row").getByText("lurtid")).toBeVisible();
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
  // Use explicit today-morning timestamps to avoid crossing midnight boundary
  const today = new Date();
  today.setHours(9, 0, 0, 0);
  const nap1Start = new Date(today);
  const nap1End = new Date(today); nap1End.setHours(10, 0, 0, 0);
  const nap2Start = new Date(today); nap2Start.setHours(13, 0, 0, 0);
  const nap2End = new Date(today); nap2End.setHours(14, 0, 0, 0);
  addCompletedSleep(babyId, nap1Start.toISOString(), nap1End.toISOString(), "nap");
  addCompletedSleep(babyId, nap2Start.toISOString(), nap2End.toISOString(), "nap");

  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });
  await expect(page.locator(".summary-row")).toContainText("2");
  await expect(page.locator(".summary-row")).toContainText("lurar");
});

test('Stats: hides "totalt" when equal to nap time (no night sleep)', async ({ page }) => {
  // The "no night sleep" path requires wake to come from a day_start
  // marker, not the more common overnight-end_time path: after the
  // 2026-05-20 sleep-day fix, even a "yesterday 19:00 → today 07:00"
  // overnight contributes ~12h to today's daily total, so totalt would
  // never equal naptime when setWakeUpTime is used. Set up wake the
  // marker-only way for this test.
  const babyId = createBaby("Testa");
  const todayDate = new Date().toISOString().slice(0, 10);
  const wakeIso = new Date(new Date(`${todayDate}T07:00:00Z`)).toISOString();
  const db = getDb();
  db.prepare(
    "INSERT INTO day_start (baby_id, date, wake_time, created_at) VALUES (?, ?, ?, ?)",
  ).run(babyId, todayDate, wakeIso, wakeIso);
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

test("Sync badge does not flash offline during SSE grace period", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  // Hang SSE so it never opens — simulates initial load before SSE connects
  await page.route("/api/stream", () => {
    // Never respond — SSE stays pending, sseStatus stays "disconnected"
  });
  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });
  const badge = page.getByTestId("sync-badge");
  // Within grace period (5s), badge should NOT say "offline"
  await expect(badge).not.toHaveText("offline");
});

test("Sync badge shows offline after SSE grace period expires", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  // Return 503 for SSE so EventSource fires error and retries
  await page.route("/api/stream", (route) =>
    route.fulfill({ status: 503, body: "Service Unavailable" }),
  );
  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });
  const badge = page.getByTestId("sync-badge");
  // After the 5s grace period, badge SHOULD show "offline"
  await expect(badge).toHaveText("offline", { timeout: 10000 });
});

test("Redirects to settings when no baby exists", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Velkomen til Babysovelogg" })).toBeVisible();
});

test("Undo toast appears after starting sleep", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });

  await page.getByTestId("sleep-button").click();
  await expect(page.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 5000 });

  // Undo toast should appear with "Angre" button
  await expect(page.getByText("Søvn starta")).toBeVisible({ timeout: 3000 });
  await expect(page.getByRole("button", { name: "Angre" })).toBeVisible();

  // Click undo — sleep should be reverted
  await page.getByRole("button", { name: "Angre" }).click();
  await expect(page.getByTestId("sleep-button")).toHaveClass(/awake/, { timeout: 5000 });
});

test("Undo toast appears after ending sleep", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });

  // Start sleep
  await page.getByTestId("sleep-button").click();
  await expect(page.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 5000 });
  await dismissSheet(page);

  // End sleep
  await page.getByTestId("sleep-button").click();
  await expect(page.getByTestId("sleep-button")).toHaveClass(/awake/, { timeout: 5000 });

  // Undo toast should show "Søvn avslutta"
  await expect(page.getByText("Søvn avslutta")).toBeVisible({ timeout: 3000 });
  // May have two toasts (start + end) — click the last Angre button
  await page.getByRole("button", { name: "Angre" }).last().click();

  // Sleep should be active again
  await expect(page.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 5000 });
});

test("Dashboard shows diaper count in summary", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });

  // Log a diaper
  await page.getByRole("button", { name: /Bleie/ }).click();
  await page.getByRole("button", { name: /Våt/ }).click();
  await page.getByRole("button", { name: "Lagra" }).click();
  await expect(page.getByTestId("modal-overlay")).not.toBeVisible({ timeout: 5000 });

  // Summary should show "1 bleie"
  await expect(page.locator(".summary-row")).toContainText("bleie", { timeout: 5000 });
});
