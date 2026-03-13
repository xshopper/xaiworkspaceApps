import { Page, expect } from '@playwright/test';

/**
 * Wait for the chat to be connected and ready.
 */
export async function waitForChat(page: Page) {
  await expect(page.locator('.chat-input')).toBeVisible({ timeout: 30_000 });
  // Wait for WebSocket connection
  await expect(
    page.locator('.chat-status-dot--connected, .connection-status--connected')
  ).toBeVisible({ timeout: 30_000 });
}

/**
 * Send a message in the chat and wait for bot response.
 * Returns the last bot message element.
 */
export async function sendMessage(page: Page, text: string) {
  const input = page.locator('.chat-input');
  await input.fill(text);
  await page.locator('.chat-send-btn').click();

  // Wait for user message to appear
  await expect(
    page.locator('.chat-message--user').last()
  ).toContainText(text.slice(0, 20), { timeout: 5_000 });

  // Wait for bot response (typing indicator disappears, message appears)
  const botMsg = page.locator('.chat-message--bot').last();
  await expect(botMsg).toBeVisible({ timeout: 60_000 });

  // Wait for typing to finish (no more typing dots)
  await page.waitForTimeout(2_000);

  return botMsg;
}

/**
 * Send a message using @mention syntax.
 */
export async function mentionApp(page: Page, slug: string, message: string) {
  return sendMessage(page, `@${slug} ${message}`);
}

/**
 * Install a mini-app by slug using the /install command.
 */
export async function installApp(page: Page, slug: string) {
  return sendMessage(page, `/install ${slug}`);
}

/**
 * Uninstall a mini-app by slug.
 */
export async function uninstallApp(page: Page, slug: string) {
  return sendMessage(page, `/uninstall ${slug}`);
}

/**
 * Get all bot message texts as an array.
 */
export async function getBotMessages(page: Page): Promise<string[]> {
  const messages = page.locator('.chat-message--bot .chat-message-text');
  const count = await messages.count();
  const texts: string[] = [];
  for (let i = 0; i < count; i++) {
    texts.push((await messages.nth(i).textContent()) || '');
  }
  return texts;
}
