import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  return new Database(path.join(process.cwd(), 'napper.db'));
}

function resetDb() {
  const db = getDb();
  try { db.prepare('DELETE FROM sleep_pauses').run(); } catch {}
  try { db.prepare('DELETE FROM diaper_log').run(); } catch {}
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
  db.prepare("INSERT INTO day_start (baby_id, date, wake_time) VALUES (?, ?, ?)").run(babyId, dateStr, today.toISOString());
  db.close();
}

test.beforeEach(() => {
  resetDb();
});

test('Tag sheet appears after stopping sleep', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');

  // Start sleep
  await page.click('.sleep-button');
  await expect(page.locator('.sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });

  // Stop sleep
  await page.click('.sleep-button');
  await expect(page.locator('.tag-sheet')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.tag-sheet h2')).toHaveText('How did it go?');
});

test('Can select mood and method and save', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');

  // Start and stop sleep
  await page.click('.sleep-button');
  await expect(page.locator('.sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });
  await page.click('.sleep-button');
  await expect(page.locator('.tag-sheet')).toBeVisible({ timeout: 5000 });

  // Select mood: happy
  await page.click('[data-mood="happy"]');
  await expect(page.locator('[data-mood="happy"]')).toHaveClass(/active/);

  // Select method: nursing
  await page.click('[data-method="nursing"]');
  await expect(page.locator('[data-method="nursing"]')).toHaveClass(/active/);

  // Save
  await page.click('.tag-sheet .btn-primary');
  await expect(page.locator('.modal-overlay')).not.toBeVisible({ timeout: 5000 });

  // Check in history
  await page.click('.nav-tab:nth-child(2)');
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
  // Should show both mood and method emoji
  const badges = page.locator('.tag-badges .tag-badge');
  await expect(badges).toHaveCount(2);
});

test('Can skip tagging', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');

  // Start and stop sleep
  await page.click('.sleep-button');
  await expect(page.locator('.sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });
  await page.click('.sleep-button');
  await expect(page.locator('.tag-sheet')).toBeVisible({ timeout: 5000 });

  // Click skip
  await page.click('.tag-sheet .btn-ghost');
  await expect(page.locator('.modal-overlay')).not.toBeVisible({ timeout: 5000 });
  await expect(page.locator('.sleep-button')).toHaveClass(/awake/);
});
