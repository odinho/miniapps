import {
  test,
  expect,
  createBaby,
  setWakeUpTime,
  seedBabyWithSleep,
  addActiveSleep,
  addCompletedSleep,
  getDb,
  generateId,
  fillTimeInput,
} from "./fixtures";

test("History page shows logged sleeps", async ({ page }) => {
  seedBabyWithSleep();
  await page.goto("/history");
  await expect(page.locator(".sleep-log-item")).toHaveCount(1, { timeout: 5000 });
  await expect(page.locator(".log-meta")).toContainText("Lur");
});

test("History page shows empty state when no sleeps", async ({ page }) => {
  createBaby("Testa");

  await page.goto("/history");
  // No sleep entries at all — empty state message shown
  await expect(page.getByText("Ingen oppføringar enno")).toBeVisible({ timeout: 5000 });
});

test("Clicking a sleep entry opens edit modal", async ({ page }) => {
  seedBabyWithSleep();
  await page.goto("/history");
  await expect(page.locator(".sleep-log-item")).toHaveCount(1, { timeout: 5000 });

  await page.locator(".sleep-log-item").click();
  await expect(page.getByRole("heading", { name: "Endra søvn" })).toBeVisible();
  await expect(page.locator(".type-pill.active")).toContainText("Lur");
});

test("Can edit a sleep entry type", async ({ page }) => {
  seedBabyWithSleep();
  await page.goto("/history");
  await expect(page.locator(".sleep-log-item")).toHaveCount(1, { timeout: 5000 });

  await page.locator(".sleep-log-item").click();
  await expect(page.getByRole("heading", { name: "Endra søvn" })).toBeVisible();

  await page.locator(".type-pill", { hasText: "Natt" }).click();
  await page.getByRole("button", { name: "Lagra" }).click();

  await expect(page.getByRole("heading", { name: "Endra søvn" })).not.toBeVisible({
    timeout: 3000,
  });
  await expect(page.locator(".log-meta")).toContainText("Nattesøvn");
});

test("Notes and fall-asleep-time visible in history list", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const db = getDb();
  const now = new Date();
  const start = new Date(now.getTime() - 3600000).toISOString();
  const end = now.toISOString();
  db.prepare(
    "INSERT INTO sleep_log (baby_id, start_time, end_time, type, fall_asleep_time, notes, woke_by, wake_notes, domain_id) VALUES (?, ?, ?, 'nap', '5-20', 'Roleg kveld', 'self', 'Glad ved oppvakning', ?)",
  ).run(babyId, start, end, generateId());

  await page.goto("/history");
  await expect(page.locator(".sleep-log-item").first()).toBeVisible({ timeout: 5000 });

  const item = page.locator(".sleep-log-item:not(.wakeup-log-item)").first();
  // Fall-asleep time should be formatted
  await expect(item).toContainText("5–20 min");
  // Notes visible
  await expect(item).toContainText("Roleg kveld");
  // Woke-by info visible
  await expect(item).toContainText("Vakna sjølv");
  // Wake notes visible
  await expect(item).toContainText("Glad ved oppvakning");
});

test("Can delete a sleep entry", async ({ page }) => {
  seedBabyWithSleep();
  await page.goto("/history");
  await expect(page.locator(".sleep-log-item")).toHaveCount(1, { timeout: 5000 });

  await page.locator(".sleep-log-item").click();
  // Click Slett in edit modal — opens custom confirm dialog
  await page.getByRole("button", { name: "Slett" }).first().click();
  // Click Slett in confirm dialog
  await page.locator(".modal-overlay").last().getByRole("button", { name: "Slett" }).click();

  await expect(page.getByText("Ingen oppføringar enno")).toBeVisible({ timeout: 5000 });
});

test('Active sleep shows "pågår…" in history', async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  addActiveSleep(babyId, new Date().toISOString(), "nap");

  await page.goto("/history");
  // setWakeUpTime inserts a completed night sleep + 1 active nap = 2 items
  const sleepItems = page.locator(".sleep-log-item:not(.wakeup-log-item):not(.diaper-log-item)");
  await expect(sleepItems).toHaveCount(2, { timeout: 5000 });
  // The active nap should show "pågår…"
  const activeItem = sleepItems.filter({ hasText: "pågår…" });
  await expect(activeItem.locator(".log-duration")).toHaveText("pågår…");
});

test("multi-baby log labels each entry and filters by child", async ({ page }) => {
  const ada = createBaby("Ada", "2025-06-12");
  const bo = createBaby("Bo", "2025-06-12");
  const hr = 3600 * 1000;
  const now = Date.now();
  addCompletedSleep(ada, new Date(now - 5 * hr).toISOString(), new Date(now - 4 * hr).toISOString(), "nap");
  addCompletedSleep(bo, new Date(now - 3 * hr).toISOString(), new Date(now - 2 * hr).toISOString(), "nap");

  await page.goto("/history");

  // Filter pills show only in multi-baby mode; default "Alle" shows both.
  await expect(page.getByTestId("log-baby-filter")).toBeVisible({ timeout: 5000 });
  await expect(page.locator(".sleep-log-item")).toHaveCount(2);
  await expect(page.getByTestId("log-baby-chip")).toHaveCount(2);

  // Narrow to Bo → only Bo's entry, labelled.
  await page.getByTestId("log-baby-filter").getByRole("button", { name: "Bo", exact: true }).click();
  await expect(page.locator(".sleep-log-item")).toHaveCount(1);
  await expect(page.getByTestId("log-baby-chip")).toHaveText("Bo");

  // Back to everyone.
  await page.getByTestId("log-baby-filter").getByRole("button", { name: "Alle" }).click();
  await expect(page.locator(".sleep-log-item")).toHaveCount(2);
});

test("add a night waking to a completed night via the log", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId); // seeds a completed night 19:00 (prev day) → 07:00
  const db = getDb();

  await page.goto("/history");
  const nightItem = page
    .locator(".sleep-log-item:not(.wakeup-log-item):not(.diaper-log-item)")
    .filter({ hasText: "Nattesøvn" });
  await expect(nightItem).toHaveCount(1, { timeout: 5000 });
  await nightItem.click();
  await expect(page.getByRole("heading", { name: "Endra søvn" })).toBeVisible();

  // Open the create-mode night-waking sheet from the night's edit modal.
  await page.getByTestId("add-night-waking").click();
  await expect(page.getByTestId("night-waking-edit-sheet")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ny nattvaking" })).toBeVisible();

  // Dates default to the night's start date; set a valid interval within it.
  await fillTimeInput(page.getByTestId("waking-start-time"), "22:00");
  await fillTimeInput(page.getByTestId("waking-end-time"), "22:30");
  await page.getByTestId("waking-save").click();

  await expect(page.getByTestId("night-waking-edit-sheet")).not.toBeVisible({ timeout: 3000 });
  await expect
    .poll(() =>
      (
        db
          .prepare("SELECT COUNT(*) as n FROM night_waking WHERE baby_id = ? AND deleted = 0")
          .get(babyId) as { n: number }
      ).n,
    )
    .toBe(1);
});
