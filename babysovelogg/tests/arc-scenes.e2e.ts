// Per-scene visual snapshot tests for /dev/arc-scenes.
//
// Each scene gets its own `toHaveScreenshot()` assertion so a regression in
// one corner case fails one assertion with a tight visual diff — not a single
// page-wide snapshot that turns red whenever any pixel moves.
//
// To regenerate baselines after an intentional visual change:
//   bunx playwright test arc-scenes --update-snapshots
// Inspect the diff in tests/arc-scenes.e2e.ts-snapshots/ before committing.

import { test as baseTest, expect } from "./fixtures.js";

// Opt out of the autoMorning fixture (which monkey-patches Date.getHours to
// always return 8). The arc-scenes page deliberately exercises specific
// hours-of-day, and forcing every Date to read as hour=8 collapses the
// scenes to a useless single point on the arc.
const test = baseTest.extend({
  autoMorning: async ({}, use) => {
    await use();
  },
});

// Scene IDs mirror the testids in src/routes/dev/arc-scenes/+page.svelte.
const SCENE_IDS = [
  "active-night-13min",
  "active-nap-mid",
  "overrun-past-wake",
  "skipped-with-rescue",
  "two-naps-with-bands",
  "morning-empty",
  "after-bedtime",
  "active-nap-paused",
] as const;

for (const id of SCENE_IDS) {
  test(`arc scene: ${id}`, async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/dev/arc-scenes`);

    const card = page.getByTestId(`arc-scene-${id}`);
    await expect(card).toBeVisible();
    // Wait until the arc SVG inside the card has rendered.
    await expect(card.locator(".sleep-arc")).toBeVisible();

    await expect(card).toHaveScreenshot(`${id}.png`, {
      // Allow tiny anti-alias drift between runs without masking real change.
      maxDiffPixelRatio: 0.005,
    });
  });
}

// DOM-level assertions complementing the pixel snapshots. These pin which
// active-sleep code path each scene exercises — the halo path versus the
// bubble path. A regression that swaps them (or drops one) wouldn't be
// obvious from a pixel-diff alone, but trips the asserts here.
test("arc scenes: active-nap-mid renders an active-bubble (mid-arc path)", async ({ page, baseURL }) => {
  await page.goto(`${baseURL}/dev/arc-scenes`);
  const card = page.getByTestId("arc-scene-active-nap-mid");
  await expect(card.locator(".arc-bubble-active")).toHaveCount(1);
  await expect(card.locator(".arc-endpoint-halo")).toHaveCount(0);
});

test("arc scenes: active-night-13min renders an endpoint halo (near-endpoint path)", async ({ page, baseURL }) => {
  await page.goto(`${baseURL}/dev/arc-scenes`);
  const card = page.getByTestId("arc-scene-active-night-13min");
  await expect(card.locator(".arc-bubble-active")).toHaveCount(0);
  await expect(card.locator(".arc-endpoint-halo")).toHaveCount(1);
});
