import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  return new Database(path.join(process.cwd(), 'napper.db'));
}

function resetDb() {
  const db = getDb();
  db.prepare('DELETE FROM sleep_log').run();
  db.prepare('DELETE FROM baby').run();
  db.prepare('DELETE FROM events').run();
  db.close();
}

function seedBabyWithSleep() {
  const db = getDb();
  db.prepare("INSERT INTO events (type, payload) VALUES ('baby.created', ?)").run(JSON.stringify({ name: 'Testa', birthdate: '2025-06-12' }));
  db.prepare("INSERT INTO baby (name, birthdate) VALUES (?, ?)").run('Testa', '2025-06-12');
  const babyId = db.prepare('SELECT id FROM baby LIMIT 1').get() as any;
  const now = new Date();
  const start = new Date(now.getTime() - 3600000).toISOString();
  const end = now.toISOString();
  db.prepare("INSERT INTO sleep_log (baby_id, start_time, end_time, type) VALUES (?, ?, ?, 'nap')").run(babyId.id, start, end);
  db.close();
}

test.beforeEach(() => {
  resetDb();
});

test('History page shows logged sleeps', async ({ page }) => {
  seedBabyWithSleep();
  await page.goto('/#/history');
  await expect(page.locator('.sleep-log-item')).toHaveCount(1, { timeout: 5000 });
  await expect(page.locator('.log-meta')).toContainText('Nap');
});

test('History page shows empty state when no sleeps', async ({ page }) => {
  const db = getDb();
  db.prepare("INSERT INTO baby (name, birthdate) VALUES (?, ?)").run('Testa', '2025-06-12');
  db.prepare("INSERT INTO events (type, payload) VALUES ('baby.created', ?)").run(JSON.stringify({ name: 'Testa', birthdate: '2025-06-12' }));
  db.close();

  await page.goto('/#/history');
  await expect(page.locator('.history-empty')).toBeVisible({ timeout: 5000 });
});

test('Clicking a sleep entry opens edit modal', async ({ page }) => {
  seedBabyWithSleep();
  await page.goto('/#/history');
  await expect(page.locator('.sleep-log-item')).toHaveCount(1, { timeout: 5000 });

  await page.click('.sleep-log-item');
  await expect(page.locator('.modal h2')).toHaveText('Edit Sleep');
  await expect(page.locator('.type-pill.active')).toContainText('Nap');
});

test('Can edit a sleep entry type', async ({ page }) => {
  seedBabyWithSleep();
  await page.goto('/#/history');
  await expect(page.locator('.sleep-log-item')).toHaveCount(1, { timeout: 5000 });

  await page.click('.sleep-log-item');
  await expect(page.locator('.modal h2')).toHaveText('Edit Sleep');

  // Switch to night
  await page.click('.type-pill:has-text("Night")');
  await page.click('.modal .btn-primary');

  // Modal closes, entry should now show night
  await expect(page.locator('.modal')).not.toBeVisible({ timeout: 3000 });
  await expect(page.locator('.log-meta')).toContainText('Night');
});

test('Can delete a sleep entry', async ({ page }) => {
  seedBabyWithSleep();
  await page.goto('/#/history');
  await expect(page.locator('.sleep-log-item')).toHaveCount(1, { timeout: 5000 });

  await page.click('.sleep-log-item');
  page.on('dialog', dialog => dialog.accept());
  await page.click('.btn-danger');

  await expect(page.locator('.modal')).not.toBeVisible({ timeout: 3000 });
  await expect(page.locator('.history-empty')).toBeVisible({ timeout: 5000 });
});
