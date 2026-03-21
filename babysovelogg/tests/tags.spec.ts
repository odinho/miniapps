import { test, expect, createBaby, setWakeUpTime, getDb, dismissSheet, forceMorning } from './fixtures';

test.beforeEach(async ({ page }) => {
  await forceMorning(page);
});

test('Tag sheet appears after starting sleep', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');

  // Start sleep — bedtime tag sheet appears
  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });
  await expect(page.getByRole('heading', { name: 'Korleis gjekk legginga?' })).toBeVisible({ timeout: 5000 });
});

test('Can select mood and method and save', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');

  // Start sleep — tag sheet appears
  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });
  await expect(page.getByRole('heading', { name: 'Korleis gjekk legginga?' })).toBeVisible({ timeout: 5000 });

  await page.getByRole('button', { name: 'Glad' }).click();
  await expect(page.getByRole('button', { name: 'Glad' })).toHaveClass(/active/);

  await page.getByRole('button', { name: 'Amming' }).click();
  await expect(page.getByRole('button', { name: 'Amming' })).toHaveClass(/active/);

  await page.getByRole('button', { name: 'Ferdig' }).click();
  await expect(page.getByTestId('modal-overlay')).not.toBeVisible({ timeout: 5000 });

  // Sleep should still be running
  await expect(page.getByTestId('sleep-button')).toHaveClass(/sleeping/);

  // End sleep — dismiss wake-up sheet
  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/awake/, { timeout: 5000 });
  await dismissSheet(page);

  // Verify tags in history
  await page.locator('.nav-bar').getByText('Logg').click();
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
  const badges = page.locator('.tag-badges .tag-badge');
  await expect(badges).toHaveCount(2);
});

test('Can select fall-asleep bucket and enter note', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');

  // Start sleep — tag sheet appears
  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });
  await expect(page.getByRole('heading', { name: 'Korleis gjekk legginga?' })).toBeVisible({ timeout: 5000 });

  // Select fall-asleep bucket
  await page.getByRole('button', { name: '5–15 min' }).click();
  await expect(page.getByRole('button', { name: '5–15 min' })).toHaveClass(/active/);

  // Enter note
  await page.locator('input[placeholder="Valfritt notat..."]').fill('Sovna fort i dag');

  await page.getByRole('button', { name: 'Ferdig' }).click();
  await expect(page.getByTestId('modal-overlay')).not.toBeVisible({ timeout: 5000 });

  // Verify in DB
  const db = getDb();
  const sleep = db.prepare('SELECT * FROM sleep_log ORDER BY id DESC LIMIT 1').get() as any;
  expect(sleep.fall_asleep_time).toBe('5-15');
  expect(sleep.notes).toBe('Sovna fort i dag');
  db.close();
});

test('Wake-up sheet appears after ending sleep', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');

  // Start sleep
  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });
  await dismissSheet(page);

  // End sleep — wake-up sheet should appear
  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/awake/, { timeout: 5000 });

  await expect(page.getByRole('heading', { name: 'Oppvakning' })).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole('button', { name: 'Vakna sjølv' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Vekt av oss' })).toBeVisible();
});

test('Can save wake-up info with woke-by and note', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');

  // Start sleep + dismiss tag sheet
  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });
  await dismissSheet(page);

  // End sleep
  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/awake/, { timeout: 5000 });
  await expect(page.getByRole('heading', { name: 'Oppvakning' })).toBeVisible({ timeout: 5000 });

  // Select "Vakna sjølv" and enter note
  await page.getByRole('button', { name: 'Vakna sjølv' }).click();
  await expect(page.getByRole('button', { name: 'Vakna sjølv' })).toHaveClass(/active/);
  await page.locator('input[placeholder="Valfritt notat..."]').fill('Glad og uthvilt');
  await page.getByRole('button', { name: 'Ferdig' }).click();
  await expect(page.getByTestId('modal-overlay')).not.toBeVisible({ timeout: 5000 });

  // Verify in DB
  const db = getDb();
  const sleep = db.prepare('SELECT * FROM sleep_log ORDER BY id DESC LIMIT 1').get() as any;
  expect(sleep.woke_by).toBe('self');
  expect(sleep.wake_notes).toBe('Glad og uthvilt');
  db.close();
});

