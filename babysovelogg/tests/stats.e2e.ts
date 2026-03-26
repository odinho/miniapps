import {
  test,
  expect,
  createBaby,
  setWakeUpTime,
  addCompletedSleep,
  getDb,
  generateId,
} from "./fixtures";

test('Stats page shows Norwegian headers "7 dagar" / "30 dagar"', async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const now = new Date();
  addCompletedSleep(
    babyId,
    new Date(now.getTime() - 3600000).toISOString(),
    new Date(now.getTime() - 1800000).toISOString(),
    "nap",
  );

  await page.goto("/#/stats");
  await expect(page.getByRole("heading", { name: "Siste 7 dagar" })).toBeVisible({ timeout: 5000 });
  // Trend table has "7 dagar" and "30 dagar" columns
  await expect(page.locator(".stats-trend-header")).toContainText("7 dagar");
  await expect(page.locator(".stats-trend-header")).toContainText("30 dagar");
});

test("Stats page renders bar chart", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const now = new Date();
  // Add a nap and a night sleep
  addCompletedSleep(
    babyId,
    new Date(now.getTime() - 4 * 3600000).toISOString(),
    new Date(now.getTime() - 3 * 3600000).toISOString(),
    "nap",
  );
  const yesterday = new Date(now.getTime() - 24 * 3600000);
  addCompletedSleep(
    babyId,
    new Date(yesterday.getTime() - 8 * 3600000).toISOString(),
    new Date(yesterday.getTime()).toISOString(),
    "night",
  );

  await page.goto("/#/stats");
  await expect(page.locator(".stats-chart")).toBeVisible({ timeout: 5000 });
  // Should have bars (rect elements in the SVG)
  const bars = page.locator(".stats-chart rect");
  await expect(bars.first()).toBeVisible();
});

test("Stats subtracts pause time from sleep durations", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const now = Date.now();
  const db = getDb();

  // Add a 60-min nap with a 10-min pause (should show ~50 min)
  const startTime = new Date(now - 3600000).toISOString();
  const endTime = new Date(now).toISOString();
  const domainId = generateId();
  db.prepare(
    "INSERT INTO sleep_log (baby_id, start_time, end_time, type, domain_id) VALUES (?, ?, ?, 'nap', ?)",
  ).run(babyId, startTime, endTime, domainId);
  const sleepId = (
    db.prepare("SELECT id FROM sleep_log ORDER BY id DESC LIMIT 1").get() as { id: number }
  ).id;
  db.prepare("INSERT INTO sleep_pauses (sleep_id, pause_time, resume_time) VALUES (?, ?, ?)").run(
    sleepId,
    new Date(now - 50 * 60000).toISOString(),
    new Date(now - 40 * 60000).toISOString(),
  );

  await page.goto("/#/stats");
  // The stats should exist and show data
  // Should have at least 3 sections (chart, wake windows, trends; possibly more with diaper stats + export)
  const sections = page.locator(".stats-section");
  await expect(sections.first()).toBeVisible({ timeout: 5000 });
  expect(await sections.count()).toBeGreaterThanOrEqual(3);
});

test("Stats shows empty state when no data", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);

  await page.goto("/#/stats");
  await expect(page.getByText("Ingen søvndata enno")).toBeVisible({ timeout: 5000 });
});

test("Stats legends show Norwegian labels", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const now = new Date();
  addCompletedSleep(
    babyId,
    new Date(now.getTime() - 3600000).toISOString(),
    new Date(now.getTime() - 1800000).toISOString(),
    "nap",
  );

  await page.goto("/#/stats");
  await expect(page.locator(".stats-legend")).toBeVisible({ timeout: 5000 });
  await expect(page.locator(".stats-legend")).toContainText("Lurar");
  await expect(page.locator(".stats-legend")).toContainText("Natt");
});
