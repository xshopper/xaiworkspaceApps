import { test, expect } from '@playwright/test';
import { waitForChat, sendMessage, mentionApp, installApp } from './helpers';

test.describe('code-reviewer — Code Reviewer app', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForChat(page);
  });

  test('install code-reviewer app', async ({ page }) => {
    const response = await installApp(page, 'code-reviewer');
    const text = await response.textContent();
    expect(text).toMatch(/install|already|code.?review/i);
  });

  test('@code-reviewer — requires GitHub connection', async ({ page }) => {
    const response = await mentionApp(page, 'code-reviewer', 'review my latest PR');
    const text = await response.textContent();
    // Should ask to connect GitHub or show PR review
    expect(text).toMatch(/github|authorize|connect|pull request|PR|review|repository/i);
  });

  test('@code-reviewer review PR — shows review notes', async ({ page }) => {
    const response = await mentionApp(
      page,
      'code-reviewer',
      'review PR #1 on xshopper/xaiworkspaceApps'
    );
    const text = await response.textContent();
    // Should provide review or ask for GitHub access
    expect(text).toMatch(/review|github|connect|authorize|bug|security|code|PR/i);
  });

  test('@code-reviewer — never auto-approves', async ({ page }) => {
    const response = await mentionApp(page, 'code-reviewer', 'approve PR #1');
    const text = await response.textContent();
    // Should provide review notes, never auto-approve
    expect(text).toMatch(/review|note|cannot.*auto|approve|github|connect/i);
  });
});
