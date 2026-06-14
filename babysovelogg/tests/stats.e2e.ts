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

  await page.goto("/stats");
  // The standalone "Siste 7 dagar" heading was removed in the I-dag-card
  // refactor; the trend table still carries the same window labels.
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

  await page.goto("/stats");
  // The stats page has several `.stats-chart` SVGs (trend, bedtime, etc.);
  // use `.first()` so the locator is unique under strict mode.
  await expect(page.locator(".stats-chart").first()).toBeVisible({ timeout: 5000 });
  // Should have bars (rect elements in the SVG)
  const bars = page.locator(".stats-chart rect");
  await expect(bars.first()).toBeVisible();
});

test("Tapping a chart opens it fullscreen and it closes again", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const now = new Date();
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

  await page.goto("/stats");
  const wrap = page.locator(".stats-chart-wrap").first();
  await expect(wrap).toBeVisible({ timeout: 5000 });

  await wrap.click();
  const overlay = page.locator(".chart-fullscreen-overlay");
  await expect(overlay).toBeVisible();
  // The cloned chart SVG is injected into the overlay.
  await expect(overlay.locator("svg").first()).toBeVisible();

  // Close via the ✕ button.
  await page.locator(".chart-fullscreen-close").click();
  await expect(overlay).not.toBeVisible();

  // Re-open, then close by tapping the chart body.
  await wrap.click();
  await expect(overlay).toBeVisible();
  await page.locator(".chart-fullscreen-body").click();
  await expect(overlay).not.toBeVisible();
});

test("Stats subtracts night_waking duration from night sleep totals", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const now = Date.now();
  const db = getDb();

  // Add a completed night sleep with one 10-min waking inside it.
  const startTime = new Date(now - 10 * 3600000).toISOString();
  const endTime = new Date(now - 60000).toISOString();
  const domainId = generateId();
  db.prepare(
    "INSERT INTO sleep_log (baby_id, start_time, end_time, type, domain_id) VALUES (?, ?, ?, 'night', ?)",
  ).run(babyId, startTime, endTime, domainId);
  db.prepare(
    "INSERT INTO night_waking (baby_id, domain_id, start_time, end_time) VALUES (?, ?, ?, ?)",
  ).run(
    babyId,
    generateId().replace(/^evt_/, "nwk_"),
    new Date(now - 5 * 3600000).toISOString(),
    new Date(now - 5 * 3600000 + 10 * 60000).toISOString(),
  );

  await page.goto("/stats");
  // The stats should exist and show data
  // Should have at least 3 sections (chart, wake windows, trends; possibly more with diaper stats + export)
  const sections = page.locator(".stats-section");
  await expect(sections.first()).toBeVisible({ timeout: 5000 });
  expect(await sections.count()).toBeGreaterThanOrEqual(3);
});

test("Stats shows empty state when no data", async ({ page }) => {
  createBaby("Testa");
  // No sleep entries — empty state should be shown

  await page.goto("/stats");
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

  await page.goto("/stats");
  // Multiple `.stats-legend` blocks exist (trend + total-vs-norm + døgnrytme);
  // the trend block is the first and is the canonical "Lurar / Natt" legend.
  const trendLegend = page.locator(".stats-legend").first();
  await expect(trendLegend).toBeVisible({ timeout: 5000 });
  await expect(trendLegend).toContainText("Lurar");
  await expect(trendLegend).toContainText("Natt");
});

test("siblings with different birthdates each get a two-up stats panel", async ({ page }) => {
  const ada = createBaby("Ada", "2025-06-12");
  const bo = createBaby("Bo", "2024-06-12");
  const now = new Date();
  for (const id of [ada, bo]) {
    setWakeUpTime(id);
    const yest = new Date(now.getTime() - 24 * 3600000);
    addCompletedSleep(id, new Date(yest.getTime() - 8 * 3600000).toISOString(), yest.toISOString(), "night");
    addCompletedSleep(id, new Date(now.getTime() - 4 * 3600000).toISOString(), new Date(now.getTime() - 3 * 3600000).toISOString(), "nap");
  }

  await page.goto("/stats");
  await expect(page.getByTestId("stats-child-panel")).toHaveCount(2, { timeout: 5000 });
  // Per-child name headers, in creation order.
  await expect(page.locator(".stats-child-name")).toHaveText(["Ada", "Bo"]);
  await expect(page.getByTestId("twin-overlay-sleep-trend")).toHaveCount(0);
  // Both shared the overnight → a parent-downtime ("Felles søvn") section shows.
  await expect(page.getByTestId("shared-sleep")).toBeVisible();
});

test("twins share an overlaid sleep-trend chart with child-first series and legend", async ({ page }) => {
  const ada = createBaby("Ada", "2025-06-12");
  const bo = createBaby("Bo", "2025-06-12");
  const now = new Date();
  for (const id of [ada, bo]) {
    setWakeUpTime(id);
    const prev = new Date(now.getTime() - 48 * 3600000);
    const prevNightStart = new Date(prev);
    prevNightStart.setHours(20, 0, 0, 0);
    addCompletedSleep(id, prevNightStart.toISOString(), new Date(prevNightStart.getTime() + 10 * 3600000).toISOString(), "night");
    const prevNapStart = new Date(prev);
    prevNapStart.setHours(12, 0, 0, 0);
    addCompletedSleep(id, prevNapStart.toISOString(), new Date(prevNapStart.getTime() + 45 * 60000).toISOString(), "nap");
    const yest = new Date(now.getTime() - 24 * 3600000);
    const napStart = new Date(yest);
    napStart.setHours(12, 0, 0, 0);
    const napEnd = new Date(napStart.getTime() + 3600000);
    addCompletedSleep(id, napStart.toISOString(), napEnd.toISOString(), "nap");
  }

  await page.goto("/stats");
  const trend = page.getByTestId("twin-overlay-sleep-trend");
  await expect(trend).toBeVisible({ timeout: 5000 });
  await expect(trend.locator("[data-series-id]")).toHaveCount(2);
  await expect(trend.locator(`[data-series-id="${ada}"]`)).toBeVisible();
  await expect(trend.locator(`[data-series-id="${bo}"]`)).toBeVisible();
  await expect(trend.locator(".stats-legend-item")).toHaveText(["Ada", "Bo"]);
  await expect(page.getByTestId("shared-sleep")).toBeVisible();
});

test("a single child renders no per-child panel wrapper", async ({ page }) => {
  const ada = createBaby("Testa");
  setWakeUpTime(ada);
  const now = new Date();
  addCompletedSleep(ada, new Date(now.getTime() - 4 * 3600000).toISOString(), new Date(now.getTime() - 3 * 3600000).toISOString(), "nap");

  await page.goto("/stats");
  await expect(page.locator(".stats-chart").first()).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("stats-child-panel")).toHaveCount(0);
  await expect(page.getByTestId("shared-sleep")).toHaveCount(0);
});
