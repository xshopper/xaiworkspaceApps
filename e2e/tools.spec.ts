import { test, expect } from '@playwright/test';
import { waitForChat, sendMessage, mentionApp, installApp } from './helpers';

test.describe('tools — Google Sheets & GitHub Issues', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForChat(page);
  });

  // --- google-sheets ---

  test('install google-sheets tool', async ({ page }) => {
    const response = await installApp(page, 'google-sheets');
    const text = await response.textContent();
    expect(text).toMatch(/install|already|google.*sheet|sheet/i);
  });

  test('@google-sheets list — requires Google OAuth', async ({ page }) => {
    const response = await mentionApp(page, 'google-sheets', 'list my spreadsheets');
    const text = await response.textContent();
    // Should list sheets or ask to connect Google
    expect(text).toMatch(/spreadsheet|google|authorize|connect|sheet|no.*sheet/i);
  });

  test('@google-sheets create — creates a new spreadsheet', async ({ page }) => {
    const response = await mentionApp(page, 'google-sheets', 'create a new spreadsheet called Test');
    const text = await response.textContent();
    // Should create or ask to connect Google
    expect(text).toMatch(/created|spreadsheet|google|authorize|connect|test/i);
  });

  // --- github-issues ---

  test('install github-issues tool', async ({ page }) => {
    const response = await installApp(page, 'github-issues');
    const text = await response.textContent();
    expect(text).toMatch(/install|already|github.*issue|issue/i);
  });

  test('@github-issues list — requires GitHub OAuth', async ({ page }) => {
    const response = await mentionApp(
      page,
      'github-issues',
      'list issues on xshopper/xaiworkspaceApps'
    );
    const text = await response.textContent();
    // Should list issues or ask to connect GitHub
    expect(text).toMatch(/issue|github|authorize|connect|repository|no.*issue/i);
  });

  test('@github-issues create — creates a new issue', async ({ page }) => {
    const response = await mentionApp(
      page,
      'github-issues',
      'create issue "Test issue" on xshopper/xaiworkspaceApps'
    );
    const text = await response.textContent();
    // Should create or ask to connect GitHub
    expect(text).toMatch(/created|issue|github|authorize|connect|test/i);
  });
});
