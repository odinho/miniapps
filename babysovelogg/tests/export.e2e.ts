import {
  test,
  expect,
  createBaby,
  setWakeUpTime,
  addCompletedSleep,
  addDiaper,
  forceMorning,
} from "./fixtures";

test.beforeEach(async ({ page }) => {
  await forceMorning(page);
});

test("Export JSON endpoint returns sleep and diaper data", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const now = new Date();
  addCompletedSleep(
    babyId,
    new Date(now.getTime() - 3600000).toISOString(),
    new Date(now.getTime() - 1800000).toISOString(),
    "nap",
  );
  addDiaper(babyId, now.toISOString(), "wet", "middels");

  const res = await page.request.get("/api/export");
  expect(res.ok()).toBeTruthy();
  const data = await res.json();
  expect(data.baby).toBeTruthy();
  expect(data.baby.name).toBe("Testa");
  expect(data.sleeps.length).toBe(1);
  expect(data.diapers.length).toBe(1);
  expect(data.dayStarts.length).toBe(1);
});

test("Export CSV endpoint returns valid CSV", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const now = new Date();
  addCompletedSleep(
    babyId,
    new Date(now.getTime() - 3600000).toISOString(),
    new Date(now.getTime() - 1800000).toISOString(),
    "nap",
  );

  const res = await page.request.get("/api/export?format=csv");
  expect(res.ok()).toBeTruthy();
  const contentType = res.headers()["content-type"];
  expect(contentType).toContain("text/csv");
  const body = await res.text();
  expect(body).toContain("type,start,end,sleep_type,mood,method,notes");
  expect(body).toContain("sleep,");
});

test("Export returns 404 when no baby", async ({ page }) => {
  const res = await page.request.get("/api/export");
  expect(res.status()).toBe(404);
});

test("Stats page shows export buttons", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const now = new Date();
  addCompletedSleep(
    babyId,
    new Date(now.getTime() - 3600000).toISOString(),
    now.toISOString(),
    "nap",
  );

  await page.goto("/#/stats");
  await expect(page.getByTestId("export-btn")).toBeVisible({ timeout: 5000 });
});
