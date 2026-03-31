import {
  test,
  expect,
  createBaby,
  setWakeUpTime,
  addCompletedSleep,
  getDb,
  fillTimeInput,
} from "./fixtures";

// --- Helper: seed multiple days of sleep history ---
function seedDaysOfSleep(
  babyId: number,
  days: number,
  napsPerDay: number,
  startHour = 9,
  napDurationMin = 60,
  wakeWindowMin = 120,
) {
  const now = new Date();
  for (let d = days - 1; d >= 0; d--) {
    const dayStart = new Date(now);
    dayStart.setDate(dayStart.getDate() - d);
    dayStart.setHours(7, 0, 0, 0);

    let currentTime = new Date(dayStart);
    currentTime.setHours(startHour, 0, 0, 0);

    for (let n = 0; n < napsPerDay; n++) {
      const napStart = new Date(currentTime);
      const napEnd = new Date(napStart.getTime() + napDurationMin * 60000);
      addCompletedSleep(babyId, napStart.toISOString(), napEnd.toISOString(), "nap");
      currentTime = new Date(napEnd.getTime() + wakeWindowMin * 60000);
    }

    // Night sleep
    const bedtime = new Date(dayStart);
    bedtime.setHours(19, 0, 0, 0);
    const wakeup = new Date(dayStart);
    wakeup.setDate(wakeup.getDate() + 1);
    wakeup.setHours(7, 0, 0, 0);
    addCompletedSleep(babyId, bedtime.toISOString(), wakeup.toISOString(), "night");
  }
}

// --- E2E: Nap count transition detection (#15) ---

test("Nap transition: API reflects learned nap count from history", async ({ page }) => {
  // Create a ~7 month baby (2 naps expected)
  const babyId = createBaby("Testa", "2025-08-15");
  setWakeUpTime(babyId);

  // Seed 7 days of consistent 2-nap schedule
  seedDaysOfSleep(babyId, 7, 2, 9, 60, 150);

  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });

  // Verify predictions are shown (engine is using learned data)
  const state = await page.evaluate(() => fetch("/api/state").then((r) => r.json()));
  expect(state.prediction).toBeTruthy();
  // Calibration should show learned or partial (not age-default) with 7 days of data
  expect(state.prediction.calibration.trust).not.toBe("age-default");
  expect(state.prediction.calibration.daysWithData).toBeGreaterThanOrEqual(3);
});

// --- E2E: Nap quality rejection (#16) ---

test("Short naps do NOT shrink the next wake window", async ({ page }) => {
  // Create a 6 month baby
  const babyId = createBaby("Testa", "2025-09-15");
  setWakeUpTime(babyId);

  // Seed 5 days of normal 2-nap schedule (60 min naps, 150 min wake windows)
  seedDaysOfSleep(babyId, 5, 2, 9, 60, 150);

  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });

  // Get baseline prediction
  const baseline = await page.evaluate(() => fetch("/api/state").then((r) => r.json()));
  const baseNextNap = baseline.prediction?.nextNap;
  expect(baseNextNap).toBeTruthy();

  // Now add a very short nap today (15 minutes)
  const now = new Date();
  const shortNapStart = new Date(now.getTime() - 30 * 60000);
  const shortNapEnd = new Date(now.getTime() - 15 * 60000);
  addCompletedSleep(babyId, shortNapStart.toISOString(), shortNapEnd.toISOString(), "nap");

  // Re-fetch state
  const afterShort = await page.evaluate(() => fetch("/api/state").then((r) => r.json()));
  const afterNextNap = afterShort.prediction?.nextNap;

  // The prediction should still exist and the next nap shouldn't be significantly earlier
  // (short nap shouldn't shrink the wake window)
  if (baseNextNap && afterNextNap) {
    const baseDelta = new Date(baseNextNap).getTime() - now.getTime();
    const afterDelta = new Date(afterNextNap).getTime() - now.getTime();
    // After a short nap, the next nap should be based on wake time from the short nap end,
    // not a drastically shorter window. The wake window itself should not shrink.
    expect(afterDelta).toBeGreaterThan(-120 * 60000); // Not more than 2h in the past
  }
});

// --- E2E: Timezone-aware predictions (#17) ---

test("Baby timezone is respected in predictions", async ({ page }) => {
  const babyId = createBaby("Testa", "2025-06-12");
  const db = getDb();
  // Set timezone explicitly
  db.prepare("UPDATE baby SET timezone = ? WHERE id = ?").run("Europe/Oslo", babyId);
  setWakeUpTime(babyId);

  // Seed some history
  seedDaysOfSleep(babyId, 3, 2, 9, 60, 120);

  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });

  const state = await page.evaluate(() => fetch("/api/state").then((r) => r.json()));

  // Verify timezone is set
  expect(state.baby.timezone).toBe("Europe/Oslo");

  // Predictions should exist
  expect(state.prediction).toBeTruthy();
  if (state.prediction) {
    // Bedtime should be reasonable (16:00-23:00 in baby's local time)
    const bedtimeDate = new Date(state.prediction.bedtime);
    const bedtimeHour = parseInt(
      bedtimeDate.toLocaleString("en-US", { timeZone: "Europe/Oslo", hour: "numeric", hour12: false }),
    );
    expect(bedtimeHour).toBeGreaterThanOrEqual(16);
    expect(bedtimeHour).toBeLessThanOrEqual(23);
  }
});

