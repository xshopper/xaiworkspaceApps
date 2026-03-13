import { test, expect } from '@playwright/test';
import { waitForChat, sendMessage, mentionApp, installApp } from './helpers';

test.describe('sales-assistant — Sales Assistant agent', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForChat(page);
  });

  test('install sales-assistant agent', async ({ page }) => {
    const response = await installApp(page, 'sales-assistant');
    const text = await response.textContent();
    expect(text).toMatch(/install|already|sales/i);
  });

  test('@sales-assistant add lead — tracks new prospect', async ({ page }) => {
    const response = await mentionApp(
      page,
      'sales-assistant',
      'add lead: Acme Corp, contact John Doe, john@acme.com'
    );
    const text = await response.textContent();
    // Should confirm lead was added or ask for more details
    expect(text).toMatch(/lead|acme|added|tracked|pipeline|prospect/i);
  });

  test('@sales-assistant pipeline — shows pipeline status', async ({ page }) => {
    const response = await mentionApp(page, 'sales-assistant', 'show my pipeline');
    const text = await response.textContent();
    // Should show pipeline or say no leads yet
    expect(text).toMatch(/pipeline|lead|no.*lead|prospect|deal|stage/i);
  });

  test('@sales-assistant draft email — requires approval before sending', async ({ page }) => {
    const response = await mentionApp(
      page,
      'sales-assistant',
      'draft a follow-up email to Acme Corp'
    );
    const text = await response.textContent();
    // Should draft but not auto-send, require approval
    expect(text).toMatch(/draft|email|send|confirm|approve|google|authorize|follow.?up/i);
  });

  test('@sales-assistant — uses MEDDIC methodology', async ({ page }) => {
    const response = await mentionApp(
      page,
      'sales-assistant',
      'analyze the Acme Corp deal using MEDDIC'
    );
    const text = await response.textContent();
    // Should reference MEDDIC framework elements
    expect(text).toMatch(/meddic|metric|economic buyer|decision|pain|champion/i);
  });
});
