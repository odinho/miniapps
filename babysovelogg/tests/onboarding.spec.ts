import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'path';

function resetDb() {
  const db = new Database(path.join(process.cwd(), 'napper.db'));
  try { db.prepare('DELETE FROM sleep_pauses').run(); } catch {}
  try { db.prepare('DELETE FROM diaper_log').run(); } catch {}
  try { db.prepare('DELETE FROM sleep_log').run(); } catch {}
  try { db.prepare('DELETE FROM baby').run(); } catch {}
  try { db.prepare('DELETE FROM events').run(); } catch {}
  db.close();
}

test.beforeEach(() => {
  resetDb();
});

test('Get Started button creates baby and navigates to dashboard', async ({ page }) => {
  await page.goto('/');

  // Should redirect to onboarding since no baby exists
  await expect(page.locator('h1')).toHaveText('Welcome to Napper');
  await expect(page.locator('button.btn-primary')).toHaveText('Get Started ✨');

  // Fill in baby details
  await page.fill('input[type="text"]', 'Halldis');
  await page.fill('input[type="date"]', '2025-06-12');

  // Click Get Started
  await page.click('button.btn-primary');

  // Should navigate to dashboard and show baby name
  await expect(page.locator('.baby-name')).toHaveText('Halldis', { timeout: 5000 });
  await expect(page.locator('.baby-age')).toContainText('months old');

  // Should show the sleep button
  await expect(page.locator('.sleep-button')).toBeVisible();
});

test('Get Started validates required fields', async ({ page }) => {
  await page.goto('/');

  // Click without filling anything
  await page.click('button.btn-primary');

  // Should still be on onboarding
  await expect(page.locator('h1')).toHaveText('Welcome to Napper');

  // Fill only name
  await page.fill('input[type="text"]', 'Halldis');
  await page.click('button.btn-primary');
  await expect(page.locator('h1')).toHaveText('Welcome to Napper');

  // Fill date too
  await page.fill('input[type="date"]', '2025-06-12');
  await page.click('button.btn-primary');
  await expect(page.locator('.baby-name')).toHaveText('Halldis', { timeout: 5000 });
});

test('Sleep tracking flow after onboarding', async ({ page }) => {
  // Create baby via API
  await page.goto('/');
  await page.evaluate(async () => {
    await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{ type: 'baby.created', payload: { name: 'Halldis', birthdate: '2025-06-12' } }] }),
    });
  });

  // Reload to dashboard
  await page.goto('/');
  await expect(page.locator('.baby-name')).toHaveText('Halldis', { timeout: 5000 });

  // Click sleep button to start nap
  await page.click('.sleep-button');
  await expect(page.locator('.sleep-button')).toHaveClass(/sleeping/, { timeout: 3000 });
});
