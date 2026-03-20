import { test, expect, createBaby, setWakeUpTime, dismissSheet, forceMorning } from './fixtures';

test.beforeEach(async ({ page }) => {
  await forceMorning(page);
});

test('Dashboard shows baby name and sleep button', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');
  await expect(page.getByTestId('baby-name')).toHaveText('Testa');
  await expect(page.getByTestId('baby-age')).toContainText('mnd');
  await expect(page.getByTestId('sleep-button')).toBeVisible();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/awake/);
});

test('Can start and stop a nap', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');

  // Start sleep — tag sheet appears
  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });
  // Dismiss bedtime tag sheet
  await dismissSheet(page);

  await expect(page.locator('.arc-center-label')).toContainText(/Lurar|Søv/);

  // End sleep — wake-up sheet appears
  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/awake/, { timeout: 5000 });
  await dismissSheet(page);
});

test('Dashboard shows stats section', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');
  await expect(page.getByTestId('baby-name')).toHaveText('Testa', { timeout: 5000 });

  await expect(page.getByText('lurar')).toBeVisible();
  await expect(page.getByText('lurtid')).toBeVisible();
  await expect(page.getByText('totalt')).toBeVisible();
});

test('Redirects to settings when no baby exists', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Velkomen til Napper' })).toBeVisible();
});