test('Wake-up sheet shows compact bedtime summary when tags were set', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');

  // Start sleep — set some bedtime tags
  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });
  await expect(page.getByRole('heading', { name: 'Korleis gjekk legginga?' })).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: 'Glad' }).click();
  await page.getByRole('button', { name: 'Amming' }).click();
  await page.getByRole('button', { name: 'Ferdig' }).click();
  await expect(page.getByTestId('modal-overlay')).not.toBeVisible({ timeout: 5000 });

  // End sleep — wake-up sheet should show bedtime summary
  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/awake/, { timeout: 5000 });
  await expect(page.getByRole('heading', { name: 'Oppvakning' })).toBeVisible({ timeout: 5000 });

  // Compact bedtime summary card should be visible
  const summary = page.getByTestId('bedtime-summary');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('Legging');
  // Should show mood and method emoji badges
  await expect(summary.locator('.tag-badge')).toHaveCount(2);
});

test('Wake-up sheet without bedtime tags shows no summary', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');

  // Start sleep — skip tag sheet
  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });
  await dismissSheet(page);

  // End sleep — no bedtime tags, so no summary
  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/awake/, { timeout: 5000 });
  await expect(page.getByRole('heading', { name: 'Oppvakning' })).toBeVisible({ timeout: 5000 });

  await expect(page.getByTestId('bedtime-summary')).not.toBeVisible();
});

test('Bedtime tags are NOT overwritten by wake-up sheet', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');

  // Start sleep — save bedtime tags
  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });
  await expect(page.getByRole('heading', { name: 'Korleis gjekk legginga?' })).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: 'Glad' }).click();
  await page.getByRole('button', { name: 'Amming' }).click();
  await page.getByRole('button', { name: 'Ferdig' }).click();
  await expect(page.getByTestId('modal-overlay')).not.toBeVisible({ timeout: 5000 });

  // End sleep — save wake-up info
  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/awake/, { timeout: 5000 });
  await expect(page.getByRole('heading', { name: 'Oppvakning' })).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: 'Vekt av oss' }).click();
  await page.getByRole('button', { name: 'Ferdig' }).click();
  await expect(page.getByTestId('modal-overlay')).not.toBeVisible({ timeout: 5000 });

  // Verify bedtime tags still intact
  const db = getDb();
  const sleep = db.prepare('SELECT * FROM sleep_log ORDER BY id DESC LIMIT 1').get() as any;
  expect(sleep.mood).toBe('happy');
  expect(sleep.method).toBe('nursing');
  expect(sleep.woke_by).toBe('woken');
  db.close();
});

test('Dismissing tag sheet auto-saves entered data', async ({ page }) => {
  const babyId = createBaby('Testa');
  setWakeUpTime(babyId);
  await page.goto('/');

  // Start sleep — tag sheet appears
  await page.getByTestId('sleep-button').click();
  await expect(page.getByTestId('sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });
  await expect(page.getByRole('heading', { name: 'Korleis gjekk legginga?' })).toBeVisible({ timeout: 5000 });

  // Enter some data, then dismiss by clicking overlay
  await page.getByRole('button', { name: 'Glad' }).click();
  await page.locator('input[placeholder="Valfritt notat..."]').fill('Viktig notat');
  await page.getByTestId('modal-overlay').click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId('modal-overlay')).not.toBeVisible({ timeout: 5000 });

  // Data should have been saved
  const db = getDb();
  const sleep = db.prepare('SELECT * FROM sleep_log ORDER BY id DESC LIMIT 1').get() as any;
  expect(sleep.mood).toBe('happy');
  expect(sleep.notes).toBe('Viktig notat');
  db.close();
});
