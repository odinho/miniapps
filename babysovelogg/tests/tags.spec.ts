import { test, expect, createBaby, setWakeUpTime, getDb, dismissSheet, forceMorning } from './fixtures';

test.beforeEach(async ({ page }) => {
  await forceMorning(page);
});

test('Tag sheet appears after starting sleep', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');

  // Start sleep — bedtime tag sheet appears
  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });
  await expect(page.getByRole('heading', { name: 'Korleis gjekk legginga?' })).toBeVisible({ timeout: 5000 });
});

test('Can select mood and method and save', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');

  // Start sleep — tag sheet appears
  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });
  await expect(page.getByRole('heading', { name: 'Korleis gjekk legginga?' })).toBeVisible({ timeout: 5000 });

  await page.getByRole('button', { name: 'Glad' }).click();
  await expect(page.getByRole('button', { name: 'Glad' })).toHaveClass(/active/);

  await page.getByRole('button', { name: 'Amming' }).click();
  await expect(page.getByRole('button', { name: 'Amming' })).toHaveClass(/active/);

  await page.getByRole('button', { name: 'Lagra' }).click();
  await expect(page.getByTestId('modal-overlay')).not.toBeVisible({ timeout: 5000 });

  // Sleep should still be running
  await expect(page.getByTestId('sleep-button')).toHaveClass(/sleeping/);

  // End sleep — dismiss wake-up sheet
  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/awake/, { timeout: 5000 });
  await dismissSheet(page);

  // Verify tags in history
  await page.locator('.nav-bar').getByText('Logg').click();
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

  // Start sleep — tag sheet appears
  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });
  await expect(page.getByRole('heading', { name: 'Korleis gjekk legginga?' })).toBeVisible({ timeout: 5000 });

  await page.getByRole('button', { name: 'Hopp over' }).click();
  await expect(page.getByTestId('modal-overlay')).not.toBeVisible({ timeout: 5000 });
  // Sleep should still be running
  await expect(page.getByTestId('sleep-button')).toHaveClass(/sleeping/);
});
