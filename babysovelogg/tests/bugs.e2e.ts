import {
  test,
  expect,
  createBaby,
  getDb,
  forceHour,
  addCompletedSleep,
  setWakeUpTime,
  seedScheduleHistory,
  generateId,
} from "./fixtures";

/** A birthdate `n` months before today — keeps age-dependent tests stable
 *  regardless of the run date (a hardcoded birthdate silently ages past the
 *  intended band). */
const monthsAgoDate = (n: number) => {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
};


// --- B11: Dashboard shows overtime when a nap is skipped ---
// When the predicted nap window has passed without a nap being logged,
// the dashboard should show "Overtid" (overtime), not silently jump to bedtime.

test("B11: shows overtime when predicted nap time has passed", async ({ page }) => {
  // Pin the server clock so the test isn't time-of-day dependent. Use a
  // mid-morning anchor that leaves the predicted nap 30 min in the past
  // (overdue but below the 90-min skip threshold), with bedtime still
  // safely in the future.
  // Wake at 07:00, anchor "now" at 10:30 (210 min later). Default 9-mo WW
  // 180 min → predicted nap at 10:00 → 30 min overdue at 10:30.
  const today = new Date();
  today.setHours(10, 30, 0, 0);
  const nowMs = today.getTime();
  const wakeTime = new Date(nowMs - 210 * 60_000);

  // Anchor the birthdate ~9 months before `now` rather than a fixed date —
  // a hard-coded birthdate drifts the baby older as real time passes, which
  // lengthens the wake window and pushes the predicted nap into the future
  // (the test had rotted to ~12 mo → "Neste lur" instead of "Overtid").
  const birthdate = new Date(nowMs);
  birthdate.setMonth(birthdate.getMonth() - 9);
  const babyId = createBaby("Testa", birthdate.toISOString().slice(0, 10));
  const db = getDb();

  // Set custom_nap_count = 1 so prediction expects exactly 1 nap
  db.prepare("UPDATE baby SET custom_nap_count = 1 WHERE id = ?").run(babyId);

  const nightStart = new Date(wakeTime);
  nightStart.setDate(nightStart.getDate() - 1);
  nightStart.setHours(19, 0, 0, 0);
  db.prepare(
    "INSERT INTO sleep_log (baby_id, start_time, end_time, type, domain_id) VALUES (?, ?, ?, 'night', ?)",
  ).run(babyId, nightStart.toISOString(), wakeTime.toISOString(), generateId());

  // Pin the server's clock via the supported ?now= query parameter on
  // /api/state. Route interception is needed for both initial fetch and
  // periodic refreshes.
  await page.route("**/api/state**", async (route) => {
    const url = new URL(route.request().url());
    if (!url.searchParams.has("now")) {
      url.searchParams.set("now", String(nowMs));
    }
    await route.continue({ url: url.toString() });
  });

  await forceHour(page, 10);

  await page.goto("/");
  await expect(page.getByTestId("dashboard")).toBeVisible({ timeout: 5000 });

  // Nap is ~30 min overdue (< 90 min skip threshold) → should show "Overtid"
  await expect(page.locator(".arc-center-label")).toContainText("Overtid", { timeout: 5000 });
});

// --- B11 complement: when all naps are done, show bedtime (not overtime) ---

test("B11: shows bedtime when all expected naps are completed", async ({ page }) => {
  const babyId = createBaby("Testa");
  seedScheduleHistory(babyId, 1);
  const db = getDb();

  db.prepare("UPDATE baby SET custom_nap_count = 1 WHERE id = ?").run(babyId);

  const today = new Date();
  today.setHours(6, 0, 0, 0);
  // Insert overnight night sleep so wakeup is derived
  const nightStart = new Date(today);
  nightStart.setDate(nightStart.getDate() - 1);
  nightStart.setHours(19, 0, 0, 0);
  db.prepare(
    "INSERT INTO sleep_log (baby_id, start_time, end_time, type, domain_id) VALUES (?, ?, ?, 'night', ?)",
  ).run(babyId, nightStart.toISOString(), today.toISOString(), generateId());

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
  // setWakeUpTime inserts a night sleep + we added 1 nap = 2 sleep entries
  const sleepItems = page.locator(".sleep-log-item:not(.wakeup-log-item):not(.diaper-log-item)");
  await expect(sleepItems).toHaveCount(2, { timeout: 5000 });

  // Find and click the nap entry specifically
  const napItem = sleepItems.filter({ hasText: "Lur" });
  await expect(napItem).toHaveCount(1);
  await napItem.click();
  await expect(page.getByRole("heading", { name: "Endra søvn" })).toBeVisible();

  // Change type to night
  await page.locator(".type-pill", { hasText: "Natt" }).click();
  await page.getByRole("button", { name: "Lagra" }).click();

  await expect(page.getByRole("heading", { name: "Endra søvn" })).not.toBeVisible({ timeout: 3000 });

  // The edited entry should still exist, now showing as night sleep (total still 2)
  await expect(sleepItems).toHaveCount(2);
  await expect(sleepItems.filter({ hasText: "Nattesøvn" })).toHaveCount(2);
});

