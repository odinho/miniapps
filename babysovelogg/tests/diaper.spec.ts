import { test, expect, createBaby, setWakeUpTime } from './fixtures';

test('Can log a diaper change', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');
  await expect(page.getByTestId('baby-name')).toHaveText('Testa', { timeout: 5000 });

  await page.getByRole('button', { name: /Log Diaper/ }).click();
  await expect(page.getByRole('heading', { name: 'Log Diaper' })).toBeVisible();

  await page.getByRole('button', { name: '💩 Dirty' }).click();
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByTestId('modal-overlay')).not.toBeVisible({ timeout: 5000 });
  await expect(page.getByText('Diapers today').locator('..').locator('.stat-value')).toHaveText('1');
});

test('Diaper shows in history', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');
  await expect(page.getByTestId('baby-name')).toHaveText('Testa', { timeout: 5000 });

  await page.getByRole('button', { name: /Log Diaper/ }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('modal-overlay')).not.toBeVisible({ timeout: 5000 });

  await page.getByText('History').click();
  await expect(page.locator('.diaper-log-item')).toHaveCount(1, { timeout: 5000 });
  await expect(page.locator('.diaper-log-item .log-duration')).toHaveText('Diaper');
});

test('Dashboard diaper count updates', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');
  await expect(page.getByTestId('baby-name')).toHaveText('Testa', { timeout: 5000 });

  const countLocator = page.getByText('Diapers today').locator('..').locator('.stat-value');
  await expect(countLocator).toHaveText('0');

  await page.getByRole('button', { name: /Log Diaper/ }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('modal-overlay')).not.toBeVisible({ timeout: 5000 });
  await expect(countLocator).toHaveText('1');

  await page.getByRole('button', { name: /Log Diaper/ }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('modal-overlay')).not.toBeVisible({ timeout: 5000 });
  await expect(countLocator).toHaveText('2');
});

test('Can delete a diaper entry', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');
  await expect(page.getByTestId('baby-name')).toHaveText('Testa', { timeout: 5000 });

  await page.getByRole('button', { name: /Log Diaper/ }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('modal-overlay')).not.toBeVisible({ timeout: 5000 });

  await page.getByText('History').click();
  await expect(page.locator('.diaper-log-item')).toHaveCount(1, { timeout: 5000 });

  page.on('dialog', dialog => dialog.accept());
  await page.locator('.diaper-log-item').click();
  await expect(page.getByRole('heading', { name: 'Diaper Details' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete' }).click();

  await expect(page.locator('.diaper-log-item')).toHaveCount(0, { timeout: 5000 });
});
