import { test, expect, createBaby, setWakeUpTime, seedBabyWithSleep } from './fixtures';

test('History page shows logged sleeps', async ({ page }) => {
  seedBabyWithSleep();
  await page.goto('/#/history');
  await expect(page.locator('.sleep-log-item')).toHaveCount(1, { timeout: 5000 });
  await expect(page.locator('.log-meta')).toContainText('Nap');
});

test('History page shows empty state when no sleeps', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);

  await page.goto('/#/history');
  await expect(page.getByText('No entries yet')).toBeVisible({ timeout: 5000 });
});

test('Clicking a sleep entry opens edit modal', async ({ page }) => {
  seedBabyWithSleep();
  await page.goto('/#/history');
  await expect(page.locator('.sleep-log-item')).toHaveCount(1, { timeout: 5000 });

  await page.locator('.sleep-log-item').click();
  await expect(page.getByRole('heading', { name: 'Edit Sleep' })).toBeVisible();
  await expect(page.locator('.type-pill.active')).toContainText('Nap');
});

test('Can edit a sleep entry type', async ({ page }) => {
  seedBabyWithSleep();
  await page.goto('/#/history');
  await expect(page.locator('.sleep-log-item')).toHaveCount(1, { timeout: 5000 });

  await page.locator('.sleep-log-item').click();
  await expect(page.getByRole('heading', { name: 'Edit Sleep' })).toBeVisible();

  await page.getByText('Night').click();
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.locator('.modal')).not.toBeVisible({ timeout: 3000 });
  await expect(page.locator('.log-meta')).toContainText('Night');
});

test('Can delete a sleep entry', async ({ page }) => {
  seedBabyWithSleep();
  await page.goto('/#/history');
  await expect(page.locator('.sleep-log-item')).toHaveCount(1, { timeout: 5000 });

  await page.locator('.sleep-log-item').click();
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete' }).click();

  await expect(page.locator('.modal')).not.toBeVisible({ timeout: 3000 });
  await expect(page.getByText('No entries yet')).toBeVisible({ timeout: 5000 });
});
