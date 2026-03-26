import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.(test|e2e)\.ts/,
  testIgnore: ['**/unit/**', '**/integration/**'],
  timeout: 30_000,
  use: {
    headless: true,
  },
});
