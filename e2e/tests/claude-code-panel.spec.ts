/**
 * Claude Code panel — E2E tests
 *
 * Tests the panel.js UI loaded in a mock xai sandbox harness.
 * No live Claude Code server needed — all xai.http() calls are intercepted
 * by the mock SDK in the harness HTML.
 *
 * Covers: panel rendering, status card, command bar, command routing,
 * prompt input, error display, session list, and mobile viewport.
 *
 * Run:
 *   npx playwright test claude-code-panel --config playwright.config.ts
 */
import { test, expect, Page } from '@playwright/test';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Health response returned by a healthy Claude Code server. */
const HEALTHY_RESPONSE = {
  data: {
    status: 'ok',
    port: 3457,
    cwd: '/home/user/project',
    activeQueries: 0,
    hasApiKey: true,
  },
};

/** Sessions list response. */
const SESSIONS_RESPONSE = {
  data: {
    sessions: [
      { sessionId: 'sess-abc123def456', cwd: '/home/user/project', summary: 'Fix auth bug', tag: 'v1.2' },
      { sessionId: 'sess-xyz789ghijkl', cwd: '/home/user/api', summary: 'Add endpoint' },
    ],
  },
};

/**
 * Install a mock HTTP handler that returns specific responses per URL pattern.
 * Call BEFORE firing the 'ready' event.
 */
async function installMockHttp(page: Page, handlers: Record<string, object | 'error'>) {
  await page.evaluate((h) => {
    (window as any).__mockHttpHandler = function (url: string) {
      for (const [pattern, result] of Object.entries(h)) {
        if (url.includes(pattern)) {
          if (result === 'error') throw new Error('Connection refused');
          return result;
        }
      }
      // Default: server unreachable
      throw new Error('Connection refused');
    };
  }, handlers);
}

/**
 * Fire the xai 'ready' event to bootstrap the panel, then wait for render.
 */
async function fireReady(page: Page) {
  await page.evaluate(() => (window as any).__fireXaiEvent('ready'));
  // Wait for the panel DOM to appear (render() injects HTML into body)
  await page.waitForSelector('.panel', { timeout: 5000 });
}

/**
 * Navigate to the harness page (resets all state).
 */
async function loadHarness(page: Page) {
  await page.goto('/');
  // Wait for the xai mock to be installed
  await page.waitForFunction(() => typeof (window as any).xai !== 'undefined', { timeout: 5000 });
}

// ── Tests: Offline / Default State ─────────────────────────────────────────

test.describe('Claude Code panel — offline state', () => {
  test.beforeEach(async ({ page }) => {
    await loadHarness(page);
    // No mock HTTP installed => all calls throw "Connection refused"
    await fireReady(page);
  });

  test('renders panel with CLAUDE CODE header', async ({ page }) => {
    const title = page.locator('.title');
    await expect(title).toBeVisible();
    await expect(title).toHaveText('Claude Code');
  });

  test('status card shows Offline badge', async ({ page }) => {
    const badge = page.locator('.badge-off');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('Offline');
  });

  test('status card shows hint to start server', async ({ page }) => {
    const hint = page.locator('.hint');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('@claude-code start');
  });

  test('output shows "not running" system message', async ({ page }) => {
    const sys = page.locator('.e-sys');
    await expect(sys).toBeVisible();
    await expect(sys).toContainText('not running');
  });

  test('command bar shows 6 buttons', async ({ page }) => {
    const chips = page.locator('.cmd-bar .chip');
    await expect(chips).toHaveCount(6);

    const labels = await chips.allTextContents();
    expect(labels.map(l => l.trim())).toEqual([
      'Status', 'Start', 'Stop', 'Restart', 'Logs', 'Sessions',
    ]);
  });

  test('Start button is enabled when offline', async ({ page }) => {
    const startBtn = page.getByRole('button', { name: 'Start', exact: true });
    await expect(startBtn).toBeEnabled();
  });

  test('Stop button is disabled when offline', async ({ page }) => {
    const stopBtn = page.getByRole('button', { name: 'Stop', exact: true });
    await expect(stopBtn).toBeDisabled();
  });

  test('prompt input field is present and enabled', async ({ page }) => {
    const input = page.locator('#cmd-input');
    await expect(input).toBeVisible();
    await expect(input).toBeEnabled();
    await expect(input).toHaveAttribute('placeholder', 'prompt or command');
  });

  test('run button shows return symbol', async ({ page }) => {
    const btn = page.locator('.btn-run');
    await expect(btn).toBeVisible();
    const text = await btn.textContent();
    expect(text?.trim()).toBe('\u21b5');
  });
});

