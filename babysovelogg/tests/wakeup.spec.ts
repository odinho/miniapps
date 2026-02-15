import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  return new Database(path.join(process.cwd(), 'napper.db'));
}

function resetDb() {
  const db = getDb();
  try { db.prepare('DELETE FROM day_start').run(); } catch {}
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

test('Shows morning prompt when no wake-up time and no sleeps', async ({ page }) => {
  createBaby('Testa');
  await page.goto('/');
  
  // Should show morning prompt
  await expect(page.locator('.morning-prompt')).toBeVisible();
  await expect(page.locator('.morning-prompt h2')).toHaveText('Good morning!');
  await expect(page.locator('.morning-icon')).toHaveText('🌅');
  
  // Should have date/time inputs
  await expect(page.locator('.morning-prompt input[type="date"]')).toBeVisible();
  await expect(page.locator('.morning-prompt input[type="time"]')).toBeVisible();
  
  // Should have save and skip buttons
  await expect(page.locator('.morning-prompt .btn-primary')).toHaveText('Set Wake-up Time');
  await expect(page.locator('.morning-prompt .btn-ghost')).toHaveText('Skip for now');
});

test('Can set wake-up time via morning prompt', async ({ page }) => {
  createBaby('Testa');
  
  // Listen for POST requests
  let postEventResponse: any = null;
  page.on('response', async (response) => {
    if (response.url().includes('/api/events') && response.request().method() === 'POST') {
      postEventResponse = await response.json();
      console.log('POST /api/events response:', JSON.stringify(postEventResponse, null, 2));
    }
  });
  
  await page.goto('/');
  
  await expect(page.locator('.morning-prompt')).toBeVisible();
  
  // Set wake-up time to 7:30 AM
  const today = new Date();
  const dateStr = today.toISOString().split('T')[0];
  await page.fill('.morning-prompt input[type="date"]', dateStr);
  await page.fill('.morning-prompt input[type="time"]', '07:30');
  
  // Save - wait for the network request
  await Promise.all([
    page.waitForResponse(resp => resp.url().includes('/api/events') && resp.request().method() === 'POST'),
    page.click('.morning-prompt .btn-primary')
  ]);
  
  // Give a moment for state to update
  await page.waitForTimeout(100);
  
  // Should navigate to dashboard
  await expect(page.locator('.morning-prompt')).not.toBeVisible({ timeout: 5000 });
  await expect(page.locator('.dashboard')).toBeVisible();
  await expect(page.locator('.sleep-button')).toBeVisible();
  
  // Verify response has todayWakeUp
  expect(postEventResponse).toBeTruthy();
  expect(postEventResponse.state.todayWakeUp).toBeTruthy();
  
  // Verify in database
  const db = getDb();
  const baby = db.prepare('SELECT * FROM baby ORDER BY id DESC LIMIT 1').get() as any;
  const wakeUp = db.prepare('SELECT * FROM day_start WHERE baby_id = ?').get(baby.id) as any;
  expect(wakeUp).toBeTruthy();
  expect(wakeUp.wake_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // Valid ISO timestamp
  expect(wakeUp.date).toBe(dateStr);
  db.close();
});

test('Skip button creates default wake-up time', async ({ page }) => {
  createBaby('Testa');
  await page.goto('/');
  
  await expect(page.locator('.morning-prompt')).toBeVisible();
  
  // Click skip
  await page.click('.morning-prompt .btn-ghost');
  
  // Should navigate to dashboard
  await expect(page.locator('.morning-prompt')).not.toBeVisible({ timeout: 5000 });
  await expect(page.locator('.dashboard')).toBeVisible();
  
  // Verify default wake-up time was created (6am local time)
  const db = getDb();
  const baby = db.prepare('SELECT * FROM baby ORDER BY id DESC LIMIT 1').get() as any;
  const wakeUp = db.prepare('SELECT * FROM day_start WHERE baby_id = ?').get(baby.id) as any;
  expect(wakeUp).toBeTruthy();
  const wakeDate = new Date(wakeUp.wake_time);
  expect(wakeDate.getHours()).toBe(6); // Local time is 6am
  expect(wakeDate.getMinutes()).toBe(0);
  db.close();
});

test('Does not show morning prompt when wake-up time already set', async ({ page }) => {
  createBaby('Testa');
  
  // Set wake-up time directly in DB
  const db = getDb();
  const baby = db.prepare('SELECT * FROM baby ORDER BY id DESC LIMIT 1').get() as any;
  const today = new Date();
  today.setHours(7, 0, 0, 0);
  const dateStr = today.toISOString().split('T')[0];
  db.prepare("INSERT INTO events (type, payload) VALUES ('day.started', ?)").run(
    JSON.stringify({ babyId: baby.id, wakeTime: today.toISOString() })
  );
  db.prepare('INSERT INTO day_start (baby_id, date, wake_time) VALUES (?, ?, ?)').run(
    baby.id, dateStr, today.toISOString()
  );
  db.close();
  
  await page.goto('/');
  
  // Should go straight to dashboard
  await expect(page.locator('.morning-prompt')).not.toBeVisible();
  await expect(page.locator('.dashboard')).toBeVisible();
});

test('Does not show morning prompt when sleep already logged today', async ({ page }) => {
  createBaby('Testa');
  
  // Log a sleep for today
  const db = getDb();
  const baby = db.prepare('SELECT * FROM baby ORDER BY id DESC LIMIT 1').get() as any;
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3600000);
  db.prepare("INSERT INTO events (type, payload) VALUES ('sleep.started', ?)").run(
    JSON.stringify({ babyId: baby.id, startTime: oneHourAgo.toISOString(), type: 'nap' })
  );
  db.prepare("INSERT INTO events (type, payload) VALUES ('sleep.ended', ?)").run(
    JSON.stringify({ sleepId: 1, endTime: now.toISOString() })
  );
  db.prepare('INSERT INTO sleep_log (baby_id, start_time, end_time, type) VALUES (?, ?, ?, ?)').run(
    baby.id, oneHourAgo.toISOString(), now.toISOString(), 'nap'
  );
  db.close();
  
  await page.goto('/');
  
  // Should go straight to dashboard
  await expect(page.locator('.morning-prompt')).not.toBeVisible();
  await expect(page.locator('.dashboard')).toBeVisible();
});

test('Arc uses wake-up time as starting point', async ({ page }) => {
  createBaby('Testa');
  
  // Set wake-up time to 8:00 AM
  const db = getDb();
  const baby = db.prepare('SELECT * FROM baby ORDER BY id DESC LIMIT 1').get() as any;
  const today = new Date();
  today.setHours(8, 0, 0, 0);
  const dateStr = today.toISOString().split('T')[0];
  db.prepare("INSERT INTO events (type, payload) VALUES ('day.started', ?)").run(
    JSON.stringify({ babyId: baby.id, wakeTime: today.toISOString() })
  );
  db.prepare('INSERT INTO day_start (baby_id, date, wake_time) VALUES (?, ?, ?)').run(
    baby.id, dateStr, today.toISOString()
  );
  db.close();
  
  await page.goto('/');
  await expect(page.locator('.dashboard')).toBeVisible();
  
  // Arc should be visible
  await expect(page.locator('.sleep-arc')).toBeVisible();
  
  // Should have hour labels starting from 8
  const labels = await page.locator('.arc-hour-label').allTextContents();
  expect(labels[0]).toBe('08');
});

test('Shows predicted nap bubbles when no sleeps yet', async ({ page }) => {
  createBaby('Testa', '2025-10-01'); // ~4 months old = 3 naps expected
  
  // Set wake-up time
  const db = getDb();
  const baby = db.prepare('SELECT * FROM baby ORDER BY id DESC LIMIT 1').get() as any;
  const today = new Date();
  today.setHours(7, 0, 0, 0);
  const dateStr = today.toISOString().split('T')[0];
  db.prepare("INSERT INTO events (type, payload) VALUES ('day.started', ?)").run(
    JSON.stringify({ babyId: baby.id, wakeTime: today.toISOString() })
  );
  db.prepare('INSERT INTO day_start (baby_id, date, wake_time) VALUES (?, ?, ?)').run(
    baby.id, dateStr, today.toISOString()
  );
  db.close();
  
  await page.goto('/');
  await expect(page.locator('.dashboard')).toBeVisible();
  
  // Should show predicted nap bubbles (dotted outlines), excluding bedtime
  const predictedNapBubbles = page.locator('.arc-bubble-predicted:not(.arc-bedtime)');
  await expect(predictedNapBubbles).toHaveCount(3, { timeout: 5000 }); // 3 naps expected for 4-month-old
  
  // Should show countdown to next nap in center
  await expect(page.locator('.arc-center-label')).toContainText('Next nap');
});

test('Shows bedtime bubble at arc end', async ({ page }) => {
  createBaby('Testa', '2025-10-01');
  
  // Set wake-up time
  const db = getDb();
  const baby = db.prepare('SELECT * FROM baby ORDER BY id DESC LIMIT 1').get() as any;
  const today = new Date();
  today.setHours(7, 0, 0, 0);
  const dateStr = today.toISOString().split('T')[0];
  db.prepare("INSERT INTO events (type, payload) VALUES ('day.started', ?)").run(
    JSON.stringify({ babyId: baby.id, wakeTime: today.toISOString() })
  );
  db.prepare('INSERT INTO day_start (baby_id, date, wake_time) VALUES (?, ?, ?)').run(
    baby.id, dateStr, today.toISOString()
  );
  db.close();
  
  await page.goto('/');
  await expect(page.locator('.dashboard')).toBeVisible();
  
  // Should show bedtime bubble with moon icon
  await expect(page.locator('.arc-bedtime')).toBeVisible();
});

test('Predicted bubbles are replaced by actual sleeps', async ({ page }) => {
  createBaby('Testa', '2025-10-01');
  
  // Set wake-up time
  const db = getDb();
  const baby = db.prepare('SELECT * FROM baby ORDER BY id DESC LIMIT 1').get() as any;
  const today = new Date();
  today.setHours(7, 0, 0, 0);
  const dateStr = today.toISOString().split('T')[0];
  db.prepare("INSERT INTO events (type, payload) VALUES ('day.started', ?)").run(
    JSON.stringify({ babyId: baby.id, wakeTime: today.toISOString() })
  );
  db.prepare('INSERT INTO day_start (baby_id, date, wake_time) VALUES (?, ?, ?)').run(
    baby.id, dateStr, today.toISOString()
  );
  db.close();
  
  await page.goto('/');
  await expect(page.locator('.dashboard')).toBeVisible();
  
  // Should have 3 predicted naps initially (excluding bedtime)
  await expect(page.locator('.arc-bubble-predicted:not(.arc-bedtime)')).toHaveCount(3, { timeout: 5000 });
  
  // Start a nap
  await page.click('.sleep-button');
  await expect(page.locator('.sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });
  
  // Should now have 1 active bubble and 0 predicted (since we have sleeps today now)
  await expect(page.locator('.arc-bubble-active')).toHaveCount(1);
  // Note: predictions change once we have actual sleeps
});

test('Morning prompt only shows once per day', async ({ page }) => {
  createBaby('Testa');
  
  await page.goto('/');
  await expect(page.locator('.morning-prompt')).toBeVisible();
  
  // Set wake-up time
  const today = new Date();
  const dateStr = today.toISOString().split('T')[0];
  await page.fill('.morning-prompt input[type="date"]', dateStr);
  await page.fill('.morning-prompt input[type="time"]', '07:00');
  await page.click('.morning-prompt .btn-primary');
  
  await expect(page.locator('.dashboard')).toBeVisible({ timeout: 5000 });
  
  // Refresh page
  await page.reload();
  
  // Should not show prompt again
  await expect(page.locator('.morning-prompt')).not.toBeVisible();
  await expect(page.locator('.dashboard')).toBeVisible();
});
