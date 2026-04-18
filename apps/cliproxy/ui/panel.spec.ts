/**
 * Unit tests for panel.ts — the CLIProxy UI panel module.
 *
 * panel.ts performs its work against the platform-injected `xai` global and
 * against DOM globals (`window`, `document`). The tests stub those globals
 * before each test, load the module in isolation, and drive its exported
 * handlers to cover the OAuth state machine, provider connect/disconnect,
 * and form-submission flows.
 */

import type { ModelsResponse, TokenStatus, Model } from './types';

type XaiStub = {
  http: jest.Mock;
  render: jest.Mock;
  openUrl: jest.Mock;
  on: jest.Mock;
  chat: { send: jest.Mock };
  cliproxy: { startOAuth: jest.Mock; pollOAuth: jest.Mock };
};

function makeXai(): XaiStub {
  return {
    http: jest.fn(),
    render: jest.fn(),
    openUrl: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    chat: { send: jest.fn() },
    cliproxy: { startOAuth: jest.fn(), pollOAuth: jest.fn() },
  };
}

type DocStub = {
  getElementById: jest.Mock;
  querySelector: jest.Mock;
  activeElement: { tagName: string } | null;
  addEventListener: jest.Mock;
};

function makeDoc(): DocStub {
  return {
    getElementById: jest.fn().mockReturnValue(null),
    querySelector: jest.fn().mockReturnValue(null),
    activeElement: null,
    addEventListener: jest.fn(),
  };
}

type PanelModule = typeof import('./panel');

// The platform globals that panel.ts relies on (xai, window, document) have
// DOM-library types in the default node lib. Rather than model stubs that
// conform to those complex shapes, treat `globalThis` as an untyped bag for
// the duration of a test. Cleanup happens in `afterEach`.
const g = globalThis as unknown as Record<string, unknown>;

function loadPanel(xaiStub: XaiStub, doc: DocStub = makeDoc()): PanelModule {
  g.xai = xaiStub;
  g.window = {};
  g.document = doc;
  // Purge the panel module from Jest's cache so each test re-evaluates it
  // with fresh module-level state (OAuth flags, form drafts, etc.) bound
  // against the currently-installed xai/window/document stubs.
  jest.resetModules();
  // Use the explicit .ts extension so Jest's resolver picks the TypeScript
  // source rather than the bundled `panel.js` that sits next to it (the
  // esbuild IIFE bundle exposes no exports).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./panel.ts') as PanelModule;
}

