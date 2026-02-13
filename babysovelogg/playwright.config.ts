import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: 'http://localhost:3200',
    headless: true,
  },
  webServer: {
    command: 'PORT=3200 node dist/server.js',
    port: 3200,
    reuseExistingServer: false,
  },
});
