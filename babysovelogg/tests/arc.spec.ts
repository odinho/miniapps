import { test, expect, createBaby, setWakeUpTime, getDb, addCompletedSleep, addActiveSleep } from './fixtures';

test('Arc renders on dashboard', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  
  await page.goto('/');
  await expect(page.locator('.baby-name')).toHaveText('Testa');
  await expect(page.locator('.sleep-arc')).toBeVisible();
  await expect(page.locator('.arc-container')).toBeVisible();
  await expect(page.locator('.arc-track')).toBeVisible();
});

test('Completed sleeps appear as filled bubbles on arc', async ({ page }) => {
  const babyId = createBaby('Testa');
  const now = new Date();
  const hour = now.getHours();
  
  let start: Date, end: Date;
  if (hour >= 6 && hour < 18) {
    start = new Date(now); start.setHours(10, 0, 0, 0);
    end = new Date(now); end.setHours(11, 0, 0, 0);
  } else if (hour >= 18) {
    start = new Date(now); start.setHours(20, 0, 0, 0);
    end = new Date(now); end.setHours(21, 0, 0, 0);
  } else {
    start = new Date(now); start.setHours(0, 0, 0, 0);
    end = new Date(now); end.setHours(1, 0, 0, 0);
  }
  
  addCompletedSleep(babyId, start.toISOString(), end.toISOString(), 'nap');

  await page.goto('/');
  await expect(page.locator('.sleep-arc')).toBeVisible();
  await expect(page.locator('.arc-bubble-completed')).toHaveCount(1);
});

test('Predicted nap shown with dashed outline', async ({ page }) => {
  const babyId = createBaby('Testa');
  const now = new Date();
  const start = new Date(now.getTime() - 2 * 3600000);
  const end = new Date(now.getTime() - 30 * 60000);
  addCompletedSleep(babyId, start.toISOString(), end.toISOString(), 'nap');

  await page.goto('/');
  await expect(page.locator('.sleep-arc')).toBeVisible();
  await expect(page.locator('.arc-bubble-predicted:not(.arc-bedtime)')).toHaveCount(1);
});

test('Active sleep has pulsing animation class', async ({ page }) => {
  const babyId = createBaby('Testa');
  const start = new Date(Date.now() - 20 * 60000);
  addActiveSleep(babyId, start.toISOString(), 'nap');

  await page.goto('/');
  await expect(page.locator('.sleep-arc')).toBeVisible();
  await expect(page.locator('.arc-bubble-active')).toHaveCount(1);
  await expect(page.locator('.arc-active-pulse')).toHaveCount(1);
});

test('Arc center shows countdown when not sleeping', async ({ page }) => {
  const babyId = createBaby('Testa');
  const now = new Date();
  const start = new Date(now.getTime() - 2 * 3600000);
  const end = new Date(now.getTime() - 30 * 60000);
  addCompletedSleep(babyId, start.toISOString(), end.toISOString(), 'nap');

  await page.goto('/');
  await expect(page.locator('.arc-center-text')).toBeVisible();
  await expect(page.locator('.arc-center-label')).toContainText('Next nap');
});

test('Arc center shows timer when sleeping', async ({ page }) => {
  const babyId = createBaby('Testa');
  addActiveSleep(babyId, new Date(Date.now() - 10 * 60000).toISOString(), 'nap');

  await page.goto('/');
  await expect(page.locator('.arc-center-text')).toBeVisible();
  await expect(page.locator('.arc-center-label')).toContainText('Napping');
});