// ── Tests: Online / Healthy State ──────────────────────────────────────────

test.describe('Claude Code panel — online state', () => {
  test.beforeEach(async ({ page }) => {
    await loadHarness(page);
    await installMockHttp(page, {
      '/health': HEALTHY_RESPONSE,
      '/sessions': SESSIONS_RESPONSE,
    });
    await fireReady(page);
  });

  test('status card shows Running badge', async ({ page }) => {
    const badge = page.locator('.badge-on').first();
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('Running');
  });

  test('status card shows port 3457', async ({ page }) => {
    const rows = page.locator('.card-row');
    const portRow = rows.filter({ hasText: 'Port' });
    await expect(portRow.locator('.val')).toHaveText('3457');
  });

  test('status card shows CWD', async ({ page }) => {
    const cwd = page.locator('.card-row').filter({ hasText: 'CWD' }).locator('.val');
    await expect(cwd).toHaveText('/home/user/project');
  });

  test('status card shows active queries count', async ({ page }) => {
    const row = page.locator('.card-row').filter({ hasText: 'Active queries' }).locator('.val');
    await expect(row).toHaveText('0');
  });

  test('status card shows API Key Set badge', async ({ page }) => {
    const row = page.locator('.card-row').filter({ hasText: 'API Key' });
    const badge = row.locator('.badge-on');
    await expect(badge).toHaveText('Set');
  });

  test('Start button is disabled when online', async ({ page }) => {
    const startBtn = page.getByRole('button', { name: 'Start', exact: true });
    await expect(startBtn).toBeDisabled();
  });

  test('Stop button is enabled when online', async ({ page }) => {
    const stopBtn = page.getByRole('button', { name: 'Stop', exact: true });
    await expect(stopBtn).toBeEnabled();
  });

  test('output shows "ready" system message', async ({ page }) => {
    const sys = page.locator('.e-sys');
    await expect(sys).toBeVisible();
    await expect(sys).toContainText('ready');
  });
});

// ── Tests: Command Routing ─────────────────────────────────────────────────

test.describe('Claude Code panel — command routing', () => {
  test.beforeEach(async ({ page }) => {
    await loadHarness(page);
    // Start offline so Start button is clickable
    await fireReady(page);
  });

  test('clicking Start sends @claude-code start to chat', async ({ page }) => {
    const startBtn = page.getByRole('button', { name: 'Start', exact: true });
    await startBtn.click();

    const messages = await page.evaluate(() => (window as any).__xaiChatMessages);
    expect(messages).toContain('@claude-code start');
  });

  test('clicking Status sends @claude-code status to chat', async ({ page }) => {
    const btn = page.locator('.chip', { hasText: 'Status' });
    await btn.click();

    const messages = await page.evaluate(() => (window as any).__xaiChatMessages);
    expect(messages).toContain('@claude-code status');
  });

  test('clicking Restart sends @claude-code restart to chat', async ({ page }) => {
    const btn = page.locator('.chip', { hasText: 'Restart' });
    await btn.click();

    const messages = await page.evaluate(() => (window as any).__xaiChatMessages);
    expect(messages).toContain('@claude-code restart');
  });

  test('clicking Logs sends @claude-code logs to chat', async ({ page }) => {
    const btn = page.locator('.chip', { hasText: 'Logs' });
    await btn.click();

    const messages = await page.evaluate(() => (window as any).__xaiChatMessages);
    expect(messages).toContain('@claude-code logs');
  });

  test('clicking Stop sends @claude-code stop to chat when online', async ({ page }) => {
    // Reload with healthy state so Stop is enabled
    await loadHarness(page);
    await installMockHttp(page, { '/health': HEALTHY_RESPONSE });
    await fireReady(page);

    const stopBtn = page.getByRole('button', { name: 'Stop', exact: true });
    await stopBtn.click();

    const messages = await page.evaluate(() => (window as any).__xaiChatMessages);
    expect(messages).toContain('@claude-code stop');
  });

  test('command click adds info message to output', async ({ page }) => {
    const btn = page.locator('.chip', { hasText: 'Status' });
    await btn.click();

    const info = page.locator('.e-info');
    await expect(info).toBeVisible();
    await expect(info).toContainText('@claude-code status');
  });
});

