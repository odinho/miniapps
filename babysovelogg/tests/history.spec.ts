import {
  test,
  expect,
  createBaby,
  setWakeUpTime,
  seedBabyWithSleep,
  getDb,
  forceMorning,
} from "./fixtures";

test.beforeEach(async ({ page }) => {
  await forceMorning(page);
});

test("History page shows logged sleeps", async ({ page }) => {
  seedBabyWithSleep();
  await page.goto("/#/history");
  await expect(page.locator(".sleep-log-item")).toHaveCount(1, { timeout: 5000 });
  await expect(page.locator(".log-meta")).toContainText("Lur");
});

test("History page shows empty state when no sleeps", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  await page.goto("/#/history");
  await expect(page.getByText("Ingen oppføringar enno")).toBeVisible({ timeout: 5000 });
});

test("Clicking a sleep entry opens edit modal", async ({ page }) => {
  seedBabyWithSleep();
  await page.goto("/#/history");
  await expect(page.locator(".sleep-log-item")).toHaveCount(1, { timeout: 5000 });

  await page.locator(".sleep-log-item").click();
  await expect(page.getByRole("heading", { name: "Endra søvn" })).toBeVisible();
  await expect(page.locator(".type-pill.active")).toContainText("Lur");
});

test("Can edit a sleep entry type", async ({ page }) => {
  seedBabyWithSleep();
  await page.goto("/#/history");
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
    "INSERT INTO sleep_log (baby_id, start_time, end_time, type, fall_asleep_time, notes, woke_by, wake_notes) VALUES (?, ?, ?, 'nap', '5-15', 'Roleg kveld', 'self', 'Glad ved oppvakning')",
  ).run(babyId, start, end);
  db.close();

  await page.goto("/#/history");
  await expect(page.locator(".sleep-log-item").first()).toBeVisible({ timeout: 5000 });

  const item = page.locator(".sleep-log-item").first();
  // Fall-asleep time should be formatted
  await expect(item).toContainText("5–15 min");
  // Notes visible
  await expect(item).toContainText("Roleg kveld");
  // Woke-by info visible
  await expect(item).toContainText("Vakna sjølv");
  // Wake notes visible
  await expect(item).toContainText("Glad ved oppvakning");
});

test("Can delete a sleep entry", async ({ page }) => {
  seedBabyWithSleep();
  await page.goto("/#/history");
  await expect(page.locator(".sleep-log-item")).toHaveCount(1, { timeout: 5000 });

  await page.locator(".sleep-log-item").click();
  // Click Slett in edit modal — opens custom confirm dialog
  await page.getByRole("button", { name: "Slett" }).first().click();
  // Click Slett in confirm dialog
  await page.locator(".modal-overlay").last().getByRole("button", { name: "Slett" }).click();

  await expect(page.getByText("Ingen oppføringar enno")).toBeVisible({ timeout: 5000 });
});
