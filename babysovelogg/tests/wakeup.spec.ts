import { test, expect, createBaby, getDb } from './fixtures';

test('Shows morning prompt when no wake-up time and no sleeps', async ({ page }) => {
  createBaby('Testa');
  await page.goto('/');
  
  await expect(page.locator('.morning-prompt')).toBeVisible();
  await expect(page.locator('.morning-prompt h2')).toHaveText('Good morning!');
  await expect(page.locator('.morning-icon')).toHaveText('🌅');
  
  await expect(page.locator('.morning-prompt input[type="date"]')).toBeVisible();
  await expect(page.locator('.morning-prompt input[type="time"]')).toBeVisible();
  
  await expect(page.getByRole('button', { name: 'Set Wake-up Time' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Skip for now' })).toBeVisible();
});

test('Can set wake-up time via morning prompt', async ({ page }) => {
  createBaby('Testa');
  
  await page.goto('/');
  await expect(page.locator('.morning-prompt')).toBeVisible();
  
  const today = new Date();
  const dateStr = today.toISOString().split('T')[0];
  await page.locator('.morning-prompt input[type="date"]').fill(dateStr);
  await page.locator('.morning-prompt input[type="time"]').fill('07:30');
  
  const responsePromise = page.waitForResponse(resp => resp.url().includes('/api/events') && resp.request().method() === 'POST');
  await page.getByRole('button', { name: 'Set Wake-up Time' }).click();
  const response = await responsePromise;
  const postEventResponse = await response.json();
  
  await expect(page.locator('.morning-prompt')).not.toBeVisible({ timeout: 5000 });
  await expect(page.locator('.dashboard')).toBeVisible();
  await expect(page.locator('.sleep-button')).toBeVisible();
  
  expect(postEventResponse).toBeTruthy();
  expect(postEventResponse.state.todayWakeUp).toBeTruthy();
  
  const db = getDb();
  const baby = db.prepare('SELECT * FROM baby ORDER BY id DESC LIMIT 1').get() as any;
  const wakeUp = db.prepare('SELECT * FROM day_start WHERE baby_id = ?').get(baby.id) as any;
  expect(wakeUp).toBeTruthy();
  expect(wakeUp.wake_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  expect(wakeUp.date).toBe(dateStr);
  db.close();
});

test('Skip button creates default wake-up time', async ({ page }) => {
  createBaby('Testa');
  await page.goto('/');
  
  await expect(page.locator('.morning-prompt')).toBeVisible();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  
  await expect(page.locator('.morning-prompt')).not.toBeVisible({ timeout: 5000 });
  await expect(page.locator('.dashboard')).toBeVisible();
  
  const db = getDb();
  const baby = db.prepare('SELECT * FROM baby ORDER BY id DESC LIMIT 1').get() as any;
  const wakeUp = db.prepare('SELECT * FROM day_start WHERE baby_id = ?').get(baby.id) as any;
  expect(wakeUp).toBeTruthy();
  const wakeDate = new Date(wakeUp.wake_time);
  expect(wakeDate.getHours()).toBe(6);
  expect(wakeDate.getMinutes()).toBe(0);
  db.close();
});

test('Does not show morning prompt when wake-up time already set', async ({ page }) => {
  createBaby('Testa');
  
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
  await expect(page.locator('.morning-prompt')).not.toBeVisible();
  await expect(page.locator('.dashboard')).toBeVisible();
});

test('Does not show morning prompt when sleep already logged today', async ({ page }) => {
  createBaby('Testa');
  
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
  await expect(page.locator('.morning-prompt')).not.toBeVisible();
  await expect(page.locator('.dashboard')).toBeVisible();
});

test('Arc uses wake-up time as starting point', async ({ page }) => {
  createBaby('Testa');
  
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
  await expect(page.locator('.sleep-arc')).toBeVisible();
  
  const labels = await page.locator('.arc-hour-label').allTextContents();
  expect(labels[0]).toBe('08');
});

test('Shows predicted nap bubbles when no sleeps yet', async ({ page }) => {
  createBaby('Testa', '2025-10-01');
  
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
  
  const predictedNapBubbles = page.locator('.arc-bubble-predicted:not(.arc-bedtime)');
  await expect(predictedNapBubbles).toHaveCount(3, { timeout: 5000 });
  await expect(page.locator('.arc-center-label')).toContainText('Next nap');
});

test('Shows bedtime bubble at arc end', async ({ page }) => {
  createBaby('Testa', '2025-10-01');
  
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
  await expect(page.locator('.arc-bedtime')).toBeVisible();
});

test('Predicted bubbles are replaced by actual sleeps', async ({ page }) => {
  createBaby('Testa', '2025-10-01');
  
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
  
  await expect(page.locator('.arc-bubble-predicted:not(.arc-bedtime)')).toHaveCount(3, { timeout: 5000 });
  
  await page.locator('.sleep-button').click();
  await expect(page.locator('.sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });
  
  await expect(page.locator('.arc-bubble-active')).toHaveCount(1);
});

test('Morning prompt only shows once per day', async ({ page }) => {
  createBaby('Testa');
  
  await page.goto('/');
  await expect(page.locator('.morning-prompt')).toBeVisible();
  
  const today = new Date();
  const dateStr = today.toISOString().split('T')[0];
  await page.locator('.morning-prompt input[type="date"]').fill(dateStr);
  await page.locator('.morning-prompt input[type="time"]').fill('07:00');
  await page.getByRole('button', { name: 'Set Wake-up Time' }).click();
  
  await expect(page.locator('.dashboard')).toBeVisible({ timeout: 5000 });
  
  await page.reload();
  
  await expect(page.locator('.morning-prompt')).not.toBeVisible();
  await expect(page.locator('.dashboard')).toBeVisible();
});
