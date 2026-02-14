import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'path';

function resetDb() {
  const db = new Database(path.join(process.cwd(), 'napper.db'));
  try { db.prepare('DELETE FROM diaper_log').run(); } catch {}
  try { db.prepare('DELETE FROM sleep_log').run(); } catch {}
  try { db.prepare('DELETE FROM baby').run(); } catch {}
  try { db.prepare('DELETE FROM events').run(); } catch {}
  db.close();
}

test.beforeEach(() => {
  resetDb();
});

test('Second browser context sees baby created in first', async ({ page, browser }) => {
  // First client: create baby via onboarding
  await page.goto('/');
  await page.fill('input[type="text"]', 'Testa');
  await page.fill('input[type="date"]', '2025-06-12');
  await page.click('button.btn-primary');
  await expect(page.locator('.baby-name')).toHaveText('Testa', { timeout: 5000 });

  // Second client: new context, same server
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.goto('/');
  await expect(page2.locator('.baby-name')).toHaveText('Testa', { timeout: 5000 });
  await expect(page2.locator('.sleep-button')).toBeVisible();

  await ctx2.close();
});

test('Sleep started in one client is visible in another after reload', async ({ page, browser }) => {
  // Setup baby
  await page.goto('/');
  await page.fill('input[type="text"]', 'Testa');
  await page.fill('input[type="date"]', '2025-06-12');
  await page.click('button.btn-primary');
  await expect(page.locator('.baby-name')).toHaveText('Testa', { timeout: 5000 });

  // Start sleep in first client
  await page.click('.sleep-button');
  await expect(page.locator('.sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });

  // Second client should see sleeping state
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.goto('/');
  await expect(page2.locator('.baby-name')).toHaveText('Testa', { timeout: 5000 });
  await expect(page2.locator('.sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });

  await ctx2.close();
});
