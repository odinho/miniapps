import {
  test,
  expect,
  createBaby,
  setWakeUpTime,
  addCompletedSleep,
  getDb,
  forceHour,
} from "./fixtures";
import { renderDayState } from "./helpers/render-state";

test("After 20:00, sleep is classified as night", async ({ page }) => {
  await forceHour(page, 21);
  const babyId = createBaby("Testa", "2025-06-12");
  setWakeUpTime(babyId);
  await page.goto("/");

  // Start sleep at forced hour 21
  await page.getByTestId("sleep-button").click();
  await expect(page.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 5000 });

  expect(renderDayState(getDb(), babyId)).toContain("natt");
});

test("Before 16:00, sleep is classified as nap", async ({ page }) => {
  await forceHour(page, 10);
  const babyId = createBaby("Testa", "2025-06-12");
  setWakeUpTime(babyId);
  await page.goto("/");

  await page.getByTestId("sleep-button").click();
  await expect(page.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 5000 });

  expect(renderDayState(getDb(), babyId)).toContain("lur");
});

test("At 17:45 with nap quota met, sleep is classified as night", async ({ page }) => {
  await forceHour(page, 17);
  // 9-month baby has 2 expected naps
  const babyId = createBaby("Testa", "2025-06-12");
  setWakeUpTime(babyId);

  // Add 2 completed naps to meet quota (explicit today times to avoid midnight boundary)
  const t = new Date();
  t.setHours(9, 0, 0, 0);
  const nap1Start = t.toISOString();
  t.setHours(10, 0, 0, 0);
  const nap1End = t.toISOString();
  t.setHours(13, 0, 0, 0);
  const nap2Start = t.toISOString();
  t.setHours(14, 0, 0, 0);
  const nap2End = t.toISOString();
  addCompletedSleep(babyId, nap1Start, nap1End, "nap");
  addCompletedSleep(babyId, nap2Start, nap2End, "nap");

  await page.goto("/");
  await page.getByTestId("sleep-button").click();
  await expect(page.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 5000 });

  expect(renderDayState(getDb(), babyId)).toMatch(/pågår natt/);
});

test("At 17:00 with all naps skipped, sleep is classified as night", async ({ page }) => {
  await forceHour(page, 17);
  // 9-month baby has 2 expected naps, 0 completed, wake at 07:00
  // Predicted naps are >90 min overdue → naps detected as skipped → napsAllDone
  const babyId = createBaby("Testa", "2025-06-12");
  setWakeUpTime(babyId);

  await page.goto("/");
  await page.getByTestId("sleep-button").click();
  await expect(page.getByTestId("sleep-button")).toHaveClass(/sleeping/, { timeout: 5000 });

  expect(renderDayState(getDb(), babyId)).toMatch(/pågår natt/);
});