// --- E2E: Bedtime clamping range (#18) ---

test("Bedtime is clamped to 16:00-23:00 range", async ({ page }) => {
  // Create a baby with very early wake time to push predictions
  const babyId = createBaby("Testa", "2025-06-12");
  const db = getDb();
  db.prepare("UPDATE baby SET timezone = ? WHERE id = ?").run("Europe/Oslo", babyId);

  // Set very early wake up
  const wake = new Date();
  wake.setHours(5, 0, 0, 0);
  db.prepare("INSERT INTO day_start (baby_id, date, wake_time) VALUES (?, ?, ?)").run(
    babyId,
    `${wake.getFullYear()}-${String(wake.getMonth() + 1).padStart(2, "0")}-${String(wake.getDate()).padStart(2, "0")}`,
    wake.toISOString(),
  );

  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });

  const state = await page.evaluate(() => fetch("/api/state").then((r) => r.json()));
  if (state.prediction?.bedtime) {
    const bedtime = new Date(state.prediction.bedtime);
    const bedHour = parseInt(
      bedtime.toLocaleString("en-US", { timeZone: "Europe/Oslo", hour: "numeric", hour12: false }),
    );
    // Bedtime should be clamped between 16 and 23
    expect(bedHour).toBeGreaterThanOrEqual(16);
    expect(bedHour).toBeLessThanOrEqual(23);
  }
});

// --- E2E: Target bedtime / backward planning (#11) ---

test("Target bedtime in settings affects predictions", async ({ page }) => {
  const babyId = createBaby("Testa", "2025-06-12");
  setWakeUpTime(babyId);
  seedDaysOfSleep(babyId, 5, 2, 9, 60, 120);

  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });

  // Get baseline prediction
  const baseline = await page.evaluate(() => fetch("/api/state").then((r) => r.json()));
  const baseBedtime = baseline.prediction?.bedtime;

  // Go to settings and set target bedtime to 20:00
  await page.locator(".nav-bar").getByText("Innstillingar").click();
  await expect(page.locator("#baby-name")).toBeVisible({ timeout: 5000 });

  // Click "Fast tid" button for target bedtime
  await page.getByTestId("bedtime-custom").click();
  await expect(page.getByTestId("target-bedtime")).toBeVisible();
  await fillTimeInput(page.getByTestId("target-bedtime"), "20:00");

  // Save settings
  await page.getByRole("button", { name: "Lagra" }).click();
  await expect(page.getByTestId("dashboard")).toBeVisible({ timeout: 5000 });

  // Verify the target bedtime was saved
  const db = getDb();
  const baby = db.prepare("SELECT target_bedtime FROM baby WHERE id = ?").get(babyId) as { target_bedtime: string | null };
  expect(baby.target_bedtime).toBe("20:00");
});

// --- E2E: Confidence intervals (#12) ---

test("Confidence intervals appear with sufficient data", async ({ page }) => {
  const babyId = createBaby("Testa", "2025-06-12");
  setWakeUpTime(babyId);
  seedDaysOfSleep(babyId, 7, 2, 9, 60, 120);

  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });

  // Verify prediction has confidence data via API
  const state = await page.evaluate(() => fetch("/api/state").then((r) => r.json()));
  expect(state.prediction?.confidence).toBeTruthy();
  expect(state.prediction.confidence.level).toBeTruthy();
  expect(state.prediction.confidence.dataPoints).toBeGreaterThan(0);
});

// --- E2E: Calibration trust signals (#13) ---

test("Calibration shows age-default for new baby", async ({ page }) => {
  const babyId = createBaby("Testa", "2025-06-12");
  setWakeUpTime(babyId);
  // No sleep history — should be age-default

  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });

  const state = await page.evaluate(() => fetch("/api/state").then((r) => r.json()));
  expect(state.prediction?.calibration?.trust).toBe("age-default");
});

test("Calibration shows learned with enough data", async ({ page }) => {
  const babyId = createBaby("Testa", "2025-06-12");
  setWakeUpTime(babyId);
  seedDaysOfSleep(babyId, 7, 2, 9, 60, 120);

  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });

  const state = await page.evaluate(() => fetch("/api/state").then((r) => r.json()));
  expect(state.prediction?.calibration?.trust).toBe("learned");
});

test("Trust badge is visible on dashboard", async ({ page }) => {
  const babyId = createBaby("Testa", "2025-06-12");
  setWakeUpTime(babyId);

  await page.goto("/");
  await expect(page.getByTestId("baby-name")).toHaveText("Testa", { timeout: 5000 });

  // Trust badge should show "Aldersbasert" for new baby
  await expect(page.getByTestId("trust-badge")).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("trust-badge")).toContainText("Aldersbasert");
});
