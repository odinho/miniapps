import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'path';

function resetDb() {
  const db = new Database(path.join(process.cwd(), 'napper.db'));
  try { db.prepare('DELETE FROM sleep_pauses').run(); } catch {}
  try { db.prepare('DELETE FROM diaper_log').run(); } catch {}
  try { db.prepare('DELETE FROM sleep_log').run(); } catch {}
  try { db.prepare('DELETE FROM day_start').run(); } catch {}
  try { db.prepare('DELETE FROM baby').run(); } catch {}
  try { db.prepare('DELETE FROM events').run(); } catch {}
  db.close();
}

async function dismissMorningPrompt(page: any) {
  await page.locator('.morning-prompt').waitFor({ state: 'visible', timeout: 5000 });
  await page.click('.morning-prompt .btn-primary');
  await page.locator('.morning-prompt').waitFor({ state: 'hidden', timeout: 5000 });
}

test.beforeEach(() => {
  resetDb();
});

test('SSE: Context B sees sleep started in Context A without refresh', async ({ page, browser }) => {
  // Context A: create baby
  await page.goto('/');
  await page.fill('input[type="text"]', 'SSE-Baby');
  await page.fill('input[type="date"]', '2025-06-12');
  await page.click('button.btn-primary');
  await dismissMorningPrompt(page);
  await expect(page.locator('.baby-name')).toHaveText('SSE-Baby', { timeout: 5000 });

  // Context B: open second browser (wake-up already set by A)
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.goto('/');
  await expect(page2.locator('.baby-name')).toHaveText('SSE-Baby', { timeout: 5000 });

  // Wait for SSE to connect in both contexts
  await page.waitForTimeout(500);
  await page2.waitForTimeout(500);

  // Context A: start sleep
  await page.click('.sleep-button');
  await expect(page.locator('.sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });

  // Context B: should see sleeping state via SSE (no manual refresh)
  await expect(page2.locator('.sleep-button')).toHaveClass(/sleeping/, { timeout: 10000 });

  await ctx2.close();
});

test('SSE: Both contexts work independently', async ({ page, browser }) => {
  // Setup baby in Context A
  await page.goto('/');
  await page.fill('input[type="text"]', 'SSE-Baby2');
  await page.fill('input[type="date"]', '2025-06-12');
  await page.click('button.btn-primary');
  await dismissMorningPrompt(page);
  await expect(page.locator('.baby-name')).toHaveText('SSE-Baby2', { timeout: 5000 });

  // Context B (wake-up already set)
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.goto('/');
  await expect(page2.locator('.baby-name')).toHaveText('SSE-Baby2', { timeout: 5000 });

  // Both should have sync dot
  await expect(page.locator('#sync-dot')).toBeVisible();
  await expect(page2.locator('#sync-dot')).toBeVisible();

  await ctx2.close();
});
