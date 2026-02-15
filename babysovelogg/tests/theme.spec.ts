import { test, expect, createBaby, setWakeUpTime } from './fixtures';

test.beforeEach(async () => {
  const babyId = createBaby();
  setWakeUpTime(babyId);
});

test('night theme applies correct CSS variables', async ({ page }) => {
  await page.goto('/');
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
  expect(beforeContent).toBe('""');
});

test('night theme cards have visible contrast', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'night');
  });

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

  const fab = page.getByTestId('fab');
  if (await fab.count() > 0) {
    const boxShadow = await fab.evaluate((el) =>
      getComputedStyle(el).boxShadow
    );
    expect(boxShadow).not.toBe('none');
  }
});
