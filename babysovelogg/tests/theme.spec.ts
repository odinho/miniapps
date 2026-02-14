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

function createBaby() {
  const db = new Database(path.join(process.cwd(), 'napper.db'));
  db.prepare("INSERT INTO baby (name, birthdate) VALUES (?, ?)").run('TestBaby', '2025-06-01');
  db.close();
}

test.beforeEach(() => {
  resetDb();
  createBaby();
});

test('night theme applies correct CSS variables', async ({ page }) => {
  await page.goto('/');
  // Force night mode
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'night');
  });

  const bgColor = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--cream').trim()
  );
  expect(bgColor).toBe('#1a1a2e');

  const textColor = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--text').trim()
  );
  expect(textColor).toBe('#e0d8f0');
});

test('day theme keeps default CSS variables', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'day');
  });

  const bgColor = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--cream').trim()
  );
  expect(bgColor).toBe('#fdf6f0');

  const textColor = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--text').trim()
  );
  expect(textColor).toBe('#4a3f5c');
});

test('data-theme attribute is set on load', async ({ page }) => {
  await page.goto('/');
  const theme = await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme')
  );
  expect(['day', 'night']).toContain(theme);
});

test('night theme has stars pseudo-elements on body', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'night');
  });

  const beforeContent = await page.evaluate(() =>
    getComputedStyle(document.body, '::before').getPropertyValue('content')
  );
  // Stars are rendered via ::before with content: ''
  expect(beforeContent).toBe('""');
});

test('night theme cards have visible contrast', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'night');
  });

  // Check that card background differs from page background
  const whiteVar = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--white').trim()
  );
  const creamVar = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--cream').trim()
  );
  expect(whiteVar).not.toBe(creamVar);
});

test('glow effects apply on interactive elements in night mode', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'night');
  });

  const fab = page.locator('.fab');
  if (await fab.count() > 0) {
    const boxShadow = await fab.evaluate((el) =>
      getComputedStyle(el).boxShadow
    );
    // Should have glow (non-"none" box-shadow)
    expect(boxShadow).not.toBe('none');
  }
});
