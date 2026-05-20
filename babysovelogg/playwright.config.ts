import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.(test|e2e)\.ts/,
  testIgnore: ['**/unit/**', '**/integration/**'],
  timeout: 30_000,
  use: {
    headless: true,
    serviceWorkers: 'block',
    // Pin browser TZ to Europe/Oslo so e2e fixtures that create timestamps
    // in local time match the server's TZ. Without this, the snapshot tests
    // are non-deterministic across machines.
    timezoneId: 'Europe/Oslo',
  },
  projects: [
    {
      // Use the full Chromium binary (not the headless-shell variant) because
      // the headless-shell has a TZ bug where Date.getHours() returns the
      // UTC hour even though Intl/toLocaleString correctly use the configured
      // timezone. The Arc relies on getHours() for fraction math, so on
      // headless-shell the bubbles paint at the wrong fraction while their
      // labels show the right time.
      //
      // `channel: 'chromium'` is what actually pins the full binary —
      // without it Playwright resolves `headless: true` to the
      // chromium-headless-shell build even though we requested
      // `devices['Desktop Chrome']`. Verified by Codex review 2026-05-17.
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
  ],
});
