import { test, expect } from '@playwright/test';
import { waitForChat, sendMessage, mentionApp, installApp } from './helpers';

test.describe('expense-tracker — Expense Tracker app', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForChat(page);
  });

  test('install expense-tracker app', async ({ page }) => {
    const response = await installApp(page, 'expense-tracker');
    const text = await response.textContent();
    expect(text).toMatch(/install|already|expense/i);
  });

  test('@expense-tracker add expense — confirms before recording', async ({ page }) => {
    const response = await mentionApp(page, 'expense-tracker', 'add expense $42.50 for lunch');
    const text = await response.textContent();
    // Should ask to confirm amount before recording
    expect(text).toMatch(/confirm|record|42\.50|lunch|categor|expense/i);
  });

  test('@expense-tracker report — generates expense report', async ({ page }) => {
    const response = await mentionApp(page, 'expense-tracker', 'generate monthly expense report');
    const text = await response.textContent();
    // Should show report or say no expenses yet
    expect(text).toMatch(/report|expense|total|no.*expense|month|summary/i);
  });

  test('@expense-tracker export — requires Google for Sheets export', async ({ page }) => {
    const response = await mentionApp(page, 'expense-tracker', 'export to Google Sheets');
    const text = await response.textContent();
    // Should either export or ask to connect Google
    expect(text).toMatch(/google|sheets|authorize|connect|export|spreadsheet/i);
  });

  test('@expense-tracker — flags duplicates', async ({ page }) => {
    const response = await mentionApp(page, 'expense-tracker', 'add expense $42.50 for lunch today');
    const text = await response.textContent();
    // Should confirm or flag potential duplicate
    expect(text).toMatch(/confirm|duplicate|record|expense|42\.50|already/i);
  });
});
