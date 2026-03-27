/**
 * OpenClaw mini app E2E tests — verifies @openclaw commands from the web UI.
 *
 * Tests the full path: browser → WebSocket → router → bridge → pm2/gateway.
 *
 * NOTE: For local dev testing, use the backend integration test instead:
 *   cd ../xaiworkspace-backend
 *   ROUTER_URL=http://localhost:8080 ADMIN_KEY=key JWT_SIGNING_SECRET=secret pnpm test:provisioning
 *
 * This spec runs against the live production/staging environment via done24bot.
 *
 * Run:
 *   D24_API_KEY=your_key npm run test:openclaw
 */
import { Page } from 'puppeteer-core';
import { setup, teardown, waitForChat, sendMessage, mentionApp } from './helpers';

let page: Page;

beforeAll(async () => {
  page = await setup();
  await waitForChat(page);
}, 120_000);

afterAll(async () => {
  await teardown();
});

describe('OpenClaw mini app — @openclaw commands', () => {

  test('@openclaw status returns process and health info', async () => {
    const text = await mentionApp(page, 'openclaw', 'status');
    expect(text).toMatch(/openclaw|bridge|online|running|process|pm2|gateway|health|connected/i);
  }, 90_000);

  test('@openclaw logs returns gateway output', async () => {
    const text = await mentionApp(page, 'openclaw', 'logs');
    expect(text).toMatch(/openclaw|gateway|bridge|log|pm2|started|listening/i);
  }, 90_000);

  test('/status_x returns platform infrastructure status', async () => {
    const text = await sendMessage(page, '/status_x');
    expect(text).toMatch(/plan|model|status|instance|tier|active|trial/i);
  }, 90_000);
});