/** Flush queued promise microtasks so awaited continuations run. */
async function flushPromises(): Promise<void> {
  // A handful of microtask turns is enough to resolve chained awaits in the
  // code under test without relying on a host-specific primitive
  // (setImmediate behaves differently under Jest fake timers).
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

const sampleModels: ModelsResponse = {
  object: 'list',
  data: [
    { id: 'claude-opus-4', name: 'Claude Opus', owned_by: 'claude' },
    { id: 'gpt-4', name: 'GPT-4', owned_by: 'openai' },
  ],
};

const sampleToken: TokenStatus = {
  type: 'oauth',
  email: 'user@example.com',
  expired: '2027-01-01T00:00:00Z',
  is_expired: false,
  access_token_prefix: 'sk-abc',
  has_refresh_token: true,
  last_refresh: '2026-04-01T00:00:00Z',
};

/** Response sequencing helper: match by URL substring to support interleaved calls. */
function routeHttp(xaiStub: XaiStub, routes: Array<{ match: string; data: unknown; reject?: boolean }>): void {
  xaiStub.http.mockImplementation((url: string) => {
    const route = routes.find((r) => url.includes(r.match));
    if (!route) return Promise.reject(new Error(`no stub for ${url}`));
    return route.reject
      ? Promise.reject(route.data)
      : Promise.resolve({ status: 200, data: route.data });
  });
}

beforeEach(() => {
  // Use fake timers for every test so no `setTimeout`/`setInterval` created
  // by a handler (notably the 6s success banner) leaks into the event loop
  // and delays Jest's exit.
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  delete g.xai;
  delete g.window;
  delete g.document;
});

describe('providerLabel', () => {
  test('returns the configured label for a known provider id', () => {
    const xaiStub = makeXai();
    const panel = loadPanel(xaiStub);
    expect(panel.providerLabel('claude')).toBe('Claude Code');
    expect(panel.providerLabel('openai')).toBe('OpenAI');
  });

  test('falls back to the raw name when the provider id is unknown', () => {
    const panel = loadPanel(makeXai());
    expect(panel.providerLabel('not-a-real-provider')).toBe('not-a-real-provider');
  });
});

describe('formatDate', () => {
  test('returns an em-dash for null input', () => {
    const panel = loadPanel(makeXai());
    expect(panel.formatDate(null)).toBe('—');
  });

  test('formats a valid ISO string via Date.toLocaleString', () => {
    const panel = loadPanel(makeXai());
    const iso = '2026-04-18T00:00:00Z';
    expect(panel.formatDate(iso)).toBe(new Date(iso).toLocaleString());
  });

  test('returns a non-empty string for unparseable input (Invalid Date)', () => {
    const panel = loadPanel(makeXai());
    // new Date('not-a-date') returns an Invalid Date whose toLocaleString
    // produces 'Invalid Date' rather than throwing — so formatDate does not
    // fall through to its catch branch, but must still return a string.
    expect(typeof panel.formatDate('not-a-date')).toBe('string');
  });
});

describe('escapeHtml', () => {
  test('escapes the five HTML-significant characters', () => {
    const panel = loadPanel(makeXai());
    expect(panel.escapeHtml('<script>"&"</script>')).toBe(
      '&lt;script&gt;&quot;&amp;&quot;&lt;/script&gt;',
    );
  });

  test('returns input unchanged when no escape is needed', () => {
    const panel = loadPanel(makeXai());
    expect(panel.escapeHtml('hello world')).toBe('hello world');
  });
});

describe('loadData', () => {
  test('populates state with service status, providers, and token status on success', async () => {
    const xaiStub = makeXai();
    routeHttp(xaiStub, [
      { match: '/v1/models', data: sampleModels },
      { match: '/admin/token', data: sampleToken },
    ]);
    const panel = loadPanel(xaiStub);

    await panel.loadData();

    expect(panel.state.loading).toBe(false);
    expect(panel.state.error).toBeNull();
    expect(panel.state.status).toEqual({
      running: true,
      port: 4001,
      providerCount: 2,
      modelCount: 2,
    });
    expect(panel.state.providers.map((p) => p.name).sort()).toEqual(['claude', 'openai']);
    expect(panel.state.tokenStatus).toEqual(sampleToken);
    expect(panel.__test.tokenCardProvider).toBe('claude');
  });

  test('clears state and sets an error message when getModels rejects', async () => {
    const xaiStub = makeXai();
    xaiStub.http.mockRejectedValue(new Error('ECONNREFUSED'));
    const panel = loadPanel(xaiStub);

    await panel.loadData();

    expect(panel.state.status).toBeNull();
    expect(panel.state.providers).toEqual([]);
    expect(panel.state.tokenStatus).toBeNull();
    expect(panel.state.error).toBe('ECONNREFUSED');
    expect(panel.state.loading).toBe(false);
  });

  test('clears tokenCardProvider when no CLI subscription provider is present', async () => {
    const xaiStub = makeXai();
    const models: ModelsResponse = {
      object: 'list',
      data: [{ id: 'gpt-4', name: 'GPT-4', owned_by: 'openai' } as Model],
    };
    routeHttp(xaiStub, [{ match: '/v1/models', data: models }]);
    const panel = loadPanel(xaiStub);

    await panel.loadData();

    expect(panel.__test.tokenCardProvider).toBeNull();
    expect(panel.state.tokenStatus).toBeNull();
  });
});

describe('handleDisconnect', () => {
  test('sends a disconnect chat command and schedules a refresh', () => {
    jest.useFakeTimers();
    const xaiStub = makeXai();
    const panel = loadPanel(xaiStub);

    panel.handleDisconnect('claude');

    expect(xaiStub.chat.send).toHaveBeenCalledWith('@cliproxy disconnect claude');
    expect(panel.state.success).toContain('Claude Code');
  });
});

describe('handleUpdateToken', () => {
  test('is a no-op when tokenInputDraft is blank', async () => {
    const xaiStub = makeXai();
    const panel = loadPanel(xaiStub);
    panel.__test.tokenInputDraft = '   ';

    await panel.handleUpdateToken();

    expect(xaiStub.http).not.toHaveBeenCalled();
  });

  test('POSTs the token update and reloads data on success', async () => {
    const xaiStub = makeXai();
    xaiStub.http
      // POST /admin/token update
      .mockResolvedValueOnce({ status: 200, data: { ok: true, expired: '2027-01-01T00:00:00Z' } })
      // subsequent loadData → /v1/models
      .mockResolvedValueOnce({ status: 200, data: sampleModels })
      // subsequent loadData → /admin/token (GET)
      .mockResolvedValueOnce({ status: 200, data: sampleToken });
    const panel = loadPanel(xaiStub);
    panel.__test.tokenCardProvider = 'claude';
    panel.__test.tokenInputDraft = 'sk-new-token';

    await panel.handleUpdateToken();

    expect(xaiStub.http).toHaveBeenCalledWith(
      'http://localhost:4001/admin/token',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(panel.state.error).toBeNull();
    expect(panel.state.success).toContain('Token updated');
    expect(panel.__test.tokenInputDraft).toBe('');
  });

  test('sets state.error when the server returns ok=false', async () => {
    const xaiStub = makeXai();
    xaiStub.http.mockResolvedValueOnce({
      status: 400,
      data: { ok: false, error: 'invalid token' },
    });
    const panel = loadPanel(xaiStub);
    panel.__test.tokenCardProvider = 'claude';
    panel.__test.tokenInputDraft = 'bad';

    await panel.handleUpdateToken();

    expect(panel.state.error).toBe('invalid token');
    expect(panel.state.success).toBeNull();
  });

  test('sets state.error when the HTTP call rejects', async () => {
    const xaiStub = makeXai();
    xaiStub.http.mockRejectedValueOnce(new Error('network down'));
    const panel = loadPanel(xaiStub);
    panel.__test.tokenCardProvider = 'claude';
    panel.__test.tokenInputDraft = 'sk-whatever';

    await panel.handleUpdateToken();

    expect(panel.state.error).toBe('network down');
    expect(panel.state.savingToken).toBe(false);
  });
});

describe('handleConnect', () => {
  test('does nothing when no provider is selected', () => {
    const xaiStub = makeXai();
    const panel = loadPanel(xaiStub);

    panel.handleConnect();

    expect(xaiStub.chat.send).not.toHaveBeenCalled();
    expect(xaiStub.cliproxy.startOAuth).not.toHaveBeenCalled();
  });

  test('sets an error when api-key provider selected without a key', () => {
    const xaiStub = makeXai();
    const panel = loadPanel(xaiStub);
    panel.__test.selectedProviderId = 'openai';
    panel.__test.apiKeyDraft = '   ';

    panel.handleConnect();

    expect(panel.state.error).toBe('Please enter an API key');
    expect(xaiStub.chat.send).not.toHaveBeenCalled();
  });

  test('submits the api key via chat.send when a key is provided', () => {
    jest.useFakeTimers();
    const xaiStub = makeXai();
    const panel = loadPanel(xaiStub);
    panel.__test.selectedProviderId = 'openai';
    panel.__test.apiKeyDraft = 'sk-xyz';

    panel.handleConnect();

    expect(xaiStub.chat.send).toHaveBeenCalledWith(
      '@cliproxy connect openai',
      [[{ text: 'sk-xyz', data: 'api-key:sk-xyz' }]],
    );
    expect(panel.__test.connecting).toBe(true);
  });

  test('routes cli-subscription providers to the OAuth start flow', () => {
    const xaiStub = makeXai();
    // Leave startOAuth unresolved so we only assert that it was invoked.
    xaiStub.cliproxy.startOAuth.mockReturnValue(new Promise(() => { /* never resolves */ }));
    const panel = loadPanel(xaiStub);
    panel.__test.selectedProviderId = 'claude';

    panel.handleConnect();

    expect(xaiStub.cliproxy.startOAuth).toHaveBeenCalledWith('claude');
    expect(panel.__test.oauthConnecting).toBe(true);
  });
});

describe('handleOAuthConnect', () => {
  test('sets an error when another OAuth flow is already in progress', async () => {
    const xaiStub = makeXai();
    xaiStub.cliproxy.startOAuth.mockReturnValue(new Promise(() => { /* keep pending */ }));
    const panel = loadPanel(xaiStub);

    // First call marks oauthConnecting=true and never resolves.
    void panel.handleOAuthConnect('claude', 'Claude Code');
    // Second call should short-circuit with the in-progress error.
    await panel.handleOAuthConnect('claude', 'Claude Code');

    expect(panel.state.error).toBe('Authentication already in progress — cancel it first.');
  });

  test('falls back to chat-based connect when startCliOAuth returns null', async () => {
    const xaiStub = makeXai();
    xaiStub.cliproxy.startOAuth.mockRejectedValue(new Error('backend down'));
    const panel = loadPanel(xaiStub);

    await panel.handleOAuthConnect('claude', 'Claude Code');

    expect(panel.__test.oauthConnecting).toBe(false);
    expect(xaiStub.chat.send).toHaveBeenCalledWith('@cliproxy connect claude');
    expect(panel.state.success).toContain('Check chat');
  });

  test('falls back to chat-based connect when authorize_url is not http(s)', async () => {
    const xaiStub = makeXai();
    xaiStub.cliproxy.startOAuth.mockResolvedValue({
      authorize_url: 'javascript:alert(1)',
      state: 'abc',
      started_at: 't0',
    });
    const panel = loadPanel(xaiStub);

    await panel.handleOAuthConnect('claude', 'Claude Code');

    expect(xaiStub.openUrl).not.toHaveBeenCalled();
    expect(xaiStub.chat.send).toHaveBeenCalledWith('@cliproxy connect claude');
    expect(panel.__test.oauthConnecting).toBe(false);
    expect(panel.__test.oauthState).toBeNull();
  });

  test('opens the browser and stores OAuth session state when the URL is valid', async () => {
    jest.useFakeTimers();
    const xaiStub = makeXai();
    xaiStub.cliproxy.startOAuth.mockResolvedValue({
      authorize_url: 'https://claude.ai/oauth?state=abc',
      state: 'abc',
      started_at: 't0',
    });
    // pollOAuth stays unresolved so we can inspect the session without completing the flow.
    xaiStub.cliproxy.pollOAuth.mockReturnValue(new Promise(() => { /* pending */ }));
    const panel = loadPanel(xaiStub);

    await panel.handleOAuthConnect('claude', 'Claude Code');

    expect(xaiStub.openUrl).toHaveBeenCalledWith('https://claude.ai/oauth?state=abc');
    expect(panel.__test.oauthConnecting).toBe(true);
    expect(panel.__test.oauthAuthUrl).toBe('https://claude.ai/oauth?state=abc');
    expect(panel.__test.oauthState).toBe('abc');
    expect(panel.state.success).toContain('Complete authentication');
  });

  test('completes the OAuth flow when polling resolves with status=ok', async () => {
    jest.useFakeTimers();
    const xaiStub = makeXai();
    xaiStub.cliproxy.startOAuth.mockResolvedValue({
      authorize_url: 'https://claude.ai/oauth?state=abc',
      state: 'abc',
      started_at: 't0',
    });
    xaiStub.cliproxy.pollOAuth.mockResolvedValue({ status: 'ok' });
    // loadData call after successful OAuth returns a models payload with claude.
    routeHttp(xaiStub, [
      { match: '/v1/models', data: sampleModels },
      { match: '/admin/token', data: sampleToken },
    ]);
    const panel = loadPanel(xaiStub);

    await panel.handleOAuthConnect('claude', 'Claude Code');
    // First poll is scheduled with a 3000ms delay.
    jest.advanceTimersByTime(3000);
    // Flush the async setTimeout callback and the loadData it triggers.
    await flushPromises();
    await flushPromises();

    expect(xaiStub.cliproxy.pollOAuth).toHaveBeenCalledWith('abc', 't0', 'claude');
    expect(panel.__test.oauthConnecting).toBe(false);
    expect(panel.__test.oauthState).toBeNull();
    expect(panel.state.success).toContain('connected successfully');
  });

  test('stops the OAuth flow when polling resolves with status=error', async () => {
    jest.useFakeTimers();
    const xaiStub = makeXai();
    xaiStub.cliproxy.startOAuth.mockResolvedValue({
      authorize_url: 'https://claude.ai/oauth?state=abc',
      state: 'abc',
      started_at: 't0',
    });
    xaiStub.cliproxy.pollOAuth.mockResolvedValue({
      status: 'error',
      message: 'user denied',
    });
    const panel = loadPanel(xaiStub);

    await panel.handleOAuthConnect('claude', 'Claude Code');
    jest.advanceTimersByTime(3000);
    await flushPromises();

    expect(panel.__test.oauthConnecting).toBe(false);
    expect(panel.state.error).toBe('user denied');
  });
});

describe('handleCancelOAuth', () => {
  test('resets all OAuth session fields and shows a cancellation banner', async () => {
    jest.useFakeTimers();
    const xaiStub = makeXai();
    xaiStub.cliproxy.startOAuth.mockResolvedValue({
      authorize_url: 'https://claude.ai/oauth?state=abc',
      state: 'abc',
      started_at: 't0',
    });
    xaiStub.cliproxy.pollOAuth.mockReturnValue(new Promise(() => { /* pending */ }));
    const panel = loadPanel(xaiStub);

    await panel.handleOAuthConnect('claude', 'Claude Code');
    expect(panel.__test.oauthConnecting).toBe(true);

    panel.handleCancelOAuth();

    expect(panel.__test.oauthConnecting).toBe(false);
    expect(panel.__test.oauthState).toBeNull();
    expect(panel.__test.oauthAuthUrl).toBeNull();
    expect(panel.state.success).toBe('Authentication cancelled.');
  });
});

describe('PROVIDERS registry', () => {
  test('exposes every provider with a stable id, label, type, and hint', () => {
    const panel = loadPanel(makeXai());
    expect(panel.PROVIDERS.length).toBeGreaterThan(0);
    for (const p of panel.PROVIDERS) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.label).toBe('string');
      expect(['cli-subscription', 'api-key']).toContain(p.type);
      expect(typeof p.hint).toBe('string');
    }
    // Sanity check: Claude is configured as a CLI subscription provider.
    const claude = panel.PROVIDERS.find((p) => p.id === 'claude');
    expect(claude?.type).toBe('cli-subscription');
  });
});