// ── Tests: Prompt Input ────────────────────────────────────────────────────

test.describe('Claude Code panel — prompt input', () => {
  test.beforeEach(async ({ page }) => {
    await loadHarness(page);
    // Install mock that accepts queries
    await installMockHttp(page, {
      '/health': HEALTHY_RESPONSE,
      '/query': { data: { ok: true, sessionId: 'sess-new123', output: 'File created successfully.' } },
    });
    await fireReady(page);
  });

  test('typing and pressing Enter sends query', async ({ page }) => {
    const input = page.locator('#cmd-input');
    await input.fill('fix the auth bug');
    await input.press('Enter');

    // Wait for the response to appear in output
    const response = page.locator('.e-res');
    await expect(response).toBeVisible({ timeout: 5000 });
    await expect(response).toContainText('File created successfully');
  });

  test('query adds command echo to output', async ({ page }) => {
    const input = page.locator('#cmd-input');
    await input.fill('explain this code');
    await input.press('Enter');

    const cmd = page.locator('.e-cmd');
    await expect(cmd).toBeVisible();
    await expect(cmd).toContainText('explain this code');
  });

  test('session badge appears after successful query', async ({ page }) => {
    const input = page.locator('#cmd-input');
    await input.fill('hello');
    await input.press('Enter');

    // Wait for the response, then the re-render with session badge
    await page.locator('.e-res').waitFor({ timeout: 5000 });
    const badge = page.locator('.session-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('sess-new');
  });

  test('clicking run button submits the prompt', async ({ page }) => {
    const input = page.locator('#cmd-input');
    await input.fill('list files');

    const runBtn = page.locator('.btn-run');
    await runBtn.click();

    const response = page.locator('.e-res');
    await expect(response).toBeVisible({ timeout: 5000 });
    await expect(response).toContainText('File created successfully');
  });

  test('empty input does not submit', async ({ page }) => {
    const runBtn = page.locator('.btn-run');
    await runBtn.click();

    // No command echo should appear
    const cmd = page.locator('.e-cmd');
    await expect(cmd).toHaveCount(0);
  });
});

// ── Tests: Error Display ───────────────────────────────────────────────────

test.describe('Claude Code panel — error handling', () => {
  test('shows error when query fails due to unreachable server', async ({ page }) => {
    await loadHarness(page);
    // Health fails but let the panel load
    await fireReady(page);

    // Type a prompt and submit — the /query call will also fail (default mock)
    const input = page.locator('#cmd-input');
    await input.fill('test query');
    await input.press('Enter');

    const error = page.locator('.e-err');
    await expect(error).toBeVisible({ timeout: 5000 });
    await expect(error).toContainText('Could not reach Claude Code server');
  });

  test('shows error message from server response', async ({ page }) => {
    await loadHarness(page);
    await installMockHttp(page, {
      '/health': HEALTHY_RESPONSE,
      '/query': { data: { ok: false, error: 'ANTHROPIC_API_KEY not set' } },
    });
    await fireReady(page);

    const input = page.locator('#cmd-input');
    await input.fill('test');
    await input.press('Enter');

    const error = page.locator('.e-err');
    await expect(error).toBeVisible({ timeout: 5000 });
    await expect(error).toContainText('ANTHROPIC_API_KEY not set');
  });

  test('status card reverts to Offline after query failure', async ({ page }) => {
    await loadHarness(page);
    // Start healthy
    await installMockHttp(page, { '/health': HEALTHY_RESPONSE });
    await fireReady(page);

    // Verify initially online
    await expect(page.locator('.badge-on').first()).toHaveText('Running');

    // Switch to failing mock for query (simulates server crash)
    await installMockHttp(page, {
      '/health': 'error' as any,
    });

    // Submit a query — it will fail since /query has no handler
    const input = page.locator('#cmd-input');
    await input.fill('test');
    await input.press('Enter');

    // After the query error, panel calls checkHealth() which also fails,
    // so status should revert to Offline
    await expect(page.locator('.badge-off')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.badge-off')).toHaveText('Offline');
  });
});

// ── Tests: Session List ────────────────────────────────────────────────────

test.describe('Claude Code panel — sessions', () => {
  test.beforeEach(async ({ page }) => {
    await loadHarness(page);
    await installMockHttp(page, {
      '/health': HEALTHY_RESPONSE,
      '/sessions': SESSIONS_RESPONSE,
    });
    await fireReady(page);
  });

  test('Sessions button toggles session panel', async ({ page }) => {
    // Initially no session list visible
    await expect(page.locator('.session-row')).toHaveCount(0);

    // Click Sessions
    const sessBtn = page.locator('.chip', { hasText: 'Sessions' });
    await sessBtn.click();

    // Session rows should appear
    const rows = page.locator('.session-row');
    await expect(rows).toHaveCount(2);

    // Click again to toggle off
    await sessBtn.click();
    await expect(page.locator('.session-row')).toHaveCount(0);
  });

  test('Sessions button gets active styling when open', async ({ page }) => {
    const sessBtn = page.locator('.chip', { hasText: 'Sessions' });
    await sessBtn.click();

    await expect(sessBtn).toHaveClass(/chip-active/);
  });

  test('session rows show truncated ID and summary', async ({ page }) => {
    const sessBtn = page.locator('.chip', { hasText: 'Sessions' });
    await sessBtn.click();

    const firstRow = page.locator('.session-row').first();
    const id = firstRow.locator('.session-id');
    const cwd = firstRow.locator('.session-cwd');
    await expect(id).toContainText('sess-abc123d');
    await expect(cwd).toContainText('Fix auth bug');
  });

  test('session row with tag shows tag badge', async ({ page }) => {
    const sessBtn = page.locator('.chip', { hasText: 'Sessions' });
    await sessBtn.click();

    const tag = page.locator('.session-tag').first();
    await expect(tag).toBeVisible();
    await expect(tag).toHaveText('v1.2');
  });

  test('clicking a session row resumes it', async ({ page }) => {
    const sessBtn = page.locator('.chip', { hasText: 'Sessions' });
    await sessBtn.click();

    const firstRow = page.locator('.session-row').first();
    await firstRow.click();

    // Session panel should close
    await expect(page.locator('.session-row')).toHaveCount(0);

    // Session badge should appear in header
    const badge = page.locator('.session-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('sess-abc');

    // System message about resuming
    const sys = page.locator('.e-sys').last();
    await expect(sys).toContainText('Resumed session');
  });

  test('empty sessions shows hint', async ({ page }) => {
    // Override with empty sessions
    await installMockHttp(page, {
      '/health': HEALTHY_RESPONSE,
      '/sessions': { data: { sessions: [] } },
    });

    const sessBtn = page.locator('.chip', { hasText: 'Sessions' });
    await sessBtn.click();

    const hint = page.locator('.hint');
    // There may be multiple hints; find the one about sessions
    const sessionHint = page.locator('.hint', { hasText: 'No past sessions' });
    await expect(sessionHint).toBeVisible();
  });
});

// ── Tests: Mobile Viewport ─────────────────────────────────────────────────

test.describe('Claude Code panel — mobile viewport', () => {
  // These run under the mobile-chrome project (412x915)

  test.beforeEach(async ({ page }) => {
    await loadHarness(page);
    await installMockHttp(page, {
      '/health': HEALTHY_RESPONSE,
      '/sessions': SESSIONS_RESPONSE,
    });
    await fireReady(page);
  });

  test('panel renders without horizontal overflow', async ({ page }) => {
    const panel = page.locator('.panel');
    await expect(panel).toBeVisible();

    const overflow = await page.evaluate(() => {
      const el = document.querySelector('.panel');
      if (!el) return false;
      return el.scrollWidth <= el.clientWidth + 1;
    });
    expect(overflow).toBe(true);
  });

  test('all 6 command buttons are visible', async ({ page }) => {
    const chips = page.locator('.cmd-bar .chip');
    await expect(chips).toHaveCount(6);

    // Each button should be visible (may wrap to multiple rows)
    for (let i = 0; i < 6; i++) {
      await expect(chips.nth(i)).toBeVisible();
    }
  });

  test('prompt input is usable', async ({ page }) => {
    const input = page.locator('#cmd-input');
    await expect(input).toBeVisible();
    await expect(input).toBeEnabled();

    // Type and verify
    await input.fill('mobile test');
    await expect(input).toHaveValue('mobile test');
  });

  test('status card rows do not truncate labels', async ({ page }) => {
    const labels = page.locator('.card-row .label');
    const count = await labels.count();
    expect(count).toBeGreaterThanOrEqual(4); // Server, Port, CWD, Active queries, API Key

    for (let i = 0; i < count; i++) {
      await expect(labels.nth(i)).toBeVisible();
    }
  });

  test('session list renders within viewport', async ({ page }) => {
    const sessBtn = page.locator('.chip', { hasText: 'Sessions' });
    await sessBtn.click();

    const rows = page.locator('.session-row');
    await expect(rows).toHaveCount(2);

    // Verify session rows are within the viewport width
    const vpWidth = page.viewportSize()?.width ?? 412;
    for (let i = 0; i < 2; i++) {
      const box = await rows.nth(i).boundingBox();
      expect(box).not.toBeNull();
      if (box) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(vpWidth + 2);
      }
    }
  });
});

// ── Tests: API Key Missing State ───────────────────────────────────────────

test.describe('Claude Code panel — API key missing', () => {
  test('shows Missing badge when API key is not set', async ({ page }) => {
    await loadHarness(page);
    const noKeyHealth = {
      data: {
        ...HEALTHY_RESPONSE.data,
        hasApiKey: false,
      },
    };
    await installMockHttp(page, { '/health': noKeyHealth });
    await fireReady(page);

    const row = page.locator('.card-row').filter({ hasText: 'API Key' });
    const badge = row.locator('.badge-off');
    await expect(badge).toHaveText('Missing');
  });
});

// ── Tests: Spinner / Working State ────────────────────────────────────────

test.describe('Claude Code panel — working state', () => {
  test('shows spinner and disables input while query runs', async ({ page }) => {
    await loadHarness(page);
    // Install a slow mock: /health responds instantly, /query hangs until released
    await page.evaluate(() => {
      let resolveQuery: ((v: any) => void) | null = null;
      (window as any).__releaseQuery = (result: any) => { if (resolveQuery) resolveQuery(result); };
      (window as any).__mockHttpHandler = function (url: string) {
        if (url.includes('/health')) {
          return { data: { status: 'ok', port: 3457, cwd: '/home/user/project', activeQueries: 0, hasApiKey: true } };
        }
        if (url.includes('/query')) {
          return new Promise(r => { resolveQuery = r; });
        }
        throw new Error('Connection refused');
      };
    });
    await fireReady(page);

    // Submit a prompt
    const input = page.locator('#cmd-input');
    await input.fill('slow task');
    await input.press('Enter');

    // While the query is running, verify spinner appears
    const spinner = page.locator('.spinner');
    await expect(spinner).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.spin-text')).toHaveText('Claude Code is working\u2026');

    // Input should be disabled
    await expect(page.locator('#cmd-input')).toBeDisabled();

    // Run button should show ellipsis and be disabled
    const runBtn = page.locator('.btn-run');
    await expect(runBtn).toBeDisabled();

    // Stop button (square) should appear
    const stopBtn = page.locator('.btn-stop');
    await expect(stopBtn).toBeVisible();

    // Release the query
    await page.evaluate(() => {
      (window as any).__releaseQuery({ data: { ok: true, sessionId: 'sess-slow', output: 'Done.' } });
    });

    // Spinner should disappear, response should appear
    await expect(spinner).toBeHidden({ timeout: 5000 });
    await expect(page.locator('.e-res')).toContainText('Done.');

    // Input should be re-enabled
    await expect(page.locator('#cmd-input')).toBeEnabled();
  });
});

// ── Tests: Stop Query ─────────────────────────────────────────────────────

test.describe('Claude Code panel — stop query', () => {
  test('stop button sends POST to /stop and shows system message', async ({ page }) => {
    await loadHarness(page);

    let stopCalled = false;
    await page.evaluate(() => {
      let resolveQuery: ((v: any) => void) | null = null;
      (window as any).__releaseQuery = (result: any) => { if (resolveQuery) resolveQuery(result); };
      (window as any).__stopCalled = false;
      (window as any).__mockHttpHandler = function (url: string) {
        if (url.includes('/health')) {
          return { data: { status: 'ok', port: 3457, cwd: '/home/user/project', activeQueries: 0, hasApiKey: true } };
        }
        if (url.includes('/query')) {
          return new Promise(r => { resolveQuery = r; });
        }
        if (url.includes('/stop')) {
          (window as any).__stopCalled = true;
          // Also release the pending query so the panel finishes its run() cycle
          if (resolveQuery) resolveQuery({ data: { ok: false, error: 'Cancelled' } });
          return { data: { ok: true, message: 'Query cancelled' } };
        }
        throw new Error('Connection refused');
      };
    });
    await fireReady(page);

    // First send a prompt to create a session, but we need one for stop to work.
    // The stop function checks state.sessionId — we need a successful query first
    // to set it. Let's use a two-step approach: first do a quick query, then
    // start a slow one and stop it.

    // Quick query to establish session
    await installMockHttp(page, {
      '/health': HEALTHY_RESPONSE,
      '/query': { data: { ok: true, sessionId: 'sess-stop-test', output: 'First done.' } },
    });
    const input = page.locator('#cmd-input');
    await input.fill('setup');
    await input.press('Enter');
    await page.locator('.e-res').waitFor({ timeout: 5000 });

    // Now install slow mock for the next query
    await page.evaluate(() => {
      let resolveQuery: ((v: any) => void) | null = null;
      (window as any).__releaseQuery = (result: any) => { if (resolveQuery) resolveQuery(result); };
      (window as any).__stopCalled = false;
      (window as any).__mockHttpHandler = function (url: string) {
        if (url.includes('/health')) {
          return { data: { status: 'ok', port: 3457, cwd: '/home/user/project', activeQueries: 1, hasApiKey: true } };
        }
        if (url.includes('/query')) {
          return new Promise(r => { resolveQuery = r; });
        }
        if (url.includes('/stop')) {
          (window as any).__stopCalled = true;
          if (resolveQuery) resolveQuery({ data: { ok: false, error: 'Cancelled' } });
          return { data: { ok: true, message: 'Query cancelled' } };
        }
        throw new Error('Connection refused');
      };
    });

    // Start slow query
    await input.fill('slow work');
    await input.press('Enter');

    // Wait for stop button to appear
    const stopBtn = page.locator('.btn-stop');
    await expect(stopBtn).toBeVisible({ timeout: 3000 });

    // Click stop
    await stopBtn.click();

    // Verify stop was called
    stopCalled = await page.evaluate(() => (window as any).__stopCalled);
    expect(stopCalled).toBe(true);

    // System message about stop should appear
    const sysMessages = page.locator('.e-sys');
    const lastSys = sysMessages.last();
    await expect(lastSys).toContainText('Stop signal sent');
  });
});

// ── Tests: Markdown Rendering ─────────────────────────────────────────────

test.describe('Claude Code panel — markdown rendering', () => {
  test.beforeEach(async ({ page }) => {
    await loadHarness(page);
  });

  test('renders fenced code block in response', async ({ page }) => {
    await installMockHttp(page, {
      '/health': HEALTHY_RESPONSE,
      '/query': { data: { ok: true, sessionId: 'sess-md1', output: 'Here is code:\n```js\nconsole.log("hello");\n```' } },
    });
    await fireReady(page);

    const input = page.locator('#cmd-input');
    await input.fill('show code');
    await input.press('Enter');

    const pre = page.locator('.e-res pre');
    await expect(pre).toBeVisible({ timeout: 5000 });
    const code = pre.locator('code');
    await expect(code).toContainText('console.log("hello");');
  });

  test('renders inline code in response', async ({ page }) => {
    await installMockHttp(page, {
      '/health': HEALTHY_RESPONSE,
      '/query': { data: { ok: true, sessionId: 'sess-md2', output: 'Use `npm install` to install.' } },
    });
    await fireReady(page);

    const input = page.locator('#cmd-input');
    await input.fill('help');
    await input.press('Enter');

    const inlineCode = page.locator('.e-res code.il');
    await expect(inlineCode).toBeVisible({ timeout: 5000 });
    await expect(inlineCode).toHaveText('npm install');
  });

  test('renders bold text in response', async ({ page }) => {
    await installMockHttp(page, {
      '/health': HEALTHY_RESPONSE,
      '/query': { data: { ok: true, sessionId: 'sess-md3', output: 'This is **important** text.' } },
    });
    await fireReady(page);

    const input = page.locator('#cmd-input');
    await input.fill('test');
    await input.press('Enter');

    const bold = page.locator('.e-res strong');
    await expect(bold).toBeVisible({ timeout: 5000 });
    await expect(bold).toHaveText('important');
  });

  test('escapes HTML in response text to prevent XSS', async ({ page }) => {
    await installMockHttp(page, {
      '/health': HEALTHY_RESPONSE,
      '/query': { data: { ok: true, sessionId: 'sess-xss', output: '**<img src=x onerror=alert(1)>**' } },
    });
    await fireReady(page);

    const input = page.locator('#cmd-input');
    await input.fill('xss test');
    await input.press('Enter');

    // The bold tag should contain escaped HTML, not an actual img element
    const bold = page.locator('.e-res strong');
    await expect(bold).toBeVisible({ timeout: 5000 });
    // Verify no img element was injected
    const imgCount = await page.locator('.e-res img').count();
    expect(imgCount).toBe(0);
    // The escaped text should be visible
    await expect(bold).toContainText('<img');
  });
});

// ── Tests: HTTP Call Verification ─────────────────────────────────────────

test.describe('Claude Code panel — HTTP call verification', () => {
  test('query sends correct POST body with prompt and sessionId', async ({ page }) => {
    await loadHarness(page);
    await installMockHttp(page, {
      '/health': HEALTHY_RESPONSE,
      '/query': { data: { ok: true, sessionId: 'sess-verify', output: 'OK' } },
    });
    await fireReady(page);

    // First query (no session)
    const input = page.locator('#cmd-input');
    await input.fill('first prompt');
    await input.press('Enter');
    await page.locator('.e-res').waitFor({ timeout: 5000 });

    // Verify the HTTP call
    const calls = await page.evaluate(() => (window as any).__xaiHttpCalls);
    const queryCall = calls.find((c: any) => c.url.includes('/query'));
    expect(queryCall).toBeDefined();
    const body = JSON.parse(queryCall.opts.body);
    expect(body.prompt).toBe('first prompt');
    expect(body.sessionId).toBeNull(); // No session yet on first query

    // Second query (should include sessionId from first response)
    await installMockHttp(page, {
      '/health': HEALTHY_RESPONSE,
      '/query': { data: { ok: true, sessionId: 'sess-verify', output: 'OK2' } },
    });
    // Clear tracked calls
    await page.evaluate(() => { (window as any).__xaiHttpCalls = []; });

    await input.fill('second prompt');
    await input.press('Enter');
    await page.locator('.e-res').last().waitFor({ timeout: 5000 });

    const calls2 = await page.evaluate(() => (window as any).__xaiHttpCalls);
    const queryCall2 = calls2.find((c: any) => c.url.includes('/query'));
    expect(queryCall2).toBeDefined();
    const body2 = JSON.parse(queryCall2.opts.body);
    expect(body2.prompt).toBe('second prompt');
    expect(body2.sessionId).toBe('sess-verify'); // Session from first query
  });

  test('health check is called on bootstrap', async ({ page }) => {
    await loadHarness(page);
    await installMockHttp(page, { '/health': HEALTHY_RESPONSE });
    await fireReady(page);

    const calls = await page.evaluate(() => (window as any).__xaiHttpCalls);
    const healthCalls = calls.filter((c: any) => c.url.includes('/health'));
    expect(healthCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Tests: chat.message Event Handler ─────────────────────────────────────

test.describe('Claude Code panel — chat.message handler', () => {
  test('refreshes health when chat message contains @claude-code', async ({ page }) => {
    await loadHarness(page);
    // Start offline
    await fireReady(page);
    await expect(page.locator('.badge-off')).toHaveText('Offline');

    // Now make health succeed (server came online after a @claude-code start command)
    await installMockHttp(page, { '/health': HEALTHY_RESPONSE });

    // Fire a chat.message event with @claude-code text
    await page.evaluate(() => {
      (window as any).__fireXaiEvent('chat.message', { text: '@claude-code start result' });
    });

    // The handler has a 3-second delay before checking health
    // Wait for the badge to switch to Running
    await expect(page.locator('.badge-on').first()).toHaveText('Running', { timeout: 5000 });
  });

  test('ignores chat messages without @claude-code', async ({ page }) => {
    await loadHarness(page);
    await fireReady(page);
    await expect(page.locator('.badge-off')).toHaveText('Offline');

    // Make health succeed, but fire a non-relevant chat message
    await installMockHttp(page, { '/health': HEALTHY_RESPONSE });
    await page.evaluate(() => {
      (window as any).__fireXaiEvent('chat.message', { text: 'Hello world' });
    });

    // Wait a bit — badge should remain Offline since the handler ignores non-matching messages
    await page.waitForTimeout(1000);
    await expect(page.locator('.badge-off')).toHaveText('Offline');
  });
});

// ── Tests: Command Button State Consistency ───────────────────────────────

test.describe('Claude Code panel — button state consistency', () => {
  test('Restart button is always enabled regardless of server state', async ({ page }) => {
    // Offline
    await loadHarness(page);
    await fireReady(page);
    const restartBtn = page.locator('.chip', { hasText: 'Restart' });
    await expect(restartBtn).toBeEnabled();

    // Online
    await loadHarness(page);
    await installMockHttp(page, { '/health': HEALTHY_RESPONSE });
    await fireReady(page);
    const restartBtn2 = page.locator('.chip', { hasText: 'Restart' });
    await expect(restartBtn2).toBeEnabled();
  });

  test('Status button is always enabled regardless of server state', async ({ page }) => {
    // Offline
    await loadHarness(page);
    await fireReady(page);
    const statusBtn = page.locator('.chip', { hasText: 'Status' });
    await expect(statusBtn).toBeEnabled();

    // Online
    await loadHarness(page);
    await installMockHttp(page, { '/health': HEALTHY_RESPONSE });
    await fireReady(page);
    const statusBtn2 = page.locator('.chip', { hasText: 'Status' });
    await expect(statusBtn2).toBeEnabled();
  });

  test('Logs button is always enabled regardless of server state', async ({ page }) => {
    // Offline
    await loadHarness(page);
    await fireReady(page);
    const logsBtn = page.locator('.chip', { hasText: 'Logs' });
    await expect(logsBtn).toBeEnabled();

    // Online
    await loadHarness(page);
    await installMockHttp(page, { '/health': HEALTHY_RESPONSE });
    await fireReady(page);
    const logsBtn2 = page.locator('.chip', { hasText: 'Logs' });
    await expect(logsBtn2).toBeEnabled();
  });
});

// ── Tests: Output Accumulation ────────────────────────────────────────────

test.describe('Claude Code panel — output accumulation', () => {
  test('multiple queries accumulate in the output log', async ({ page }) => {
    await loadHarness(page);
    await installMockHttp(page, {
      '/health': HEALTHY_RESPONSE,
      '/query': { data: { ok: true, sessionId: 'sess-multi', output: 'Response one.' } },
    });
    await fireReady(page);

    const input = page.locator('#cmd-input');

    // First query
    await input.fill('query one');
    await input.press('Enter');
    await expect(page.locator('.e-res').first()).toContainText('Response one', { timeout: 5000 });

    // Change response for second query
    await installMockHttp(page, {
      '/health': HEALTHY_RESPONSE,
      '/query': { data: { ok: true, sessionId: 'sess-multi', output: 'Response two.' } },
    });

    // Second query
    await input.fill('query two');
    await input.press('Enter');
    await expect(page.locator('.e-res').last()).toContainText('Response two', { timeout: 5000 });

    // Verify both command echoes and both responses are in the output
    const cmdEntries = page.locator('.e-cmd');
    await expect(cmdEntries).toHaveCount(2);

    const resEntries = page.locator('.e-res');
    await expect(resEntries).toHaveCount(2);

    // Plus the initial system message
    const sysEntries = page.locator('.e-sys');
    await expect(sysEntries).toHaveCount(1);
  });

  test('info message from renderMd renders inline code correctly', async ({ page }) => {
    await loadHarness(page);
    await fireReady(page);

    // Click a command button — produces info message with renderMd
    const btn = page.locator('.chip', { hasText: 'Status' });
    await btn.click();

    // Info message uses renderMd, so backtick-wrapped text becomes inline code
    const infoCode = page.locator('.e-info code.il');
    await expect(infoCode).toBeVisible();
    await expect(infoCode).toContainText('@claude-code status');
  });
});
