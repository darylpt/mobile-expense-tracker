// ============================================================
// Playwright production-export configuration
// Builds the static site, serves `out/`, and runs the filter
// persistence suite in Chromium.
// ============================================================

import { defineConfig } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: './e2e',
  testMatch: /transaction-filter-persistence\.spec\.ts/,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
  },

  webServer: {
    command: 'npm run build && node e2e/serve-static.mjs',
    port: PORT,
    reuseExistingServer: false,
    timeout: 300_000,
  },

  projects: [
    {
      name: 'production-chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 720 },
      },
    },
  ],
});
