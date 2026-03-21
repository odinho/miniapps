import { test, expect, forceMorning } from './fixtures';

test.beforeEach(async ({ page }) => {
  await forceMorning(page);
});

test('Get Started button creates baby and navigates to dashboard', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Velkomen til Babysovelogg' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Kom i gang ✨' })).toBeVisible();

  await page.locator('input[type="text"]').fill('Halldis');
  await page.locator('input[type="date"]').fill('2025-06-12');

  await page.getByRole('button', { name: 'Kom i gang ✨' }).click();

  await expect(page.getByTestId('morning-prompt')).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: 'Sett vaknetid' }).click();

  await expect(page.getByTestId('baby-name')).toHaveText('Halldis', { timeout: 5000 });
  await expect(page.getByTestId('baby-age')).toContainText('mnd');
  await expect(page.getByTestId('sleep-button')).toBeVisible();
});

test('Get Started validates required fields', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Kom i gang ✨' }).click();
  await expect(page.getByRole('heading', { name: 'Velkomen til Babysovelogg' })).toBeVisible();

  await page.locator('input[type="text"]').fill('Halldis');
  await page.getByRole('button', { name: 'Kom i gang ✨' }).click();
  await expect(page.getByRole('heading', { name: 'Velkomen til Babysovelogg' })).toBeVisible();

  await page.locator('input[type="date"]').fill('2025-06-12');
  await page.getByRole('button', { name: 'Kom i gang ✨' }).click();
  await expect(page.getByTestId('morning-prompt')).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: 'Sett vaknetid' }).click();
  await expect(page.getByTestId('baby-name')).toHaveText('Halldis', { timeout: 5000 });
});

test('Sleep tracking flow after onboarding', async ({ page, request }) => {
  // Create baby via API
  await request.post('/api/events', {
    data: { events: [{ type: 'baby.created', payload: { name: 'Halldis', birthdate: '2025-06-12' } }] },
  });

  await page.goto('/');
  await expect(page.getByTestId('morning-prompt')).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: 'Sett vaknetid' }).click();
  await expect(page.getByTestId('baby-name')).toHaveText('Halldis', { timeout: 5000 });

  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/sleeping/, { timeout: 3000 });
});
