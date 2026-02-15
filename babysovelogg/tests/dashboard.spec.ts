import { test, expect, createBaby, setWakeUpTime } from './fixtures';

test('Dashboard shows baby name and sleep button', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');
  await expect(page.getByTestId('baby-name')).toHaveText('Testa');
  await expect(page.getByTestId('baby-age')).toContainText('old');
  await expect(page.getByTestId('sleep-button')).toBeVisible();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/awake/);
});

test('Can start and stop a nap', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');

  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });
  await expect(page.locator('.arc-center-label')).toContainText(/Napping|Sleeping/);

  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/awake/, { timeout: 5000 });
});

test('Dashboard shows stats section', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');
  await expect(page.getByTestId('baby-name')).toHaveText('Testa', { timeout: 5000 });

  await expect(page.getByText('Naps today')).toBeVisible();
  await expect(page.getByText('Nap time')).toBeVisible();
  await expect(page.getByText('Total sleep')).toBeVisible();
  await expect(page.getByText('Diapers today')).toBeVisible();
});

test('FAB button opens manual sleep modal', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');

  await page.getByTestId('fab').click();
  await expect(page.getByRole('heading', { name: 'Add Sleep' })).toBeVisible();
  await expect(page.locator('.modal input[type="date"]').first()).toBeVisible();
  await expect(page.locator('.modal input[type="time"]').first()).toBeVisible();
});

test('Can add manual sleep entry', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');
  await expect(page.getByTestId('baby-name')).toHaveText('Testa', { timeout: 5000 });

  await page.getByTestId('fab').click();
  await expect(page.getByRole('heading', { name: 'Add Sleep' })).toBeVisible();
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByTestId('modal-overlay')).not.toBeVisible({ timeout: 5000 });
  await expect(page.getByText('Total sleep').locator('..').locator('.stat-value')).not.toHaveText('0m');
});

test('Redirects to settings when no baby exists', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to Napper' })).toBeVisible();
});
