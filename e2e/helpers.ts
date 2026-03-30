import puppeteer, { Browser, Page } from 'puppeteer-core';

const API_KEY = process.env.D24_API_KEY || '';
const BASE_URL = process.env.E2E_BASE_URL || 'https://xaiworkspace.com';

let browser: Browser;
let page: Page;

/**
 * Fetch the real WebSocket URL from done24bot_outputs.json.
 */
async function getWsUrl(): Promise<string> {
  const res = await fetch('https://done24bot.com/done24bot_outputs.json');
  const config: any = await res.json();
  const ws = config.custom.WEBSOCKET_API;
  return `${ws.endpoint}/${ws.stageName}`;
}

const EMAIL = process.env.E2E_EMAIL || process.env.TEST_EMAIL || '';
const PASSWORD = process.env.E2E_PASSWORD || process.env.TEST_PASSWORD || '';

/**
 * Connect to the remote done24bot browser, open the base URL, and login if needed.
 */
export async function setup(): Promise<Page> {
  if (!API_KEY) throw new Error('D24_API_KEY env var is required');
  if (!EMAIL || !PASSWORD) throw new Error('E2E_EMAIL and E2E_PASSWORD env vars are required');

  const wsUrl = await getWsUrl();
  browser = await puppeteer.connect({
    browserWSEndpoint: `${wsUrl}?apiKey=${API_KEY}`,
    protocolTimeout: 120_000,
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 60_000 });

  // Check if logged in — if chat-input exists, we're good
  const loggedIn = await page.$('.chat-input');
  if (!loggedIn) {
    await loginFlow(page);
  }
  return page;
}

/**
 * Login flow — clicks sign in, fills credentials, handles CAPTCHA.
 */
async function loginFlow(p: Page) {
  // Click Sign In button
  await p.evaluate(() => {
    const btns = [...document.querySelectorAll('button, a')];
    const signIn = btns.find(b => /sign.?in/i.test(b.textContent || ''));
    if (signIn) (signIn as HTMLElement).click();
  });

  await p.waitForSelector('.login-modal, .modal, [class*="modal"]', { visible: true, timeout: 15_000 });

  // Fill credentials via evaluate
  await p.evaluate((email: string, password: string) => {
    const emailInput = document.querySelector('input[type="email"]') as HTMLInputElement;
    const passInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    if (emailInput) { emailInput.value = email; emailInput.dispatchEvent(new Event('input', { bubbles: true })); }
    if (passInput) { passInput.value = password; passInput.dispatchEvent(new Event('input', { bubbles: true })); }
  }, EMAIL, PASSWORD);

  await new Promise(r => setTimeout(r, 2_000));

  // Try to click Turnstile CAPTCHA
  const turnstileBox = await p.evaluate(() => {
    const widget = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
    if (widget) {
      const rect = widget.getBoundingClientRect();
      return { x: rect.x + 25, y: rect.y + 25, found: true };
    }
    return { found: false, x: 0, y: 0 };
  });
  if (turnstileBox.found) {
    await p.mouse.click(turnstileBox.x, turnstileBox.y);
    await new Promise(r => setTimeout(r, 5_000));
  }

  // Wait for submit to enable and click
  await p.waitForFunction(
    () => {
      const btn = document.querySelector('.modal-submit, button[type="submit"]') as HTMLButtonElement;
      return btn && !btn.disabled;
    },
    { timeout: 60_000 }
  );
  await p.evaluate(() => {
    const btn = document.querySelector('.modal-submit, button[type="submit"]') as HTMLElement;
    if (btn) btn.click();
  });

  await p.waitForSelector('.chat-input', { visible: true, timeout: 30_000 });
}

/**
 * Disconnect (not close) the browser.
 */
export async function teardown() {
  if (browser) browser.disconnect();
}

export function getPage(): Page {
  return page;
}

/**
 * Wait for the chat to be connected and ready.
 */
export async function waitForChat(p: Page) {
  await p.waitForSelector('.chat-input', { visible: true, timeout: 30_000 });
}

/**
 * Send a message in the chat and wait for bot response.
 * Uses evaluate() for all DOM interaction to avoid slow CDP input events over the relay.
 */
export async function sendMessage(p: Page, text: string): Promise<string> {
  await p.waitForSelector('.chat-input', { visible: true, timeout: 10_000 });

  // Count current bot messages before sending
  const botCountBefore = await p.evaluate(() =>
    document.querySelectorAll('.chat-message--bot').length
  );

  // Set textarea value via Angular's ngModel and trigger send.
  // We access the Angular component instance via __ngContext__ to set messageText directly.
  await p.evaluate((msg: string) => {
    const textarea = document.querySelector('.chat-input') as HTMLTextAreaElement;
    if (!textarea) return;

    // Set .value for the DOM
    textarea.value = msg;

    // Trigger ngModel update: dispatch input event with the actual data
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    // Also try InputEvent which Angular's DefaultValueAccessor listens to
    try {
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: msg, inputType: 'insertText' }));
    } catch (_) {}

    // Force ngModel sync by dispatching compositionend (triggers writeValue)
    textarea.dispatchEvent(new Event('compositionend', { bubbles: true }));
  }, text);

  // Give Angular a tick to process ngModel and enable the button
  await new Promise(r => setTimeout(r, 500));

  // Click send
  await p.evaluate(() => {
    const sendBtn = document.querySelector('.chat-send-btn') as HTMLButtonElement;
    if (sendBtn && !sendBtn.disabled) {
      sendBtn.click();
    }
  });

  // Wait for a new bot message to appear (typing indicator counts)
  await p.waitForFunction(
    (prevCount: number) => {
      const msgs = document.querySelectorAll('.chat-message--bot');
      return msgs.length > prevCount;
    },
    { timeout: 90_000 },
    botCountBefore
  );

  // Poll until typing indicator disappears and content appears (up to 60s)
  let botText = '';
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2_000));
    const result = await p.evaluate(() => {
      const msgs = document.querySelectorAll('.chat-message--bot');
      const last = msgs[msgs.length - 1];
      if (!last) return { done: false, text: '' };
      const typing = last.querySelector('.chat-typing');
      const textEl = last.querySelector('.chat-message-text') || last.querySelector('.chat-message-content');
      const text = textEl ? (textEl as HTMLElement).innerText.trim() : (last as HTMLElement).innerText.trim();
      return { done: !typing && text.length > 0, text };
    });
    if (result.done) {
      botText = result.text;
      break;
    }
  }

  return botText;
}

/**
 * Send a message using @mention syntax.
 */
export async function mentionApp(p: Page, slug: string, message: string): Promise<string> {
  return sendMessage(p, `@${slug} ${message}`);
}

/**
 * Install a mini-app by slug.
 */
export async function installApp(p: Page, slug: string): Promise<string> {
  return sendMessage(p, `/install ${slug}`);
}

/**
 * Uninstall a mini-app by slug.
 */
export async function uninstallApp(p: Page, slug: string): Promise<string> {
  return sendMessage(p, `/uninstall ${slug}`);
}
