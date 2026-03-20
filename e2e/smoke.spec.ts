/**
 * Smoke tests — single connection, one message per concept.
 * Each test shares the same page/session to avoid rate limits.
 */
import { Page } from 'puppeteer-core';
import { setup, teardown, waitForChat, sendMessage } from './helpers';

let page: Page;

beforeAll(async () => {
  page = await setup();
  await waitForChat(page);
}, 120_000);

afterAll(async () => {
  await teardown();
});

describe('xAI Workspace — smoke tests', () => {
  test('chat is connected and responsive', async () => {
    const text = await sendMessage(page, 'Say PINEAPPLE if you can read this.');
    expect(text.toLowerCase()).toContain('pineapple');
  });

  test('bot understands email management concepts', async () => {
    const text = await sendMessage(page, 'In one sentence, what does an email manager app do?');
    expect(text).toMatch(/email|inbox|manage|message|organiz/i);
  });

  test('bot understands expense tracking', async () => {
    const text = await sendMessage(page, 'Name 3 categories for business expenses in a comma-separated list.');
    expect(text).toMatch(/travel|food|office|supplies|transport|software|utilit|entertain/i);
  });

  test('bot can summarize text', async () => {
    const text = await sendMessage(
      page,
      'Summarize in one bullet: AI enables pattern recognition through machine learning.'
    );
    expect(text).toMatch(/AI|machine learning|pattern|recogni/i);
  });

  test('bot can extract structured data', async () => {
    const text = await sendMessage(
      page,
      'What is the amount in this text? Invoice #999, Amount: $1,250.00, Vendor: Acme'
    );
    expect(text).toMatch(/1,?250|amount|invoice/i);
  });

  test('bot understands code review concepts', async () => {
    const text = await sendMessage(page, 'Name the top 3 things to check in a code review. Be brief.');
    expect(text).toMatch(/bug|security|test|readab|logic|error|quality/i);
  });

  test('bot understands sales pipeline concepts', async () => {
    const text = await sendMessage(page, 'What does MEDDIC stand for? Answer as a list.');
    expect(text).toMatch(/metric|economic|decision|pain|champion/i);
  });

  test('bot understands support workflows', async () => {
    const text = await sendMessage(page, 'When should a support bot escalate to a human? One sentence.');
    expect(text).toMatch(/escalat|human|complex|billing|sensitive|refund/i);
  });
});
