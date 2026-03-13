import { test, expect } from '@playwright/test';
import { waitForChat, sendMessage, mentionApp, installApp } from './helpers';

test.describe('skills — Summarize Text & Extract Data', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForChat(page);
  });

  // --- summarize-text ---

  test('install summarize-text skill', async ({ page }) => {
    const response = await installApp(page, 'summarize-text');
    const text = await response.textContent();
    expect(text).toMatch(/install|already|summarize/i);
  });

  test('@summarize-text — summarizes provided text', async ({ page }) => {
    const response = await mentionApp(
      page,
      'summarize-text',
      'The quick brown fox jumps over the lazy dog. This sentence contains every letter of the English alphabet and has been used as a typing test since the late 1800s.'
    );
    const text = await response.textContent();
    // Should return a summary
    expect(text).toMatch(/summary|point|alphabet|sentence|fox|typing/i);
  });

  test('@summarize-text bullets — returns bullet points', async ({ page }) => {
    const response = await mentionApp(
      page,
      'summarize-text',
      'Summarize in bullets: AI is transforming industries. Machine learning enables pattern recognition. Natural language processing powers chatbots. Computer vision automates inspection.'
    );
    const text = await response.textContent();
    // Should return bullet-style summary
    expect(text).toMatch(/AI|machine learning|NLP|vision|bullet|point|summar/i);
  });

  // --- extract-data ---

  test('install extract-data skill', async ({ page }) => {
    const response = await installApp(page, 'extract-data');
    const text = await response.textContent();
    expect(text).toMatch(/install|already|extract/i);
  });

  test('@extract-data — extracts structured info from text', async ({ page }) => {
    const response = await mentionApp(
      page,
      'extract-data',
      'Extract: Invoice #12345, Date: Jan 15 2025, Amount: $1,250.00, Vendor: Acme Corp'
    );
    const text = await response.textContent();
    // Should extract structured fields
    expect(text).toMatch(/12345|1,?250|acme|invoice|date|amount|vendor/i);
  });

  test('@extract-data — handles receipt text', async ({ page }) => {
    const response = await mentionApp(
      page,
      'extract-data',
      'Extract from receipt: Starbucks, 2 Lattes $9.50, 1 Muffin $3.25, Tax $1.02, Total $13.77'
    );
    const text = await response.textContent();
    // Should extract items and total
    expect(text).toMatch(/starbucks|13\.77|latte|muffin|total|tax|item/i);
  });
});
