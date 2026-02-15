import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  return new Database(path.join(process.cwd(), 'napper.db'));
}

function resetDb() {
  const db = getDb();
  db.prepare('DELETE FROM diaper_log').run();
  try { db.prepare('DELETE FROM sleep_log').run(); } catch {}
  try { db.prepare('DELETE FROM day_start').run(); } catch {}
  try { db.prepare('DELETE FROM baby').run(); } catch {}
  try { db.prepare('DELETE FROM events').run(); } catch {}
  db.close();
}

function createBaby(name = 'Testa', birthdate = '2025-06-12'): number {
  const db = getDb();
  db.prepare("INSERT INTO events (type, payload) VALUES ('baby.created', ?)").run(JSON.stringify({ name, birthdate }));
  const info = db.prepare("INSERT INTO baby (name, birthdate) VALUES (?, ?)").run(name, birthdate);
  db.close();
  return Number(info.lastInsertRowid);
}

function setWakeUpTime(babyId: number) {
  const db = getDb();
  const today = new Date();
  today.setHours(7, 0, 0, 0);
  const dateStr = today.toISOString().split('T')[0];
  db.prepare("INSERT INTO day_start (baby_id, date, wake_time) VALUES (?, ?, ?)").run(
    babyId, dateStr, today.toISOString()
  );
  db.close();
}

test.beforeEach(() => {
  resetDb();
});

test('Can log a diaper change', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');
  await expect(page.locator('.baby-name')).toHaveText('Testa', { timeout: 5000 });

  await page.click('.diaper-quick-btn');
  await expect(page.locator('.modal h2')).toHaveText('Log Diaper');

  // Select dirty type
  await page.click('.type-pill[data-diaper-type="dirty"]');
  await page.click('.modal .btn-primary');

  await expect(page.locator('.modal-overlay')).not.toBeVisible({ timeout: 5000 });
  // Diaper count should be 1
  await expect(page.locator('.stat-label:text("Diapers today")')).toBeVisible();
  await expect(page.locator('.stat-label:text("Diapers today")').locator('..').locator('.stat-value')).toHaveText('1');
});

test('Diaper shows in history', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');
  await expect(page.locator('.baby-name')).toHaveText('Testa', { timeout: 5000 });

  // Log a diaper
  await page.click('.diaper-quick-btn');
  await page.click('.modal .btn-primary');
  await expect(page.locator('.modal-overlay')).not.toBeVisible({ timeout: 5000 });

  // Go to history
  await page.click('text=History');
  await expect(page.locator('.diaper-log-item')).toHaveCount(1, { timeout: 5000 });
  await expect(page.locator('.diaper-log-item .log-duration')).toHaveText('Diaper');
});

test('Dashboard diaper count updates', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');
  await expect(page.locator('.baby-name')).toHaveText('Testa', { timeout: 5000 });

  // Initially 0
  const countLocator = page.locator('.stat-label:text("Diapers today")').locator('..').locator('.stat-value');
  await expect(countLocator).toHaveText('0');

  // Log first diaper
  await page.click('.diaper-quick-btn');
  await page.click('.modal .btn-primary');
  await expect(page.locator('.modal-overlay')).not.toBeVisible({ timeout: 5000 });
  await expect(countLocator).toHaveText('1');

  // Log second diaper
  await page.click('.diaper-quick-btn');
  await page.click('.modal .btn-primary');
  await expect(page.locator('.modal-overlay')).not.toBeVisible({ timeout: 5000 });
  await expect(countLocator).toHaveText('2');
});

test('Can delete a diaper entry', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');
  await expect(page.locator('.baby-name')).toHaveText('Testa', { timeout: 5000 });

  // Log a diaper
  await page.click('.diaper-quick-btn');
  await page.click('.modal .btn-primary');
  await expect(page.locator('.modal-overlay')).not.toBeVisible({ timeout: 5000 });

  // Go to history and delete
  await page.click('text=History');
  await expect(page.locator('.diaper-log-item')).toHaveCount(1, { timeout: 5000 });

  page.on('dialog', dialog => dialog.accept());
  await page.click('.diaper-log-item');
  await expect(page.locator('.modal h2')).toHaveText('Diaper Details');
  await page.click('.btn-danger');

  await expect(page.locator('.diaper-log-item')).toHaveCount(0, { timeout: 5000 });
});
