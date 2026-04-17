import puppeteer, { Browser, Page } from 'puppeteer-core';

const API_KEY = process.env.D24_API_KEY || '';
const BASE_URL = process.env.E2E_BASE_URL || 'https://xaiworkspace.com';

let browser: Browser;
let page: Page;

// Only endpoints under this host are considered valid WS targets. We pin
// the expected domain to reject a compromised/typosquatted outputs file
// that returns e.g. `wss://evil.example.com/foo` from the build.
const EXPECTED_WS_HOST_SUFFIX = '.done24bot.com';
const EXPECTED_WS_HOST_EXACT = 'done24bot.com';

function assertTrustedWsUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
    throw new Error(`Untrusted WS URL protocol: ${parsed.protocol}`);
  }
  if (parsed.hostname !== EXPECTED_WS_HOST_EXACT && !parsed.hostname.endsWith(EXPECTED_WS_HOST_SUFFIX)) {
    throw new Error(`Untrusted WS URL host: ${parsed.hostname} (expected done24bot.com or *.done24bot.com)`);
  }
  return url;
}

/**
 * Resolve the WebSocket URL used by the E2E harness.
 *
 * Precedence:
 *   1. `E2E_WS_URL` env var — lets CI/developers pin a specific endpoint
 *      (e.g. a staging env, a local tunnel). Validated against the expected
 *      host pattern so a typo can't silently redirect traffic.
 *   2. Fetch done24bot's public outputs file as a last resort. The returned
 *      URL is also pattern-validated before we hand it to puppeteer.
 */
async function getWsUrl(): Promise<string> {
  const override = process.env.E2E_WS_URL;
  if (override) return assertTrustedWsUrl(override);

  const res = await fetch('https://done24bot.com/done24bot_outputs.json');
  const config: any = await res.json();
  const ws = config.custom.WEBSOCKET_API;
  return assertTrustedWsUrl(`${ws.endpoint}/${ws.stageName}`);
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

  // Wait for the inputs to have been accepted by Angular (password field
  // value reflected through ngModel) rather than guessing with setTimeout.
  await p.waitForFunction(
    () => {
      const email = document.querySelector('input[type="email"]') as HTMLInputElement | null;
      const pass = document.querySelector('input[type="password"]') as HTMLInputElement | null;
      return !!email?.value && !!pass?.value;
    },
    { timeout: 5_000 }
  );

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
    // Wait for the Turnstile iframe to signal challenge-passed rather than
    // hard-sleeping for 5s. Cloudflare's widget adds the hidden
    // `cf-turnstile-response` input to the form once solved.
    await p.waitForFunction(
      () => {
        const tok = document.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement | null;
        return !!tok && tok.value.length > 0;
      },
      { timeout: 15_000 }
    ).catch(() => { /* headless Turnstile sometimes auto-passes without token */ });
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

  // Wait for Angular to process ngModel and enable the send button
  // (previously a 500ms sleep — this waits for the actual state we need).
  await p.waitForFunction(
    () => {
      const btn = document.querySelector('.chat-send-btn') as HTMLButtonElement | null;
      return !!btn && !btn.disabled;
    },
    { timeout: 5_000 }
  );

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

  // Wait for typing indicator to disappear and content to appear. Single
  // waitForFunction instead of a 30-iteration × 2s poll loop; returns the
  // rendered text via the `handle.jsonValue()` round-trip.
  const handle = await p.waitForFunction(
    () => {
      const msgs = document.querySelectorAll('.chat-message--bot');
      const last = msgs[msgs.length - 1];
      if (!last) return false;
      const typing = last.querySelector('.chat-typing');
      const textEl = last.querySelector('.chat-message-text') || last.querySelector('.chat-message-content');
      const text = textEl ? (textEl as HTMLElement).innerText.trim() : (last as HTMLElement).innerText.trim();
      return !typing && text.length > 0 ? text : false;
    },
    { timeout: 60_000 }
  ).catch(() => null);

  return handle ? String(await handle.jsonValue()) : '';
}

/**
 * Send a message using @mention syntax.
 */
export async function mentionApp(p: Page, slug: string, message: string): Promise<string> {
  return sendMessage(p, `@${slug} ${message}`);
}
