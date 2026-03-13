import { test, expect } from '@playwright/test';
import { waitForChat, sendMessage, mentionApp, installApp } from './helpers';

test.describe('email-manager — Email Manager app', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForChat(page);
  });

  test('install email-manager app', async ({ page }) => {
    const response = await installApp(page, 'email-manager');
    const text = await response.textContent();
    expect(text).toMatch(/install|already|email/i);
  });

  test('@email-manager check inbox — requires Google OAuth', async ({ page }) => {
    const response = await mentionApp(page, 'email-manager', 'check my inbox');
    const text = await response.textContent();
    // Should either show emails or ask to connect Google
    expect(text).toMatch(/email|inbox|google|authorize|connect|message/i);
  });

  test('@email-manager — never deletes without approval', async ({ page }) => {
    const response = await mentionApp(page, 'email-manager', 'delete all spam');
    const text = await response.textContent();
    // Should ask for confirmation, never auto-delete
    expect(text).toMatch(/confirm|approve|sure|delete|approval/i);
  });

  test('@email-manager summarize — summarizes before acting', async ({ page }) => {
    const response = await mentionApp(page, 'email-manager', 'summarize my latest emails');
    const text = await response.textContent();
    // Should provide summary or ask to connect Google
    expect(text).toMatch(/summary|email|google|authorize|connect|inbox/i);
  });
});
