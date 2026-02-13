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

function createBaby(name = 'Testa', birthdate = '2025-06-12') {
  const db = getDb();
  db.prepare("INSERT INTO events (type, payload) VALUES ('baby.created', ?)").run(JSON.stringify({ name, birthdate }));
  db.prepare("INSERT INTO baby (name, birthdate) VALUES (?, ?)").run(name, birthdate);
  db.close();
}

test.beforeEach(() => {
  resetDb();
});

test('Dashboard shows baby name and sleep button', async ({ page }) => {
  createBaby('Testa');
  await page.goto('/');
  await expect(page.locator('.baby-name')).toHaveText('Testa');
  await expect(page.locator('.baby-age')).toContainText('old');
  await expect(page.locator('.sleep-button')).toBeVisible();
  await expect(page.locator('.sleep-button')).toHaveClass(/awake/);
});

test('Can start and stop a nap', async ({ page }) => {
  createBaby('Testa');
  await page.goto('/');

  // Start sleep
  await page.click('.sleep-button');
  await expect(page.locator('.sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });
  await expect(page.locator('.countdown-label')).toContainText('in progress');

  // Stop sleep
  await page.click('.sleep-button');
  await expect(page.locator('.sleep-button')).toHaveClass(/awake/, { timeout: 5000 });
});

test('Dashboard shows stats section', async ({ page }) => {
  createBaby('Testa');
  await page.goto('/');
  await expect(page.locator('.baby-name')).toHaveText('Testa', { timeout: 5000 });

  // Stats row should be visible with cards
  await expect(page.locator('.stats-row')).toBeVisible();
  await expect(page.locator('.stats-card')).toHaveCount(3);
  await expect(page.locator('.stat-label').nth(0)).toHaveText('Naps today');
  await expect(page.locator('.stat-label').nth(1)).toHaveText('Nap time');
  await expect(page.locator('.stat-label').nth(2)).toHaveText('Total sleep');
});

test('FAB button opens manual sleep modal', async ({ page }) => {
  createBaby('Testa');
  await page.goto('/');

  await page.click('.fab');
  await expect(page.locator('.modal h2')).toHaveText('Add Sleep');
  await expect(page.locator('.modal input[type="datetime-local"]').first()).toBeVisible();
});

test('Can add manual sleep entry', async ({ page }) => {
  createBaby('Testa');
  await page.goto('/');
  await expect(page.locator('.baby-name')).toHaveText('Testa', { timeout: 5000 });

  await page.click('.fab');
  await expect(page.locator('.modal h2')).toHaveText('Add Sleep');
  // Default values are pre-filled (1 hour ago to now), just save
  await page.click('.modal .btn-primary');

  await expect(page.locator('.modal-overlay')).not.toBeVisible({ timeout: 5000 });
  // Total sleep stat (3rd card) should show non-zero value after adding a 1-hour sleep
  await expect(page.locator('.stat-value').nth(2)).not.toHaveText('0m');
});

test('Redirects to settings when no baby exists', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Welcome to Napper');
});
