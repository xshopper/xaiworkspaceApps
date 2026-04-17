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
  // Flaky-test budget: 1 retry locally, 2 on CI (where network jitter is
  // more common). Prior value was 0 which surfaced every transient as a
  // hard failure.
  retries: process.env.CI ? 2 : 1,
  // Abort the run after 5 failures to save CI minutes when something is
  // structurally broken.
  maxFailures: 5,
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
      // Runs everything in e2e/tests/ — the claude-code-panel spec is
      // desktop-only (no mobile layout yet).
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 7'], viewport: { width: 412, height: 915 } },
      // Mobile layout hasn't been implemented for the panels yet. Explicit
      // testMatch keeps this project opted-in per spec; today no spec is
      // mobile-ready, so running this project is a no-op.
      // When a mobile-specific spec lands it should opt in via filename
      // suffix `.mobile.spec.ts`.
      testMatch: /\.mobile\.spec\.ts$/,
    },
  ],

  webServer: {
    command: `node ${path.resolve(__dirname, 'e2e/harness/serve.js')}`,
    port: 9457,
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
});
