import { test, expect, createBaby, setWakeUpTime, seedBabyWithSleep, forceMorning } from './fixtures';

test.beforeEach(async ({ page }) => {
  await forceMorning(page);
});

test('History page shows logged sleeps', async ({ page }) => {
  seedBabyWithSleep();
  await page.goto('/#/history');
  await expect(page.locator('.sleep-log-item')).toHaveCount(1, { timeout: 5000 });
  await expect(page.locator('.log-meta')).toContainText('Lur');
});

test('History page shows empty state when no sleeps', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);

  await page.goto('/#/history');
  await expect(page.getByText('Ingen oppføringar enno')).toBeVisible({ timeout: 5000 });
});

test('Clicking a sleep entry opens edit modal', async ({ page }) => {
  seedBabyWithSleep();
  await page.goto('/#/history');
  await expect(page.locator('.sleep-log-item')).toHaveCount(1, { timeout: 5000 });

  await page.locator('.sleep-log-item').click();
  await expect(page.getByRole('heading', { name: 'Endra søvn' })).toBeVisible();
  await expect(page.locator('.type-pill.active')).toContainText('Lur');
});

test('Can edit a sleep entry type', async ({ page }) => {
  seedBabyWithSleep();
  await page.goto('/#/history');
  await expect(page.locator('.sleep-log-item')).toHaveCount(1, { timeout: 5000 });

  await page.locator('.sleep-log-item').click();
  await expect(page.getByRole('heading', { name: 'Endra søvn' })).toBeVisible();

  await page.locator('.type-pill', { hasText: 'Natt' }).click();
  await page.getByRole('button', { name: 'Lagra' }).click();

  await expect(page.getByRole('heading', { name: 'Endra søvn' })).not.toBeVisible({ timeout: 3000 });
  await expect(page.locator('.log-meta')).toContainText('Nattesøvn');
});

test('Can delete a sleep entry', async ({ page }) => {
  seedBabyWithSleep();
  await page.goto('/#/history');
  await expect(page.locator('.sleep-log-item')).toHaveCount(1, { timeout: 5000 });

  await page.locator('.sleep-log-item').click();
  // Click Slett in edit modal — opens custom confirm dialog
  await page.getByRole('button', { name: 'Slett' }).first().click();
  // Click Slett in confirm dialog
  await page.locator('.modal-overlay').last().getByRole('button', { name: 'Slett' }).click();

  await expect(page.getByText('Ingen oppføringar enno')).toBeVisible({ timeout: 5000 });
});
