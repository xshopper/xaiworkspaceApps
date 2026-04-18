/**
 * Unit tests for api.ts — the CLIProxy HTTP layer.
 *
 * `xai` is a runtime-injected global in the sandbox iframe. These tests stub
 * it on `globalThis` before each test and assert that the API layer handles
 * both success and failure paths correctly.
 */

import {
  getModels,
  deriveStatus,
  groupProviders,
  getTokenStatus,
  updateToken,
  connectProvider,
  disconnectProvider,
  startCliOAuth,
  pollCliOAuth,
} from './api';
import type { ModelsResponse, TokenStatus } from './types';

type XaiStub = {
  http: jest.Mock;
  chat: { send: jest.Mock };
  cliproxy: { startOAuth: jest.Mock; pollOAuth: jest.Mock };
};

function makeXaiStub(): XaiStub {
  return {
    http: jest.fn(),
    chat: { send: jest.fn() },
    cliproxy: { startOAuth: jest.fn(), pollOAuth: jest.fn() },
  };
}

const globalWithXai = globalThis as typeof globalThis & { xai?: XaiStub };

let xaiStub: XaiStub;

beforeEach(() => {
  xaiStub = makeXaiStub();
  globalWithXai.xai = xaiStub;
});

afterEach(() => {
  delete globalWithXai.xai;
});

describe('getModels', () => {
  test('returns ModelsResponse from /v1/models', async () => {
    const response: ModelsResponse = {
      object: 'list',
      data: [{ id: 'claude-opus-4', name: 'Claude Opus', owned_by: 'claude' }],
    };
    xaiStub.http.mockResolvedValue({ status: 200, data: response });

    const result = await getModels();

    expect(result).toEqual(response);
    expect(xaiStub.http).toHaveBeenCalledWith('http://localhost:4001/v1/models');
  });

  test('propagates HTTP errors to the caller', async () => {
    xaiStub.http.mockRejectedValue(new Error('HTTP 500 server error'));

    await expect(getModels()).rejects.toThrow('HTTP 500 server error');
  });
});

describe('deriveStatus', () => {
  test('counts unique providers and total models', () => {
    const models: ModelsResponse = {
      object: 'list',
      data: [
        { id: 'a', name: 'A', owned_by: 'claude' },
        { id: 'b', name: 'B', owned_by: 'claude' },
        { id: 'c', name: 'C', owned_by: 'gemini' },
      ],
    };

    expect(deriveStatus(models)).toEqual({
      running: true,
      port: 4001,
      providerCount: 2,
      modelCount: 3,
    });
  });

  test('treats missing owned_by as a single "unknown" provider', () => {
    const models: ModelsResponse = {
      object: 'list',
      data: [
        { id: 'x', name: 'X' },
        { id: 'y', name: 'Y' },
      ],
    };

    expect(deriveStatus(models).providerCount).toBe(1);
    expect(deriveStatus(models).modelCount).toBe(2);
  });
});

describe('groupProviders', () => {
  test('classifies known CLI providers as cli-subscription', () => {
    const providers = groupProviders([
      { id: 'claude-opus-4', name: 'Opus', owned_by: 'claude' },
      { id: 'gemini-pro', name: 'Gemini', owned_by: 'gemini' },
    ]);

    expect(providers).toHaveLength(2);
    for (const p of providers) {
      expect(p.type).toBe('cli-subscription');
    }
  });

  test('classifies unknown owners as api-key', () => {
    const providers = groupProviders([
      { id: 'gpt-4', name: 'GPT-4', owned_by: 'openai' },
    ]);

    expect(providers[0]).toEqual({
      name: 'openai',
      type: 'api-key',
      models: [{ id: 'gpt-4', name: 'GPT-4', owned_by: 'openai' }],
    });
  });

  test('groups multiple models under the same provider', () => {
    const providers = groupProviders([
      { id: 'c-a', name: 'A', owned_by: 'claude' },
      { id: 'c-b', name: 'B', owned_by: 'claude' },
    ]);

    expect(providers).toHaveLength(1);
    expect(providers[0].models).toHaveLength(2);
  });
});

describe('getTokenStatus', () => {
  const sampleStatus: TokenStatus = {
    type: 'oauth',
    email: 'user@example.com',
    expired: '2027-01-01T00:00:00Z',
    is_expired: false,
    access_token_prefix: 'sk-abc',
    has_refresh_token: true,
    last_refresh: '2026-04-01T00:00:00Z',
  };

  test('returns token status on success', async () => {
    xaiStub.http.mockResolvedValue({ status: 200, data: sampleStatus });

    const result = await getTokenStatus('claude');

    expect(result).toEqual(sampleStatus);
    expect(xaiStub.http).toHaveBeenCalledWith(
      'http://localhost:4001/admin/token?provider=claude',
    );
  });

  test('URL-encodes the provider query parameter', async () => {
    xaiStub.http.mockResolvedValue({ status: 200, data: sampleStatus });

    await getTokenStatus('foo bar/baz');

    expect(xaiStub.http).toHaveBeenCalledWith(
      'http://localhost:4001/admin/token?provider=foo%20bar%2Fbaz',
    );
  });

  test('returns null when the HTTP call rejects (500)', async () => {
    xaiStub.http.mockRejectedValue(new Error('HTTP 500'));

    expect(await getTokenStatus('claude')).toBeNull();
  });

  test('returns null on auth failure (401) so UI can trigger OAuth', async () => {
    xaiStub.http.mockRejectedValue(new Error('HTTP 401 Authentication required'));

    expect(await getTokenStatus('claude')).toBeNull();
  });
});

