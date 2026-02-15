import { test, expect, createBaby, setWakeUpTime, getDb } from './fixtures';

test('Pause button appears when sleeping', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');
  await expect(page.getByTestId('sleep-button')).toHaveClass(/awake/);
  await expect(page.getByTestId('pause-btn')).not.toBeVisible();

  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });
  await expect(page.getByTestId('pause-btn')).toBeVisible();
  await expect(page.getByTestId('pause-btn')).toContainText('Pause');
});

test('Can pause and resume', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');

  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });

  await page.getByTestId('pause-btn').click();
  await expect(page.getByTestId('pause-btn')).toContainText('Resume', { timeout: 5000 });
  await expect(page.locator('.arc-center-label')).toContainText('Paused');

  await page.getByTestId('pause-btn').click();
  await expect(page.getByTestId('pause-btn')).toContainText('Pause', { timeout: 5000 });
  await expect(page.locator('.arc-center-label')).toContainText(/Napping|Sleeping/);
});

test('Timer adjusts for pause duration', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  const db = getDb();
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
  await expect(page.getByTestId('sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });

  const timerText = await page.locator('.arc-center-text .countdown-value').textContent();
  expect(timerText).toMatch(/^0[45]:/);
});

test('Multiple pauses work correctly', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');

  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });

  // First pause/resume
  await page.getByTestId('pause-btn').click();
  await expect(page.getByTestId('pause-btn')).toContainText('Resume', { timeout: 5000 });
  await page.getByTestId('pause-btn').click();
  await expect(page.getByTestId('pause-btn')).toContainText('Pause', { timeout: 5000 });

  // Second pause/resume
  await page.getByTestId('pause-btn').click();
  await expect(page.getByTestId('pause-btn')).toContainText('Resume', { timeout: 5000 });
  await page.getByTestId('pause-btn').click();
  await expect(page.getByTestId('pause-btn')).toContainText('Pause', { timeout: 5000 });

  const db = getDb();
  const pauses = db.prepare('SELECT * FROM sleep_pauses').all() as any[];
  expect(pauses.length).toBe(2);
  expect(pauses[0].resume_time).toBeTruthy();
  expect(pauses[1].resume_time).toBeTruthy();
  db.close();
});

test('History shows pause info', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  const db = getDb();
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
  await expect(page.locator('.sleep-log-item .log-meta').first()).toContainText('1 pause');
});
