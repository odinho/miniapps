import {
  test,
  expect,
  createBaby,
  setWakeUpTime,
  getDb,
  dismissSheet,
  generateId,
} from "./fixtures";
import type { SleepPauseRow } from "../types";

test("Pause button appears when sleeping", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  await page.goto("/");
  await expect(page.getByTestId("sleep-button")).toHaveClass(/awake/);
  await expect(page.getByTestId("pause-btn")).not.toBeVisible();

  await page.getByTestId("sleep-button").click();
  await expect(page.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 5000 });
  // Dismiss bedtime tag sheet to access pause button
  await dismissSheet(page);
  await expect(page.getByTestId("pause-btn")).toBeVisible();
  await expect(page.getByTestId("pause-btn")).toContainText("Pause");
});

test("Can pause and resume", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  await page.goto("/");

  await page.getByTestId("sleep-button").click();
  await expect(page.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 5000 });
  await dismissSheet(page);

  await page.getByTestId("pause-btn").click();
  await expect(page.getByTestId("pause-btn")).toContainText("Fortset", { timeout: 5000 });
  await expect(page.locator(".arc-center-label")).toContainText("Pause");

  await page.getByTestId("pause-btn").click();
  await expect(page.getByTestId("pause-btn")).toContainText("Pause", { timeout: 5000 });
  await expect(page.locator(".arc-center-label")).toContainText(/Lurar|Søv/);
});

test("Timer adjusts for pause duration", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const db = getDb();
  const now = Date.now();
  const startTime = new Date(now - 10 * 60000).toISOString();
  const pauseTime = new Date(now - 8 * 60000).toISOString();
  const resumeTime = new Date(now - 3 * 60000).toISOString();
  const domainId = generateId();

  db.prepare(
    "INSERT INTO sleep_log (baby_id, start_time, type, domain_id) VALUES (?, ?, 'nap', ?)",
  ).run(babyId, startTime, domainId);
  const sleepId = (
    db.prepare("SELECT id FROM sleep_log ORDER BY id DESC LIMIT 1").get() as { id: number }
  ).id;

  db.prepare("INSERT INTO sleep_pauses (sleep_id, pause_time, resume_time) VALUES (?, ?, ?)").run(
    sleepId,
    pauseTime,
    resumeTime,
  );

  await page.goto("/");
  await expect(page.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 5000 });

  const timerText = await page.locator(".arc-center-text .countdown-value").textContent();
  expect(timerText).toMatch(/^0[45]:/);
});

test("Multiple pauses work correctly", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  await page.goto("/");

  await page.getByTestId("sleep-button").click();
  await expect(page.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 5000 });
  await dismissSheet(page);

  // First pause/resume
  await page.getByTestId("pause-btn").click();
  await expect(page.getByTestId("pause-btn")).toContainText("Fortset", { timeout: 5000 });
  await page.getByTestId("pause-btn").click();
  await expect(page.getByTestId("pause-btn")).toContainText("Pause", { timeout: 5000 });

  // Second pause/resume
  await page.getByTestId("pause-btn").click();
  await expect(page.getByTestId("pause-btn")).toContainText("Fortset", { timeout: 5000 });
  await page.getByTestId("pause-btn").click();
  await expect(page.getByTestId("pause-btn")).toContainText("Pause", { timeout: 5000 });

  const db = getDb();
  const pauses = db.prepare("SELECT * FROM sleep_pauses").all() as SleepPauseRow[];
  expect(pauses.length).toBe(2);
  expect(pauses[0].resume_time).toBeTruthy();
  expect(pauses[1].resume_time).toBeTruthy();
});

test("History shows pause info", async ({ page }) => {
  const babyId = createBaby("Testa");
  setWakeUpTime(babyId);
  const db = getDb();
  const now = Date.now();
  const startTime = new Date(now - 60 * 60000).toISOString();
  const endTime = new Date(now - 10 * 60000).toISOString();
  const pauseTime = new Date(now - 50 * 60000).toISOString();
  const resumeTime2 = new Date(now - 40 * 60000).toISOString();
  const domainId = generateId();

  db.prepare(
    "INSERT INTO sleep_log (baby_id, start_time, end_time, type, domain_id) VALUES (?, ?, ?, 'nap', ?)",
  ).run(babyId, startTime, endTime, domainId);
  const sleepId = (
    db.prepare("SELECT id FROM sleep_log ORDER BY id DESC LIMIT 1").get() as { id: number }
  ).id;
  db.prepare("INSERT INTO sleep_pauses (sleep_id, pause_time, resume_time) VALUES (?, ?, ?)").run(
    sleepId,
    pauseTime,
    resumeTime2,
  );

  await page.goto("/#/history");
  const sleepItem = page.locator(".sleep-log-item:not(.wakeup-log-item)").first();
  await expect(sleepItem).toBeVisible({ timeout: 5000 });
  await expect(sleepItem.locator(".log-meta").first()).toContainText("1 pause");
});
