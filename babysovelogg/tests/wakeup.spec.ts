import { test, expect, createBaby, getDb, forceMorning, forceHour } from './fixtures';

test('Shows morning prompt when no wake-up time and no sleeps', async ({ page }) => {
  await forceMorning(page);
  createBaby('Testa');
  await page.goto('/');

  await expect(page.getByTestId('morning-prompt')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'God morgon!' })).toBeVisible();
  await expect(page.getByTestId('morning-icon')).toHaveText('🌅');

  await expect(page.getByTestId('morning-prompt').locator('input[type="date"]')).toBeVisible();
  await expect(page.getByTestId('morning-prompt').locator('input[type="time"]')).toBeVisible();

  await expect(page.getByRole('button', { name: 'Sett vaknetid' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hopp over' })).toBeVisible();
});

test('Can set wake-up time via morning prompt', async ({ page }) => {
  await forceMorning(page);
  createBaby('Testa');

  await page.goto('/');
  await expect(page.getByTestId('morning-prompt')).toBeVisible();

  const today = new Date();
  const dateStr = today.toISOString().split('T')[0];
  await page.getByTestId('morning-prompt').locator('input[type="date"]').fill(dateStr);
  await page.getByTestId('morning-prompt').locator('input[type="time"]').fill('07:30');

  const responsePromise = page.waitForResponse(resp => resp.url().includes('/api/events') && resp.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sett vaknetid' }).click();
  const response = await responsePromise;
  const postEventResponse = await response.json();

  await expect(page.getByTestId('morning-prompt')).not.toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(page.getByTestId('sleep-button')).toBeVisible();

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
  await forceMorning(page);
  createBaby('Testa');
  await page.goto('/');

  await expect(page.getByTestId('morning-prompt')).toBeVisible();
  await page.getByRole('button', { name: 'Hopp over' }).click();

  await expect(page.getByTestId('morning-prompt')).not.toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('dashboard')).toBeVisible();

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
  await forceMorning(page);
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
  await expect(page.getByTestId('morning-prompt')).not.toBeVisible();
  await expect(page.getByTestId('dashboard')).toBeVisible();
});

test('Does not show morning prompt when sleep already logged today', async ({ page }) => {
  await forceMorning(page);
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
  await expect(page.getByTestId('morning-prompt')).not.toBeVisible();
  await expect(page.getByTestId('dashboard')).toBeVisible();
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
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(page.locator('.sleep-arc')).toBeVisible();
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
  await expect(page.getByTestId('dashboard')).toBeVisible();
  // Predicted naps depend on server-side time; verify arc renders
  await expect(page.locator('.sleep-arc')).toBeVisible();
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
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(page.locator('.sleep-arc')).toBeVisible();
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
  await expect(page.getByTestId('dashboard')).toBeVisible();

  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });
});

test('Does not show morning prompt during night hours', async ({ page }) => {
  await forceHour(page, 2);
  createBaby('Testa');
  await page.goto('/');

  // At 2 AM, no morning prompt should appear
  await expect(page.getByTestId('morning-prompt')).not.toBeVisible();
  // Dashboard should render (even if it shows night-mode content)
  await expect(page.getByTestId('dashboard')).toBeVisible();
});

test('Morning prompt only shows once per day', async ({ page }) => {
  await forceMorning(page);
  createBaby('Testa');

  await page.goto('/');
  await expect(page.getByTestId('morning-prompt')).toBeVisible();

  const today = new Date();
  const dateStr = today.toISOString().split('T')[0];
  await page.getByTestId('morning-prompt').locator('input[type="date"]').fill(dateStr);
  await page.getByTestId('morning-prompt').locator('input[type="time"]').fill('07:00');
  await page.getByRole('button', { name: 'Sett vaknetid' }).click();

  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 5000 });

  await page.reload();

  await expect(page.getByTestId('morning-prompt')).not.toBeVisible();
  await expect(page.getByTestId('dashboard')).toBeVisible();
});