describe('updateToken', () => {
  test('POSTs JSON body with provider + access_token', async () => {
    xaiStub.http.mockResolvedValue({
      status: 200,
      data: { ok: true, expired: '2027-01-01T00:00:00Z' },
    });

    const result = await updateToken('claude', 'sk-new-token');

    expect(result).toEqual({ ok: true, expired: '2027-01-01T00:00:00Z' });
    expect(xaiStub.http).toHaveBeenCalledWith('http://localhost:4001/admin/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'claude', access_token: 'sk-new-token' }),
    });
  });

  test('forwards server-reported failure payload to the caller', async () => {
    xaiStub.http.mockResolvedValue({
      status: 400,
      data: { ok: false, error: 'invalid token' },
    });

    expect(await updateToken('claude', 'bad')).toEqual({
      ok: false,
      error: 'invalid token',
    });
  });
});

describe('connectProvider', () => {
  test('sends a bare chat command when no apiKey is provided', () => {
    connectProvider('claude');

    expect(xaiStub.chat.send).toHaveBeenCalledTimes(1);
    expect(xaiStub.chat.send).toHaveBeenCalledWith('@cliproxy connect claude');
  });

  test('attaches an api-key button when apiKey is provided', () => {
    connectProvider('openai', 'sk-test-123');

    expect(xaiStub.chat.send).toHaveBeenCalledWith(
      '@cliproxy connect openai',
      [[{ text: 'sk-test-123', data: 'api-key:sk-test-123' }]],
    );
  });
});

describe('disconnectProvider', () => {
  test('sends a disconnect chat command', () => {
    disconnectProvider('claude');

    expect(xaiStub.chat.send).toHaveBeenCalledWith('@cliproxy disconnect claude');
  });
});

describe('startCliOAuth', () => {
  test('returns OAuth session details on success', async () => {
    const session = {
      authorize_url: 'https://claude.ai/oauth?state=abc',
      state: 'abc',
      started_at: '2026-04-18T00:00:00Z',
    };
    xaiStub.cliproxy.startOAuth.mockResolvedValue(session);

    expect(await startCliOAuth('claude')).toEqual(session);
    expect(xaiStub.cliproxy.startOAuth).toHaveBeenCalledWith('claude');
  });

  test('returns null when the backend throws', async () => {
    xaiStub.cliproxy.startOAuth.mockRejectedValue(new Error('backend unreachable'));

    expect(await startCliOAuth('claude')).toBeNull();
  });
});

describe('pollCliOAuth', () => {
  test('passes through a successful poll response verbatim', async () => {
    xaiStub.cliproxy.pollOAuth.mockResolvedValue({
      status: 'success',
      message: 'connected',
    });

    expect(await pollCliOAuth('state-1', 't0', 'claude')).toEqual({
      status: 'success',
      message: 'connected',
    });
    expect(xaiStub.cliproxy.pollOAuth).toHaveBeenCalledWith(
      'state-1',
      't0',
      'claude',
    );
  });

  test('stops polling with status=error on "Authentication required"', async () => {
    xaiStub.cliproxy.pollOAuth.mockRejectedValue(
      new Error('Authentication required'),
    );

    expect(await pollCliOAuth('s', 't', 'claude')).toEqual({
      status: 'error',
      message: 'Authentication required',
    });
  });

  test('stops polling with status=error on HTTP 403', async () => {
    xaiStub.cliproxy.pollOAuth.mockRejectedValue(new Error('HTTP 403 denied'));

    const result = await pollCliOAuth('s', 't', 'claude');

    expect(result.status).toBe('error');
    expect(result.message).toContain('403');
  });

  test('stops polling with status=error when message contains "forbidden"', async () => {
    xaiStub.cliproxy.pollOAuth.mockRejectedValue(new Error('access forbidden'));

    expect((await pollCliOAuth('s', 't', 'claude')).status).toBe('error');
  });

  test('returns status=wait on transient errors so the UI keeps retrying', async () => {
    xaiStub.cliproxy.pollOAuth.mockRejectedValue(new Error('network timeout'));

    const result = await pollCliOAuth('s', 't', 'claude');

    expect(result.status).toBe('wait');
    expect(result.message).toMatch(/waiting/i);
  });

  test('returns status=wait when the thrown value is not an Error instance', async () => {
    xaiStub.cliproxy.pollOAuth.mockRejectedValue('non-error rejection');

    const result = await pollCliOAuth('s', 't', 'claude');

    expect(result.status).toBe('wait');
  });

  test('eventually resolves to success after a sequence of transient failures', async () => {
    xaiStub.cliproxy.pollOAuth
      .mockRejectedValueOnce(new Error('network blip'))
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce({ status: 'success', message: 'done' });

    expect((await pollCliOAuth('s', 't', 'claude')).status).toBe('wait');
    expect((await pollCliOAuth('s', 't', 'claude')).status).toBe('wait');
    expect(await pollCliOAuth('s', 't', 'claude')).toEqual({
      status: 'success',
      message: 'done',
    });
    expect(xaiStub.cliproxy.pollOAuth).toHaveBeenCalledTimes(3);
  });
});
