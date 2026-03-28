import {
  test,
  expect,
  createBaby,
  getDb,
  forceHour,
  addCompletedSleep,
  setWakeUpTime,
  generateId,
} from "./fixtures";
import { renderDayState } from "./helpers/render-state";

// --- B11: Dashboard shows overtime when a nap is skipped ---
// When the predicted nap window has passed without a nap being logged,
// the dashboard should show "Overtid" (overtime), not silently jump to bedtime.

test("B11: shows overtime when predicted nap time has passed", async ({ page }) => {
  const babyId = createBaby("Testa"); // birthdate 2025-06-12 → ~9 months old
  const db = getDb();

  // Set custom_nap_count = 1 so prediction expects exactly 1 nap
  db.prepare("UPDATE baby SET custom_nap_count = 1 WHERE id = ?").run(babyId);

  // Set wake time to very early today so the predicted nap is guaranteed in the past.
  // For a 9-month-old: WW ≈ 180 min. Wake at 01:00 → predicted nap at ~04:00.
  // By the time this test runs (any time after 05:00), the nap will be overdue.
  const today = new Date();
  today.setHours(1, 0, 0, 0);
  const dateStr = today.toISOString().split("T")[0];
  db.prepare("INSERT INTO day_start (baby_id, date, wake_time) VALUES (?, ?, ?)").run(
    babyId,
    dateStr,
    today.toISOString(),
  );

  // Force browser to 10 AM — well past the predicted nap, but not evening
  await forceHour(page, 10);

  await page.goto("/");
  await expect(page.getByTestId("dashboard")).toBeVisible({ timeout: 5000 });

  // Should show "Overtid" (overtime), not "Leggetid om" (bedtime countdown)
  await expect(page.locator(".arc-center-label")).toContainText("Overtid", { timeout: 5000 });
});

// --- B11 complement: when all naps are done, show bedtime (not overtime) ---

test("B11: shows bedtime when all expected naps are completed", async ({ page }) => {
  const babyId = createBaby("Testa");
  const db = getDb();

  db.prepare("UPDATE baby SET custom_nap_count = 1 WHERE id = ?").run(babyId);

  const today = new Date();
  today.setHours(6, 0, 0, 0);
  const dateStr = today.toISOString().split("T")[0];
  db.prepare("INSERT INTO day_start (baby_id, date, wake_time) VALUES (?, ?, ?)").run(
    babyId,
    dateStr,
    today.toISOString(),
  );

  // Add a completed nap — fulfills the expected 1 nap
  const napStart = new Date(today);
  napStart.setHours(9, 0, 0, 0);
  const napEnd = new Date(today);
  napEnd.setHours(10, 0, 0, 0);
  db.prepare(
    "INSERT INTO sleep_log (baby_id, start_time, end_time, type, domain_id) VALUES (?, ?, ?, 'nap', ?)",
  ).run(babyId, napStart.toISOString(), napEnd.toISOString(), generateId());

  await forceHour(page, 14);
  await page.goto("/");
  await expect(page.getByTestId("dashboard")).toBeVisible({ timeout: 5000 });

  // With 1 nap done and custom_nap_count = 1, should show bedtime, not overtime
  const centerLabel = page.locator(".arc-center-label");
  await expect(centerLabel).toBeVisible({ timeout: 5000 });
  const text = await centerLabel.textContent();
  expect(text).toMatch(/Leggetid|Neste|leggetid/);
});

// --- B17: Moon/morning button context at night ---
// At 18:01 (just after bedtime), the "☀️ Morgon" button should NOT be shown.
// It should only appear in the small hours (4-5 AM) when morning is plausible.

test("B17: morning button not shown in early night hours", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  // Add a completed nap so the dashboard has something to show
  const napStart = new Date();
  napStart.setHours(9, 0, 0, 0);
  const napEnd = new Date();
  napEnd.setHours(10, 0, 0, 0);
  addCompletedSleep(babyId, napStart.toISOString(), napEnd.toISOString());

  // Force browser to 19:00 — just after bedtime, in night mode
  await forceHour(page, 19);
  await page.goto("/");
  await expect(page.getByTestId("dashboard")).toBeVisible({ timeout: 5000 });

  // The "☀️ Morgon" button should NOT be visible at 19:00
  await expect(page.locator(".arc-action-btn.morning")).not.toBeVisible({ timeout: 3000 });
});

// --- B15: Editing a nap to become a night sleep should NOT delete the entry ---

test("B15: changing sleep type from nap to night preserves the entry", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const napStart = new Date();
  napStart.setHours(9, 0, 0, 0);
  const napEnd = new Date();
  napEnd.setHours(10, 0, 0, 0);
  addCompletedSleep(babyId, napStart.toISOString(), napEnd.toISOString());

  await page.goto("/history");
  const sleepItems = page.locator(".sleep-log-item:not(.wakeup-log-item):not(.diaper-log-item)");
  await expect(sleepItems).toHaveCount(1, { timeout: 5000 });
  await expect(sleepItems.locator(".log-meta").first()).toContainText("Lur");

  // Click to edit
  await sleepItems.first().click();
  await expect(page.getByRole("heading", { name: "Endra søvn" })).toBeVisible();

  // Change type to night
  await page.locator(".type-pill", { hasText: "Natt" }).click();
  await page.getByRole("button", { name: "Lagra" }).click();

  await expect(page.getByRole("heading", { name: "Endra søvn" })).not.toBeVisible({ timeout: 3000 });

  // The entry should still exist, now showing as night sleep
  await expect(sleepItems).toHaveCount(1);
  await expect(sleepItems.locator(".log-meta").first()).toContainText("Nattesøvn");
});

