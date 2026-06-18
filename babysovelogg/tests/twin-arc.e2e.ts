// Visual + DOM snapshot tests for the concentric twin arc (/dev/twin-arc).
//
// To regenerate baselines after an intentional visual change:
//   bunx playwright test twin-arc --update-snapshots

import { test as baseTest, expect } from "./fixtures.js";

// Opt out of autoMorning (it pins Date.getHours to 8, collapsing the scenes).
const test = baseTest.extend({
  autoMorning: async ({}, use) => {
    await use();
  },
});

const SCENE_IDS = ["twin-scene-day", "twin-scene-night", "twin-scene-fresh"] as const;

for (const id of SCENE_IDS) {
  test(`twin arc: ${id}`, async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/dev/twin-arc`);
    const card = page.getByTestId(id);
    await expect(card).toBeVisible();
    await expect(card.locator(".sleep-arc")).toBeVisible();
    // Looser than arc-scenes (0.005): the sun/moon emoji endpoints render
    // 1–2% differently across font environments (see the known arc-scenes
    // baseline drift in followups). This still catches gross "two lanes
    // became mud" regressions; structural guards live in the DOM test below.
    await expect(card).toHaveScreenshot(`${id}.png`, { maxDiffPixelRatio: 0.04 });
  });
}

test("twin arc: both lanes + a single shared now-line + legend render", async ({ page, baseURL }) => {
  await page.goto(`${baseURL}/dev/twin-arc`);
  const day = page.getByTestId("twin-scene-day").locator(".twin-arc");
  // Two distinct background tracks must exist — the inner lane carries its own
  // distinctive stroke. A regression collapsing to one lane drops this to 0.
  await expect(day.locator('.sleep-arc > path[stroke="var(--cream-dark)"]')).toHaveCount(1);
  await expect(day.locator(".sleep-arc > path").first()).toBeVisible();
  // Exactly one shared now-line crosses both rings (not one per baby).
  await expect(day.locator(".sleep-arc > line")).toHaveCount(1);
  // Legend names both twins.
  await expect(page.getByTestId("twin-legend").first()).toContainText("Aud");
  await expect(page.getByTestId("twin-legend").first()).toContainText("Bjørn");

  // Night scene: the inner lane (baby B) carries its own night-waking band —
  // it must not be dropped or hoisted onto the outer lane.
  const night = page.getByTestId("twin-scene-night").locator(".twin-arc");
  await expect(night.locator('.sleep-arc path[stroke="rgba(192, 57, 43, 0.95)"]')).toHaveCount(1);
  await expect(night.locator(".sleep-arc > line")).toHaveCount(1);
});

test("twin arc: a just-started active sleep renders an endpoint halo (not dropped)", async ({ page, baseURL }) => {
  // composeArc suppresses a very-short active bubble that hugs an endpoint into
  // an endpoint halo. TwinArc must render that halo on BOTH lanes, else the
  // active-sleep state silently vanishes in twin mode (Codex review).
  await page.goto(`${baseURL}/dev/twin-arc`);
  const fresh = page.getByTestId("twin-scene-fresh").locator(".twin-arc");
  await expect(fresh.locator(".arc-endpoint-halo")).not.toHaveCount(0);
});
