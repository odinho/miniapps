import { test, expect, createBaby, setWakeUpTime, getDb } from './fixtures';

test('Tag sheet appears after stopping sleep', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');

  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });

  await page.getByTestId('sleep-button').click();
  await expect(page.getByRole('heading', { name: 'How did it go?' })).toBeVisible({ timeout: 5000 });
});

test('Can select mood and method and save', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');

  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });
  await page.getByTestId('sleep-button').click();
  await expect(page.getByRole('heading', { name: 'How did it go?' })).toBeVisible({ timeout: 5000 });

  await page.getByRole('button', { name: 'Happy' }).click();
  await expect(page.getByRole('button', { name: 'Happy' })).toHaveClass(/active/);

  await page.getByRole('button', { name: 'Nursing' }).click();
  await expect(page.getByRole('button', { name: 'Nursing' })).toHaveClass(/active/);

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('modal-overlay')).not.toBeVisible({ timeout: 5000 });

  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.locator('.tag-badge').first()).toBeVisible({ timeout: 5000 });
});

test('Tags shown in history as emoji badges', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  const db = getDb();
  const now = new Date();
  const start = new Date(now.getTime() - 3600000).toISOString();
  const end = now.toISOString();
  db.prepare("INSERT INTO sleep_log (baby_id, start_time, end_time, type, mood, method) VALUES (?, ?, ?, 'nap', 'happy', 'nursing')").run(babyId, start, end);
  db.close();

  await page.goto('/#/history');
  await expect(page.locator('.tag-badge').first()).toBeVisible({ timeout: 5000 });
  const badges = page.locator('.tag-badges .tag-badge');
  await expect(badges).toHaveCount(2);
});

test('Can skip tagging', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');

  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });
  await page.getByTestId('sleep-button').click();
  await expect(page.getByRole('heading', { name: 'How did it go?' })).toBeVisible({ timeout: 5000 });

  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page.getByTestId('modal-overlay')).not.toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('sleep-button')).toHaveClass(/awake/);
});
