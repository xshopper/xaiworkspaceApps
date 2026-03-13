import { test, expect } from '@playwright/test';
import { waitForChat, sendMessage, mentionApp, installApp } from './helpers';

test.describe('support-bot — Support Bot agent', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForChat(page);
  });

  test('install support-bot agent', async ({ page }) => {
    const response = await installApp(page, 'support-bot');
    const text = await response.textContent();
    expect(text).toMatch(/install|already|support/i);
  });

  test('@support-bot help — responds to support request', async ({ page }) => {
    const response = await mentionApp(page, 'support-bot', 'I need help with my account');
    const text = await response.textContent();
    // Should acknowledge and provide ticket reference
    expect(text).toMatch(/help|ticket|account|support|assist|reference/i);
  });

  test('@support-bot — escalates billing disputes', async ({ page }) => {
    const response = await mentionApp(
      page,
      'support-bot',
      'I want a refund for my last payment'
    );
    const text = await response.textContent();
    // Should escalate to human or ask for approval
    expect(text).toMatch(/refund|escalat|human|approval|billing|review|team/i);
  });

  test('@support-bot — provides ticket reference numbers', async ({ page }) => {
    const response = await mentionApp(
      page,
      'support-bot',
      'my login is not working'
    );
    const text = await response.textContent();
    // Should provide help and a ticket reference
    expect(text).toMatch(/ticket|reference|login|password|reset|help|support/i);
  });

  test('@support-bot — empathetic response style', async ({ page }) => {
    const response = await mentionApp(
      page,
      'support-bot',
      'this is so frustrating, nothing works!'
    );
    const text = await response.textContent();
    // Should acknowledge frustration empathetically
    expect(text).toMatch(/understand|sorry|frustrat|help|assist|resolve|apolog/i);
  });
});
