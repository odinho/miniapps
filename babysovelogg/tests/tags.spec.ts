import { test, expect, createBaby, setWakeUpTime, getDb } from './fixtures';

test('Tag sheet appears after stopping sleep', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');

  await page.locator('.sleep-button').click();
  await expect(page.locator('.sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });

  await page.locator('.sleep-button').click();
  await expect(page.locator('.tag-sheet')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.tag-sheet h2')).toHaveText('How did it go?');
});

test('Can select mood and method and save', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');

  await page.locator('.sleep-button').click();
  await expect(page.locator('.sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });
  await page.locator('.sleep-button').click();
  await expect(page.locator('.tag-sheet')).toBeVisible({ timeout: 5000 });

  await page.locator('[data-mood="happy"]').click();
  await expect(page.locator('[data-mood="happy"]')).toHaveClass(/active/);

  await page.locator('[data-method="nursing"]').click();
  await expect(page.locator('[data-method="nursing"]')).toHaveClass(/active/);

  await page.locator('.tag-sheet .btn-primary').click();
  await expect(page.locator('.modal-overlay')).not.toBeVisible({ timeout: 5000 });

  await page.locator('.nav-tab:nth-child(2)').click();
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

  await page.locator('.sleep-button').click();
  await expect(page.locator('.sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });
  await page.locator('.sleep-button').click();
  await expect(page.locator('.tag-sheet')).toBeVisible({ timeout: 5000 });

  await page.locator('.tag-sheet .btn-ghost').click();
  await expect(page.locator('.modal-overlay')).not.toBeVisible({ timeout: 5000 });
  await expect(page.locator('.sleep-button')).toHaveClass(/awake/);
});
