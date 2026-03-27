/**
 * OpenClaw mini app E2E tests — verifies @openclaw commands from the web UI.
 *
 * Tests the full path: browser → WebSocket → router → bridge → pm2/gateway.
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

  test('@openclaw status returns process info', async () => {
    const text = await mentionApp(page, 'openclaw', 'status');

    // Should contain pm2 process listing or status output
    expect(text).toMatch(/openclaw|bridge|online|running|process|pm2|gateway/i);
  }, 90_000);

  test('@openclaw status shows bridge health', async () => {
    const text = await mentionApp(page, 'openclaw', 'status');

    // Bridge health section should be present
    expect(text).toMatch(/bridge|health|connected|router|uptime/i);
  }, 90_000);

  test('@openclaw status shows gateway port', async () => {
    const text = await mentionApp(page, 'openclaw', 'status');

    // Gateway port check should be present
    expect(text).toMatch(/gateway|port|19001|listening/i);
  }, 90_000);

  test('@openclaw logs returns gateway output', async () => {
    const text = await mentionApp(page, 'openclaw', 'logs');

    // Should contain log output (or a pm2 logs message)
    expect(text).toMatch(/openclaw|gateway|bridge|log|pm2|started|listening/i);
  }, 90_000);

  test('/status_x returns platform infrastructure status', async () => {
    const text = await sendMessage(page, '/status_x');

    // status_x returns structured platform info
    expect(text).toMatch(/plan|model|status|instance|tier|active|trial/i);
  }, 90_000);
});