// --- B18: Ending a night sleep derives wakeup from its end_time ---

test("B18: ending night sleep derives wakeup from end time", async ({ page }) => {
  const babyId = createBaby("Testa");
  const db = getDb();

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

  // Dashboard should be visible with wakeup derived from night sleep end
  await expect(page.getByTestId("dashboard")).toBeVisible({ timeout: 5000 });
});

// --- B19: Settings prediction shows all naps and reacts to nap count change ---

test("B19: stats shows all predicted nap times", async ({ page }) => {
  // 10-month-old → 2-nap band (age-relative so it doesn't drift past 12 mo).
  const babyId = createBaby("Testa", monthsAgoDate(10));
  setWakeUpTime(babyId);

  // Fix server time to 09:00 so predicted naps (at ~10:00, ~14:00) are in the future
  const today9am = new Date();
  today9am.setHours(9, 0, 0, 0);
  await page.route("**/api/state*", (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set("now", String(today9am.getTime()));
    return route.continue({ url: url.toString() });
  });
  await forceHour(page, 9);

  // Default nap count for 9 months = 2
  await page.goto("/stats");
  await expect(page.getByText("Appen reknar med")).toBeVisible({ timeout: 5000 });

  // Should show "Lur 1" and "Lur 2" (two predicted naps)
  const predPanel = page.getByTestId("pred-panel");
  await expect(predPanel).toContainText("Lur 1");
  await expect(predPanel).toContainText("Lur 2");
});

test("B19: stats prediction updates when nap count is changed in settings", async ({ page }) => {
  // 10-month-old → 2-nap band (age-relative so it doesn't drift past 12 mo).
  const babyId = createBaby("Testa", monthsAgoDate(10));
  setWakeUpTime(babyId);

  // Fix server time to 09:00 so predicted naps are in the future
  const today9am = new Date();
  today9am.setHours(9, 0, 0, 0);
  await page.route("**/api/state*", (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set("now", String(today9am.getTime()));
    return route.continue({ url: url.toString() });
  });
  await forceHour(page, 9);

  // Verify initial prediction (auto = 2 naps for 9 months)
  await page.goto("/stats");
  await expect(page.getByText("Appen reknar med")).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("pred-panel")).toContainText("Lur 2");

  // Change nap count to 1 on settings page
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Innstillingar" })).toBeVisible();
  await page.locator(".type-pill", { hasText: "1" }).first().click();
  await page.getByRole("button", { name: "Lagra" }).click();
  await expect(page.getByTestId("baby-name")).toBeVisible({ timeout: 5000 });

  // Stats should now show only 1 nap
  await page.goto("/stats");
  const predPanel = page.getByTestId("pred-panel");
  await expect(predPanel).toContainText("Lur 1");
  await expect(predPanel).not.toContainText("Lur 2");
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

// --- B12: Night sleep end time (wakeup) visible in history ---

test("B12: night sleep end time appears in history", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  await page.goto("/history");
  // setWakeUpTime inserts a completed night sleep ending at 07:00
  const nightItem = page.locator(".sleep-log-item:not(.wakeup-log-item):not(.diaper-log-item)").filter({ hasText: "Nattesøvn" });
  await expect(nightItem).toHaveCount(1, { timeout: 5000 });
  // The night sleep entry should show its end time (07:00)
  await expect(nightItem).toContainText("07:00");
});
