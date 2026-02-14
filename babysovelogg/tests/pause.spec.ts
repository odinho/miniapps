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
  try { db.prepare('DELETE FROM baby').run(); } catch {}
  try { db.prepare('DELETE FROM events').run(); } catch {}
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

test('Pause button appears when sleeping', async ({ page }) => {
  createBaby('Testa');
  await page.goto('/');
  await expect(page.locator('.sleep-button')).toHaveClass(/awake/);
  // No pause button when awake
  await expect(page.locator('.pause-btn')).not.toBeVisible();

  // Start sleep
  await page.click('.sleep-button');
  await expect(page.locator('.sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });
  // Pause button should appear
  await expect(page.locator('.pause-btn')).toBeVisible();
  await expect(page.locator('.pause-btn')).toContainText('Pause');
});

test('Can pause and resume', async ({ page }) => {
  createBaby('Testa');
  await page.goto('/');

  // Start sleep
  await page.click('.sleep-button');
  await expect(page.locator('.sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });

  // Pause
  await page.click('.pause-btn');
  await expect(page.locator('.pause-btn')).toContainText('Resume', { timeout: 5000 });
  await expect(page.locator('.countdown-label')).toContainText('Paused');

  // Resume
  await page.click('.pause-btn');
  await expect(page.locator('.pause-btn')).toContainText('Pause', { timeout: 5000 });
  await expect(page.locator('.countdown-label')).toContainText('in progress');
});

test('Timer adjusts for pause duration', async ({ page }) => {
  createBaby('Testa');
  const db = getDb();
  const babyId = (db.prepare('SELECT id FROM baby ORDER BY id DESC LIMIT 1').get() as any).id;
  const now = Date.now();
  const startTime = new Date(now - 10 * 60000).toISOString();
  const pauseTime = new Date(now - 8 * 60000).toISOString();
  const resumeTime = new Date(now - 3 * 60000).toISOString();

  db.prepare("INSERT INTO events (type, payload) VALUES ('sleep.started', ?)").run(
    JSON.stringify({ babyId, startTime, type: 'nap' })
  );
  db.prepare("INSERT INTO sleep_log (baby_id, start_time, type) VALUES (?, ?, 'nap')").run(babyId, startTime);
  const sleepId = (db.prepare('SELECT id FROM sleep_log ORDER BY id DESC LIMIT 1').get() as any).id;

  db.prepare("INSERT INTO events (type, payload) VALUES ('sleep.paused', ?)").run(
    JSON.stringify({ sleepId, pauseTime })
  );
  db.prepare("INSERT INTO sleep_pauses (sleep_id, pause_time, resume_time) VALUES (?, ?, ?)").run(
    sleepId, pauseTime, resumeTime
  );
  db.prepare("INSERT INTO events (type, payload) VALUES ('sleep.resumed', ?)").run(
    JSON.stringify({ sleepId, resumeTime })
  );
  db.close();

  await page.goto('/');
  await expect(page.locator('.sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });

  // Timer should show ~5 minutes (10 min elapsed - 5 min paused), not 10 minutes
  const timerText = await page.locator('.countdown .countdown-value').textContent();
  // Should be around 05:xx, not 10:xx
  expect(timerText).toMatch(/^0[45]:/);
});

test('Multiple pauses work correctly', async ({ page }) => {
  createBaby('Testa');
  await page.goto('/');

  // Start sleep
  await page.click('.sleep-button');
  await expect(page.locator('.sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });

  // First pause/resume
  await page.click('.pause-btn');
  await expect(page.locator('.pause-btn')).toContainText('Resume', { timeout: 5000 });
  await page.click('.pause-btn');
  await expect(page.locator('.pause-btn')).toContainText('Pause', { timeout: 5000 });

  // Second pause/resume
  await page.click('.pause-btn');
  await expect(page.locator('.pause-btn')).toContainText('Resume', { timeout: 5000 });
  await page.click('.pause-btn');
  await expect(page.locator('.pause-btn')).toContainText('Pause', { timeout: 5000 });

  // Verify pauses stored in DB
  const db = getDb();
  const pauses = db.prepare('SELECT * FROM sleep_pauses').all() as any[];
  expect(pauses.length).toBe(2);
  expect(pauses[0].resume_time).toBeTruthy();
  expect(pauses[1].resume_time).toBeTruthy();
  db.close();
});

test('History shows pause info', async ({ page }) => {
  createBaby('Testa');
  const db = getDb();
  const babyId = (db.prepare('SELECT id FROM baby ORDER BY id DESC LIMIT 1').get() as any).id;
  const now = Date.now();
  const startTime = new Date(now - 60 * 60000).toISOString();
  const endTime = new Date(now - 10 * 60000).toISOString();
  const pauseTime = new Date(now - 50 * 60000).toISOString();
  const resumeTime2 = new Date(now - 40 * 60000).toISOString();

  db.prepare("INSERT INTO events (type, payload) VALUES ('sleep.started', ?)").run(
    JSON.stringify({ babyId, startTime, type: 'nap' })
  );
  db.prepare("INSERT INTO sleep_log (baby_id, start_time, end_time, type) VALUES (?, ?, ?, 'nap')").run(babyId, startTime, endTime);
  const sleepId = (db.prepare('SELECT id FROM sleep_log ORDER BY id DESC LIMIT 1').get() as any).id;
  db.prepare("INSERT INTO sleep_pauses (sleep_id, pause_time, resume_time) VALUES (?, ?, ?)").run(
    sleepId, pauseTime, resumeTime2
  );
  db.close();

  await page.goto('/#/history');
  await expect(page.locator('.sleep-log-item').first()).toBeVisible({ timeout: 5000 });
  // Should show pause info
  await expect(page.locator('.sleep-log-item .log-meta').first()).toContainText('1 pause');
});
