import { test, expect } from './fixtures.js';

test('dev playground: all scenario groups visible and visual snapshot', async ({ page, baseURL }) => {
	await page.goto(`${baseURL}/dev`);

	// Set fixed time so arc labels are deterministic across runs
	const timeInput = page.locator('input[placeholder="HH:MM"]');
	await timeInput.fill('10:00');
	await timeInput.press('Tab');

	// All 5 groups must render
	await Promise.all(
		['Søver', 'Vaken', 'Leggetid', 'Nyfødde', 'Spesialtilfelle'].map((group) =>
			expect(page.getByRole('heading', { name: group, level: 2 })).toBeVisible(),
		),
	);

	// At least one arc SVG and one Timer must be rendered
	await expect(page.locator('.sleep-arc').first()).toBeVisible();
	await expect(page.locator('.countdown-value').first()).toBeVisible();

	// Visual regression snapshot — update with: bunx playwright test --update-snapshots
	await expect(page).toHaveScreenshot('dev-playground.png', { fullPage: true });
});
