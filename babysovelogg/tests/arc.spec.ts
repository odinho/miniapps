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

function createBaby(name = 'Testa', birthdate = '2025-06-12'): number {
  const db = getDb();
  db.prepare("INSERT INTO events (type, payload) VALUES ('baby.created', ?)").run(JSON.stringify({ name, birthdate }));
  const info = db.prepare("INSERT INTO baby (name, birthdate) VALUES (?, ?)").run(name, birthdate);
  db.close();
  return Number(info.lastInsertRowid);
}

function addCompletedSleep(babyId: number, startTime: string, endTime: string, type = 'nap') {
  const db = getDb();
  db.prepare("INSERT INTO sleep_log (baby_id, start_time, end_time, type) VALUES (?, ?, ?, ?)").run(babyId, startTime, endTime, type);
  db.close();
}

function addActiveSleep(babyId: number, startTime: string, type = 'nap') {
  const db = getDb();
  db.prepare("INSERT INTO sleep_log (baby_id, start_time, type) VALUES (?, ?, ?)").run(babyId, startTime, type);
  db.close();
}

test.beforeEach(() => {
  resetDb();
});

test('Arc renders on dashboard', async ({ page }) => {
  createBaby('Testa');
  await page.goto('/');
  await expect(page.locator('.baby-name')).toHaveText('Testa');
  await expect(page.locator('.sleep-arc')).toBeVisible();
  await expect(page.locator('.arc-container')).toBeVisible();
  // Arc track path exists
  await expect(page.locator('.arc-track')).toBeVisible();
});

test('Completed sleeps appear as filled bubbles on arc', async ({ page }) => {
  const babyId = createBaby('Testa');
  const now = new Date();
  const start = new Date(now.getTime() - 2 * 3600000); // 2h ago
  const end = new Date(now.getTime() - 1 * 3600000);   // 1h ago
  addCompletedSleep(babyId, start.toISOString(), end.toISOString(), 'nap');

  await page.goto('/');
  await expect(page.locator('.sleep-arc')).toBeVisible();
  // Should have a completed bubble
  await expect(page.locator('.arc-bubble-completed')).toHaveCount(1);
});

test('Predicted nap shown with dashed outline', async ({ page }) => {
  const babyId = createBaby('Testa');
  const now = new Date();
  const start = new Date(now.getTime() - 2 * 3600000);
  const end = new Date(now.getTime() - 30 * 60000); // ended 30min ago
  addCompletedSleep(babyId, start.toISOString(), end.toISOString(), 'nap');

  await page.goto('/');
  await expect(page.locator('.sleep-arc')).toBeVisible();
  // Predicted bubble should exist (dashed)
  await expect(page.locator('.arc-bubble-predicted')).toHaveCount(1);
});

test('Active sleep has pulsing animation class', async ({ page }) => {
  const babyId = createBaby('Testa');
  const start = new Date(Date.now() - 20 * 60000); // 20min ago
  addActiveSleep(babyId, start.toISOString(), 'nap');

  await page.goto('/');
  await expect(page.locator('.sleep-arc')).toBeVisible();
  await expect(page.locator('.arc-bubble-active')).toHaveCount(1);
  // The rect inside should have the pulse class
  await expect(page.locator('.arc-active-pulse')).toHaveCount(1);
});

test('Arc center shows countdown when not sleeping', async ({ page }) => {
  const babyId = createBaby('Testa');
  const now = new Date();
  const start = new Date(now.getTime() - 2 * 3600000);
  const end = new Date(now.getTime() - 30 * 60000);
  addCompletedSleep(babyId, start.toISOString(), end.toISOString(), 'nap');

  await page.goto('/');
  await expect(page.locator('.arc-center-text')).toBeVisible();
  await expect(page.locator('.arc-center-label')).toContainText('Next nap');
});

test('Arc center shows timer when sleeping', async ({ page }) => {
  const babyId = createBaby('Testa');
  addActiveSleep(babyId, new Date(Date.now() - 10 * 60000).toISOString(), 'nap');

  await page.goto('/');
  await expect(page.locator('.arc-center-text')).toBeVisible();
  await expect(page.locator('.arc-center-label')).toContainText('Napping');
});
