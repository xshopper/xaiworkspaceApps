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
    expect(text).not.toMatch(/\b(error|fail|exception|unable|cannot)\b/i);
    expect(text).toMatch(/running|active|provider:|no provider|setup/i);
  }, 90_000);

  test('@cliproxy models lists available models', async () => {
    const text = await mentionApp(page, 'cliproxy', 'models');
    expect(text).not.toMatch(/\b(error|fail|exception|unable|cannot)\b/i);
    expect(text).toMatch(/model[s]?|available|no model/i);
  }, 90_000);

  test('@cliproxy setkey registers an API key provider', async () => {
    const apiKey = process.env.E2E_GROK_API_KEY;
    if (!apiKey) {
      // A placeholder key fails server-side validation and produces an error response
      // that the old broad regex passed. Skip rather than assert on a known-bad credential.
      return;
    }
    const text = await mentionApp(page, 'cliproxy', `setkey grok ${apiKey}`);
    expect(text).not.toMatch(/\b(error|fail|invalid|exception)\b/i);
    expect(text).toMatch(/saved|registered|updated|connected|provider/i);
  }, 90_000);

  test('@cliproxy disconnect removes the provider', async () => {
    const text = await mentionApp(page, 'cliproxy', 'disconnect grok');
    expect(text).not.toMatch(/\b(error|fail|exception|unable|cannot)\b/i);
    expect(text).toMatch(/disconnect(ed)?|remov(ed)?|done|success|not.?found/i);
  }, 90_000);

});
