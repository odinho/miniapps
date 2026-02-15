import { test, expect, createBaby, setWakeUpTime } from './fixtures';

test('Dashboard shows baby name and sleep button', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');
  await expect(page.locator('.baby-name')).toHaveText('Testa');
  await expect(page.locator('.baby-age')).toContainText('old');
  await expect(page.locator('.sleep-button')).toBeVisible();
  await expect(page.locator('.sleep-button')).toHaveClass(/awake/);
});

test('Can start and stop a nap', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');

  await page.locator('.sleep-button').click();
  await expect(page.locator('.sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });
  await expect(page.locator('.arc-center-label')).toContainText(/Napping|Sleeping/);

  await page.locator('.sleep-button').click();
  await expect(page.locator('.sleep-button')).toHaveClass(/awake/, { timeout: 5000 });
});

test('Dashboard shows stats section', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');
  await expect(page.locator('.baby-name')).toHaveText('Testa', { timeout: 5000 });

  await expect(page.locator('.stats-row').first()).toBeVisible();
  await expect(page.locator('.stats-card')).toHaveCount(4);
  await expect(page.locator('.stat-label').nth(0)).toHaveText('Naps today');
  await expect(page.locator('.stat-label').nth(1)).toHaveText('Nap time');
  await expect(page.locator('.stat-label').nth(2)).toHaveText('Total sleep');
  await expect(page.locator('.stat-label').nth(3)).toHaveText('Diapers today');
});

test('FAB button opens manual sleep modal', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');

  await page.locator('.fab').click();
  await expect(page.getByRole('heading', { name: 'Add Sleep' })).toBeVisible();
  await expect(page.locator('.modal input[type="date"]').first()).toBeVisible();
  await expect(page.locator('.modal input[type="time"]').first()).toBeVisible();
});

test('Can add manual sleep entry', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');
  await expect(page.locator('.baby-name')).toHaveText('Testa', { timeout: 5000 });

  await page.locator('.fab').click();
  await expect(page.getByRole('heading', { name: 'Add Sleep' })).toBeVisible();
  await page.locator('.modal .btn-primary').click();

  await expect(page.locator('.modal-overlay')).not.toBeVisible({ timeout: 5000 });
  await expect(page.locator('.stat-value').nth(2)).not.toHaveText('0m');
});

test('Redirects to settings when no baby exists', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to Napper' })).toBeVisible();
});
