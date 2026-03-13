import { test as setup, expect } from '@playwright/test';
import path from 'path';

const AUTH_FILE = path.join(__dirname, '..', '.auth', 'user.json');

setup('authenticate', async ({ page }) => {
  const email = process.env.TEST_EMAIL;
  const password = process.env.TEST_PASSWORD;

  if (!email || !password) {
    throw new Error('Set TEST_EMAIL and TEST_PASSWORD env vars');
  }

  await page.goto('/');

  // Click sign in
  await page.locator('.nav-btn--outlined').click();
  await expect(page.locator('.login-modal')).toBeVisible({ timeout: 5_000 });

  // Fill credentials
  await page.locator('.login-modal input[type="email"]').fill(email);
  await page.locator('.login-modal input[type="password"]').fill(password);

  // Handle Turnstile CAPTCHA — in test env it may auto-solve
  await page.waitForTimeout(2_000);

  await page.locator('.modal-submit').click();

  // Wait for login to complete — chat panel should appear
  await expect(page.locator('.chat-input')).toBeVisible({ timeout: 30_000 });

  // Save auth state
  await page.context().storageState({ path: AUTH_FILE });
});
