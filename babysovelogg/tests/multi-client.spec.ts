import { test, expect } from './fixtures';

async function dismissMorningPrompt(page: any) {
  await page.locator('.morning-prompt').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('.morning-prompt .btn-primary').click();
  await page.locator('.morning-prompt').waitFor({ state: 'hidden', timeout: 5000 });
}

test('Second browser context sees baby created in first', async ({ page, browser }) => {
  await page.goto('/');
  await page.locator('input[type="text"]').fill('Testa');
  await page.locator('input[type="date"]').fill('2025-06-12');
  await page.locator('button.btn-primary').click();
  await dismissMorningPrompt(page);
  await expect(page.locator('.baby-name')).toHaveText('Testa', { timeout: 5000 });

  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.goto('/');
  await expect(page2.locator('.baby-name')).toHaveText('Testa', { timeout: 5000 });
  await expect(page2.locator('.sleep-button')).toBeVisible();

  await ctx2.close();
});

test('Sleep started in one client is visible in another after reload', async ({ page, browser }) => {
  await page.goto('/');
  await page.locator('input[type="text"]').fill('Testa');
  await page.locator('input[type="date"]').fill('2025-06-12');
  await page.locator('button.btn-primary').click();
  await dismissMorningPrompt(page);
  await expect(page.locator('.baby-name')).toHaveText('Testa', { timeout: 5000 });

  await page.locator('.sleep-button').click();
  await expect(page.locator('.sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });

  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await page2.goto('/');
  await expect(page2.locator('.baby-name')).toHaveText('Testa', { timeout: 5000 });
  await expect(page2.locator('.sleep-button')).toHaveClass(/sleeping/, { timeout: 5000 });

  await ctx2.close();
});
