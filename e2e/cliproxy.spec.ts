import { test, expect } from '@playwright/test';
import { waitForChat, sendMessage, mentionApp, installApp } from './helpers';

test.describe('cliproxy — CLI Proxy app', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForChat(page);
  });

  test('install cliproxy app', async ({ page }) => {
    const response = await installApp(page, 'cliproxy');
    const text = await response.textContent();
    // Should confirm install or say already installed
    expect(text).toMatch(/install|already|cliproxy/i);
  });

  test('@cliproxy status — shows proxy status', async ({ page }) => {
    const response = await mentionApp(page, 'cliproxy', 'status');
    const text = await response.textContent();
    // Should report whether CLIProxyAPI is installed/running
    expect(text).toMatch(/install|running|not found|status|proxy|model/i);
  });

  test('@cliproxy models — lists available models', async ({ page }) => {
    const response = await mentionApp(page, 'cliproxy', 'models');
    const text = await response.textContent();
    // Should list models or say none connected
    expect(text).toMatch(/model|none|connect|available|no provider/i);
  });

  test('@cliproxy connect grok — prompts for API key', async ({ page }) => {
    const response = await mentionApp(page, 'cliproxy', 'connect grok');
    const text = await response.textContent();
    // Should ask for xAI API key
    expect(text).toMatch(/api key|xai|paste|grok|console\.x\.ai/i);
  });

  test('@cliproxy connect claude-api — prompts for Anthropic key', async ({ page }) => {
    const response = await mentionApp(page, 'cliproxy', 'connect claude-api');
    const text = await response.textContent();
    // Should ask for Anthropic API key
    expect(text).toMatch(/api key|anthropic|paste|claude|console\.anthropic/i);
  });

  test('@cliproxy connect claude — starts CLI auth flow', async ({ page }) => {
    const response = await mentionApp(page, 'cliproxy', 'connect claude');
    const text = await response.textContent();
    // Should either start auth flow or show URL
    expect(text).toMatch(/auth|url|browser|login|subscription|cli-proxy-api/i);
  });
});
