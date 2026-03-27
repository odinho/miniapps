import {
  test,
  expect,
  createBaby,
  setWakeUpTime,
  addCompletedSleep,
  getDb,
  forceHour,
} from "./fixtures";
import type { SleepLogRow } from "../src/lib/types";

test("After 20:00, sleep is classified as night", async ({ page }) => {
  await forceHour(page, 21);
  const babyId = createBaby("Testa", "2025-06-12");
  setWakeUpTime(babyId);
  await page.goto("/");

  // Start sleep at forced hour 21
  await page.getByTestId("sleep-button").click();
  await expect(page.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 5000 });

  const db = getDb();
  const sleep = db
    .prepare("SELECT * FROM sleep_log WHERE baby_id = ? ORDER BY id DESC LIMIT 1")
    .get(babyId) as SleepLogRow;
  expect(sleep.type).toBe("night");
});

test("Before 16:00, sleep is classified as nap", async ({ page }) => {
  await forceHour(page, 10);
  const babyId = createBaby("Testa", "2025-06-12");
  setWakeUpTime(babyId);
  await page.goto("/");

  await page.getByTestId("sleep-button").click();
  await expect(page.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 5000 });

  const db = getDb();
  const sleep = db
    .prepare("SELECT * FROM sleep_log WHERE baby_id = ? ORDER BY id DESC LIMIT 1")
    .get(babyId) as SleepLogRow;
  expect(sleep.type).toBe("nap");
});

test("At 17:45 with nap quota met, sleep is classified as night", async ({ page }) => {
  await forceHour(page, 17);
  // 9-month baby has 2 expected naps
  const babyId = createBaby("Testa", "2025-06-12");
  setWakeUpTime(babyId);

  // Add 2 completed naps to meet quota
  const now = new Date();
  addCompletedSleep(
    babyId,
    new Date(now.getTime() - 6 * 3600000).toISOString(),
    new Date(now.getTime() - 5 * 3600000).toISOString(),
    "nap",
  );
  addCompletedSleep(
    babyId,
    new Date(now.getTime() - 3 * 3600000).toISOString(),
    new Date(now.getTime() - 2 * 3600000).toISOString(),
    "nap",
  );

  await page.goto("/");
  await page.getByTestId("sleep-button").click();
  await expect(page.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 5000 });

  const db = getDb();
  const sleep = db
    .prepare("SELECT * FROM sleep_log WHERE baby_id = ? ORDER BY id DESC LIMIT 1")
    .get(babyId) as SleepLogRow;
  expect(sleep.type).toBe("night");
});

test("At 17:00 with nap quota NOT met, sleep is classified as nap", async ({ page }) => {
  await forceHour(page, 17);
  // 9-month baby has 2 expected naps, 0 completed
  const babyId = createBaby("Testa", "2025-06-12");
  setWakeUpTime(babyId);

  await page.goto("/");
  await page.getByTestId("sleep-button").click();
  await expect(page.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 5000 });

  const db = getDb();
  const sleep = db
    .prepare("SELECT * FROM sleep_log WHERE baby_id = ? ORDER BY id DESC LIMIT 1")
    .get(babyId) as SleepLogRow;
  expect(sleep.type).toBe("nap");
});