test("B17: morning button IS shown in late night hours", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  // Force browser to 5 AM — morning is plausible
  await forceHour(page, 5);
  await page.goto("/");
  await expect(page.getByTestId("dashboard")).toBeVisible({ timeout: 5000 });

  // At 5 AM the morning button should be visible
  await expect(page.locator(".arc-action-btn.morning")).toBeVisible({ timeout: 3000 });
});

// --- B18: Ending a night sleep should auto-create wakeup ---
// When the user ends a night sleep, that IS the morning. The app should automatically
// create a day.started event so the morning prompt does NOT re-appear.

test("B18: ending night sleep auto-sets wakeup, no morning prompt", async ({ page }) => {
  const babyId = createBaby("Testa");
  const db = getDb();
  // Set yesterday's wakeup (so baby has a "previous day")
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(7, 0, 0, 0);
  const yesterdayDate = yesterday.toISOString().split("T")[0];
  db.prepare("INSERT INTO day_start (baby_id, date, wake_time) VALUES (?, ?, ?)").run(
    babyId,
    yesterdayDate,
    yesterday.toISOString(),
  );

  // Create an active night sleep that started yesterday evening
  const nightStart = new Date();
  nightStart.setDate(nightStart.getDate() - 1);
  nightStart.setHours(18, 30, 0, 0);
  const domainId = generateId();
  db.prepare(
    "INSERT INTO sleep_log (baby_id, start_time, type, domain_id) VALUES (?, ?, 'night', ?)",
  ).run(babyId, nightStart.toISOString(), domainId);

  await forceHour(page, 6);
  await page.goto("/");
  await expect(page.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 5000 });

  // End the night sleep by clicking the sleep button
  await page.getByTestId("sleep-button").click();

  // Dismiss the wake-up sheet
  const overlay = page.getByTestId("modal-overlay");
  try {
    await overlay.waitFor({ state: "visible", timeout: 3000 });
    await page.getByRole("button", { name: "Ferdig" }).click();
    await overlay.waitFor({ state: "hidden", timeout: 3000 });
  } catch {}

  // Dashboard should be visible — NOT the morning prompt
  await expect(page.getByTestId("dashboard")).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("morning-prompt")).not.toBeVisible();

  // Verify a day_start was created for today (yesterday's + today's = 2)
  expect(renderDayState(db, babyId)).toContain("vekketid:");
  const dayStarts = db.prepare("SELECT COUNT(*) as c FROM day_start WHERE baby_id = ?").get(babyId) as { c: number };
  expect(dayStarts.c).toBe(2);
});

// --- B19: Settings prediction shows all naps and reacts to nap count change ---

test("B19: settings shows all predicted nap times", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  // Default nap count for 9 months = 2
  await page.goto("/settings");
  await expect(page.getByText("Appen reknar med")).toBeVisible({ timeout: 5000 });

  // Should show "Lur 1" and "Lur 2" (two predicted naps)
  const predPanel = page.getByTestId("pred-panel");
  await expect(predPanel).toContainText("Lur 1");
  await expect(predPanel).toContainText("Lur 2");
});

test("B19: settings prediction updates reactively when changing nap count", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  await page.goto("/settings");
  await expect(page.getByText("Appen reknar med")).toBeVisible({ timeout: 5000 });

  const predPanel = page.getByTestId("pred-panel");

  // Initially auto = 2 naps for 9 months
  await expect(predPanel).toContainText("Lur 2");

  // Change to 1 nap
  await page.locator(".type-pill", { hasText: "1" }).first().click();

  // Should now show only "Lur 1", not "Lur 2"
  await expect(predPanel).toContainText("Lur 1");
  await expect(predPanel).not.toContainText("Lur 2");

  // And "0 av 1" expected naps
  await expect(predPanel).toContainText("0 av 1");
});

// --- B5: Diaper poop type visible in history ---

test("B5: dirty diaper shows type in history log", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const db = getDb();
  db.prepare(
    "INSERT INTO diaper_log (baby_id, time, type, amount, domain_id) VALUES (?, ?, 'dirty', 'middels', ?)",
  ).run(babyId, new Date().toISOString(), generateId());

  await page.goto("/history");
  const diaperItem = page.locator(".diaper-log-item").first();
  await expect(diaperItem).toBeVisible({ timeout: 5000 });
  // Should show the type label "Skitten", not just "Do" or "Bleie"
  await expect(diaperItem.locator(".log-meta")).toContainText("Skitten");
});

// --- B6: Diaper notes visible in history ---

test("B6: diaper notes are visible in history log", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const db = getDb();
  db.prepare(
    "INSERT INTO diaper_log (baby_id, time, type, amount, note, domain_id) VALUES (?, ?, 'wet', 'middels', 'Litt raudt utslett', ?)",
  ).run(babyId, new Date().toISOString(), generateId());

  await page.goto("/history");
  const diaperItem = page.locator(".diaper-log-item").first();
  await expect(diaperItem).toBeVisible({ timeout: 5000 });
  await expect(diaperItem).toContainText("Litt raudt utslett");
});

// --- B12: Wakeup time visible in log ---

test("B12: wakeup time appears as entry in history", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  await page.goto("/history");
  const wakeupItem = page.locator(".wakeup-log-item").first();
  await expect(wakeupItem).toBeVisible({ timeout: 5000 });
  await expect(wakeupItem).toContainText("07:00");
  await expect(wakeupItem).toContainText("Vakna");
});
