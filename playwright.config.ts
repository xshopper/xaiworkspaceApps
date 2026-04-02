import { defineConfig, devices } from '@playwright/test';
import path from 'path';

/**
 * Playwright config for xaiworkspaceApps mini-app panel tests.
 *
 * A lightweight Express server serves the test harness HTML and the panel.js
 * file under test. No live backend needed — the xai SDK is fully mocked.
 */
export default defineConfig({
  testDir: 'e2e/tests',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',

  use: {
    baseURL: 'http://localhost:9457',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 7'], viewport: { width: 412, height: 915 } },
    },
  ],

  webServer: {
    command: `node ${path.resolve(__dirname, 'e2e/harness/serve.js')}`,
    port: 9457,
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
});
