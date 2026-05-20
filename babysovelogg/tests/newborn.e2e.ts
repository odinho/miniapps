import {
  test,
  expect,
  createBaby,
  setWakeUpTime,
  addCompletedSleep,
} from "./fixtures";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a baby born N weeks ago. */
function newbornBirthdate(weeksAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - weeksAgo * 7);
  return d.toISOString().split("T")[0];
}

/** Seed newborn-style sleep: many short episodes across 24h. */
function seedNewbornHistory(babyId: number, days: number) {
  const now = new Date();
  for (let d = days; d >= 1; d--) {
    const day = new Date(now);
    day.setDate(day.getDate() - d);

    // 6-8 episodes per day, spread across 24h
    const episodes = [
      { startH: 1, durMin: 150, type: "night" },  // 01:00–03:30
      { startH: 4, durMin: 105, type: "nap" },     // 04:00–05:45
      { startH: 7, durMin: 90, type: "nap" },      // 07:00–08:30
      { startH: 9, durMin: 75, type: "nap" },      // 09:30–10:45
      { startH: 12, durMin: 75, type: "nap" },     // 12:00–13:15
      { startH: 14, durMin: 60, type: "nap" },     // 14:30–15:30
      { startH: 17, durMin: 90, type: "nap" },     // 17:00–18:30
      { startH: 20, durMin: 180, type: "night" },  // 20:00–23:00
    ];

    for (const ep of episodes) {
      const start = new Date(day);
      start.setHours(ep.startH, ep.startH === 9 ? 30 : 0, 0, 0);
      const end = new Date(start.getTime() + ep.durMin * 60_000);
      addCompletedSleep(babyId, start.toISOString(), end.toISOString(), ep.type);
    }
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("Newborn baby gets newborn_guidance strategy", async ({ page }) => {
  const babyId = createBaby("Vesle", newbornBirthdate(2));
  seedNewbornHistory(babyId, 5);
  setWakeUpTime(babyId);

  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Vesle", { timeout: 5000 });

  const state = await page.evaluate(() => fetch("/api/state").then((r) => r.json()));
  expect(state.prediction.strategy).toBe("newborn_guidance");
});

test("Newborn dashboard shows context card instead of trust badge", async ({ page }) => {
  const babyId = createBaby("Vesle", newbornBirthdate(3));
  seedNewbornHistory(babyId, 5);
  setWakeUpTime(babyId);

  await page.goto("/");
  await expect(page.getByTestId("dashboard")).toBeVisible({ timeout: 5000 });

  // Context card should be visible
  await expect(page.getByTestId("context-card")).toBeVisible({ timeout: 5000 });

  // Trust badge should NOT be visible (newborn doesn't show calibration)
  await expect(page.getByTestId("trust-badge")).not.toBeVisible();

  // Population norms section should NOT be visible (replaced by context card)
  await expect(page.getByTestId("population-norms")).not.toBeVisible();
});

test("Newborn context card shows sleep stats and guidance", async ({ page }) => {
  const babyId = createBaby("Vesle", newbornBirthdate(2));
  seedNewbornHistory(babyId, 5);
  setWakeUpTime(babyId);

  await page.goto("/");
  const card = page.getByTestId("context-card");
  await expect(card).toBeVisible({ timeout: 5000 });
  // ContextCard collapses by default; expand it to read the inner rows.
  // The card header is a button (`aria-expanded` flips on click).
  await card.getByRole("button").first().click();

  // Context card should have guidance text
  const guidanceText = page.getByTestId("guidance-text");
  await expect(guidanceText).toBeVisible();
  // Should mention that irregular sleep is normal (Nynorsk)
  await expect(guidanceText).toContainText("normalt");

  // Should show normality assessment
  await expect(page.getByTestId("normality-text")).toBeVisible();
});

test("Newborn prediction has sleep window, not nap times", async ({ page }) => {
  const babyId = createBaby("Vesle", newbornBirthdate(2));
  seedNewbornHistory(babyId, 5);
  setWakeUpTime(babyId);

  await page.goto("/");
  await expect(page.getByTestId("dashboard")).toBeVisible({ timeout: 5000 });

  const state = await page.evaluate(() => fetch("/api/state").then((r) => r.json()));
  const pred = state.prediction;

  // Should have newborn fields
  expect(pred.sleepWindow).toBeTruthy();
  expect(pred.sleepPressure).toBeTruthy();
  expect(pred.totalSleep24h).toBeGreaterThan(0);
  expect(pred.longestStretch).toBeGreaterThan(0);
  expect(pred.ageNorms).toBeTruthy();

  // Should NOT have schedule fields
  expect(pred.nextNap).toBeNull();
  expect(pred.bedtime).toBeNull();
  expect(pred.predictedNaps).toBeNull();
  expect(pred.confidence).toBeNull();
});

test("Newborn arc does not show bedtime endpoint", async ({ page }) => {
  const babyId = createBaby("Vesle", newbornBirthdate(2));
  seedNewbornHistory(babyId, 5);
  setWakeUpTime(babyId);

  await page.goto("/");
  await expect(page.getByTestId("dashboard")).toBeVisible({ timeout: 5000 });

  // The arc should not have a bedtime ghost bubble
  // (No predicted nap or bedtime arcs should be visible)
  const predicted = page.locator('[data-status="predicted"]');
  await expect(predicted).toHaveCount(0);
});

test("Newborn timer shows sleep window mode", async ({ page }) => {
  const babyId = createBaby("Vesle", newbornBirthdate(2));
  seedNewbornHistory(babyId, 5);
  setWakeUpTime(babyId);

  // Add a completed sleep ending 20 min ago (should show rising pressure)
  const recentEnd = new Date(Date.now() - 20 * 60_000);
  const recentStart = new Date(recentEnd.getTime() - 60 * 60_000);
  addCompletedSleep(babyId, recentStart.toISOString(), recentEnd.toISOString(), "nap");

  await page.goto("/");
  await expect(page.getByTestId("dashboard")).toBeVisible({ timeout: 5000 });

  // Timer should show sleep window text (Nynorsk: "Søvnvindauge")
  const centerLabel = page.locator(".arc-center-label");
  await expect(centerLabel).toBeVisible({ timeout: 5000 });
  const text = await centerLabel.textContent();
  expect(text).toContain("Søvnvindauge");
});

test("Older baby with schedule history gets routine_schedule", async ({ page }) => {
  // Contrast test: 8-month baby with good data should NOT be newborn
  const babyId = createBaby("Stor", "2025-08-01");

  // Seed schedule-like history
  const now = new Date();
  for (let d = 14; d >= 1; d--) {
    const day = new Date(now);
    day.setDate(day.getDate() - d);
    const nap1Start = new Date(day); nap1Start.setHours(9, 30, 0, 0);
    const nap1End = new Date(day); nap1End.setHours(11, 0, 0, 0);
    const nap2Start = new Date(day); nap2Start.setHours(14, 0, 0, 0);
    const nap2End = new Date(day); nap2End.setHours(15, 30, 0, 0);
    const nightStart = new Date(day); nightStart.setHours(19, 30, 0, 0);
    const nightEnd = new Date(day); nightEnd.setDate(nightEnd.getDate() + 1); nightEnd.setHours(6, 30, 0, 0);
    addCompletedSleep(babyId, nap1Start.toISOString(), nap1End.toISOString(), "nap");
    addCompletedSleep(babyId, nap2Start.toISOString(), nap2End.toISOString(), "nap");
    addCompletedSleep(babyId, nightStart.toISOString(), nightEnd.toISOString(), "night");
  }
  setWakeUpTime(babyId);

  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Stor", { timeout: 5000 });

  const state = await page.evaluate(() => fetch("/api/state").then((r) => r.json()));
  expect(state.prediction.strategy).toBe("routine_schedule");

  // Should NOT show context card (that's for newborn/emerging)
  await expect(page.getByTestId("context-card")).not.toBeVisible();
});
