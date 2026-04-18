/**
 * Cliproxy E2E tests — verifies @cliproxy provider management commands from the web UI.
 *
 * Tests the full path: browser → WebSocket → router → bridge → cliproxy app.
 *
 * NOTE: For local dev testing, use the unit tests instead:
 *   cd ../xaiworkspace-apps/cliproxy
 *   pnpm test
 *
 * This spec runs against the live production/staging environment via done24bot.
 *
 * Run:
 *   D24_API_KEY=your_key npm run test:cliproxy
 */
import { Page } from 'puppeteer-core';
import { setup, teardown, waitForChat, mentionApp } from './helpers';

let page: Page;

beforeAll(async () => {
  page = await setup();
  await waitForChat(page);
}, 120_000);

afterAll(async () => {
  await teardown();
});

describe('Cliproxy mini app — @cliproxy commands', () => {

  test('@cliproxy status returns provider and service info', async () => {
    const text = await mentionApp(page, 'cliproxy', 'status');
    expect(text).toMatch(/running|setup/i);
  }, 90_000);

  test('@cliproxy models lists available models', async () => {
    const text = await mentionApp(page, 'cliproxy', 'models');
    expect(text).toMatch(/model/i);
    expect(text).toMatch(/available|list/i);
  }, 90_000);

  test('@cliproxy setkey registers an API key provider', async () => {
    // Use a syntactically valid but non-functional placeholder key to verify
    // the command is accepted and returns a confirmation or validation response.
    const text = await mentionApp(page, 'cliproxy', 'setkey grok e2e-test-placeholder-key');
    expect(text).toMatch(/saved|ok/i);
    expect(text).toMatch(/grok/i);
  }, 90_000);

  test('@cliproxy disconnect removes the provider', async () => {
    const text = await mentionApp(page, 'cliproxy', 'disconnect grok');
    expect(text).toMatch(/done|success/i);
    expect(text).toMatch(/grok/i);
  }, 90_000);

});
