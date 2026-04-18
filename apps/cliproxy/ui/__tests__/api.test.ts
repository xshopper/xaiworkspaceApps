/// <reference path="../xai.d.ts" />
import {
  connectProvider,
  deriveStatus,
  disconnectProvider,
  getModels,
  getTokenStatus,
  groupProviders,
  pollCliOAuth,
  startCliOAuth,
  updateToken,
} from '../api';
import type { Model, ModelsResponse } from '../types';

type HttpCall = {
  url: string;
  options: { method?: string; headers?: Record<string, string>; body?: string } | undefined;
};
type ChatCall = {
  text: string;
  buttons: Array<Array<{ text: string; data: string }>> | undefined;
};

interface XaiMock {
  http: jest.Mock;
  chat: { send: jest.Mock };
  cliproxy: { startOAuth: jest.Mock; pollOAuth: jest.Mock };
  httpCalls: HttpCall[];
  chatCalls: ChatCall[];
}

function installXaiMock(): XaiMock {
  const httpCalls: HttpCall[] = [];
  const chatCalls: ChatCall[] = [];

  const http = jest.fn((url: string, options?: HttpCall['options']) => {
    httpCalls.push({ url, options });
    return Promise.resolve({ status: 200, data: http.mockResponse });
  }) as jest.Mock & { mockResponse: unknown };
  http.mockResponse = {};

  const send = jest.fn((text: string, buttons?: ChatCall['buttons']) => {
    chatCalls.push({ text, buttons });
  });

  const startOAuth = jest.fn();
  const pollOAuth = jest.fn();

  const mock: XaiMock = {
    http,
    chat: { send },
    cliproxy: { startOAuth, pollOAuth },
    httpCalls,
    chatCalls,
  };
  (globalThis as unknown as { xai: unknown }).xai = mock;
  return mock;
}

function clearXaiMock() {
  delete (globalThis as unknown as { xai?: unknown }).xai;
}

describe('deriveStatus', () => {
  it('counts unique providers from owned_by and reports model count', () => {
    const models: ModelsResponse = {
      object: 'list',
      data: [
        { id: 'a', name: 'a', owned_by: 'claude' },
        { id: 'b', name: 'b', owned_by: 'claude' },
        { id: 'c', name: 'c', owned_by: 'openai' },
      ],
    };
    expect(deriveStatus(models)).toEqual({
      running: true,
      port: 4001,
      providerCount: 2,
      modelCount: 3,
    });
  });

  it('buckets missing owned_by under "unknown"', () => {
    const models: ModelsResponse = {
      object: 'list',
      data: [
        { id: 'a', name: 'a' },
        { id: 'b', name: 'b' },
        { id: 'c', name: 'c', owned_by: 'claude' },
      ],
    };
    expect(deriveStatus(models).providerCount).toBe(2);
  });

  it('handles empty model list', () => {
    expect(deriveStatus({ object: 'list', data: [] })).toEqual({
      running: true,
      port: 4001,
      providerCount: 0,
      modelCount: 0,
    });
  });
});

describe('groupProviders', () => {
  it('marks known CLI owners as cli-subscription, others as api-key', () => {
    const models: Model[] = [
      { id: 'claude-3', name: 'Claude 3', owned_by: 'claude' },
      { id: 'gpt-4', name: 'GPT-4', owned_by: 'openai' },
      { id: 'gemini-pro', name: 'Gemini Pro', owned_by: 'gemini' },
    ];
    const grouped = groupProviders(models);
    const byName = Object.fromEntries(grouped.map((p) => [p.name, p]));
    expect(byName['claude'].type).toBe('cli-subscription');
    expect(byName['gemini'].type).toBe('cli-subscription');
    expect(byName['openai'].type).toBe('api-key');
  });

  it('groups multiple models under the same provider', () => {
    const models: Model[] = [
      { id: 'claude-3-opus', name: 'Opus', owned_by: 'claude' },
      { id: 'claude-3-sonnet', name: 'Sonnet', owned_by: 'claude' },
      { id: 'gpt-4', name: 'GPT-4', owned_by: 'openai' },
    ];
    const grouped = groupProviders(models);
    const claude = grouped.find((p) => p.name === 'claude')!;
    expect(claude.models).toHaveLength(2);
    expect(claude.models.map((m) => m.id).sort()).toEqual(['claude-3-opus', 'claude-3-sonnet']);
  });

  it('labels missing owned_by as "unknown"', () => {
    const grouped = groupProviders([{ id: 'orphan', name: 'Orphan' }]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].name).toBe('unknown');
    expect(grouped[0].type).toBe('api-key');
  });
});

describe('connectProvider (chat command)', () => {
  let mock: XaiMock;
  beforeEach(() => { mock = installXaiMock(); });
  afterEach(() => { clearXaiMock(); });

  it('sends a bare connect command for OAuth flows', () => {
    connectProvider('claude');
    expect(mock.chatCalls).toEqual([{ text: '@cliproxy connect claude', buttons: undefined }]);
  });

  it('sends the key as a button payload for API-key flows', () => {
    connectProvider('openai', 'sk-test-123');
    expect(mock.chatCalls).toHaveLength(1);
    expect(mock.chatCalls[0].text).toBe('@cliproxy connect openai');
    expect(mock.chatCalls[0].buttons).toEqual([[{ text: 'sk-test-123', data: 'api-key:sk-test-123' }]]);
  });
});

describe('disconnectProvider (chat command)', () => {
  let mock: XaiMock;
  beforeEach(() => { mock = installXaiMock(); });
  afterEach(() => { clearXaiMock(); });

  it('sends a disconnect command with the provider name', () => {
    disconnectProvider('claude');
    expect(mock.chatCalls).toEqual([{ text: '@cliproxy disconnect claude', buttons: undefined }]);
  });
});

describe('getModels / getTokenStatus / updateToken', () => {
  let mock: XaiMock;
  beforeEach(() => { mock = installXaiMock(); });
  afterEach(() => { clearXaiMock(); });

  it('getModels fetches /v1/models', async () => {
    const response: ModelsResponse = { object: 'list', data: [] };
    (mock.http as unknown as { mockResponse: unknown }).mockResponse = response;
    const result = await getModels();
    expect(result).toEqual(response);
    expect(mock.httpCalls[0].url).toBe('http://localhost:4001/v1/models');
  });

  it('getTokenStatus encodes the provider name and returns null on failure', async () => {
    mock.http.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    const result = await getTokenStatus('claude');
    expect(result).toBeNull();

    mock.http.mockImplementationOnce((url: string) => {
      expect(url).toBe('http://localhost:4001/admin/token?provider=claude%2Fxyz');
      return Promise.resolve({ status: 200, data: null });
    });
    await getTokenStatus('claude/xyz');
  });

  it('updateToken posts JSON body', async () => {
    (mock.http as unknown as { mockResponse: unknown }).mockResponse = { ok: true };
    const result = await updateToken('claude', 'token-xyz');
    expect(result).toEqual({ ok: true });
    const call = mock.httpCalls[0];
    expect(call.url).toBe('http://localhost:4001/admin/token');
    expect(call.options?.method).toBe('POST');
    expect(call.options?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(call.options!.body!)).toEqual({ provider: 'claude', access_token: 'token-xyz' });
  });
});

describe('startCliOAuth', () => {
  let mock: XaiMock;
  beforeEach(() => { mock = installXaiMock(); });
  afterEach(() => { clearXaiMock(); });

  it('returns the platform response on success', async () => {
    mock.cliproxy.startOAuth.mockResolvedValueOnce({
      authorize_url: 'https://auth.example.com',
      state: 's1',
      started_at: '2025-01-01T00:00:00Z',
    });
    const result = await startCliOAuth('claude');
    expect(result).toEqual({
      authorize_url: 'https://auth.example.com',
      state: 's1',
      started_at: '2025-01-01T00:00:00Z',
    });
    expect(mock.cliproxy.startOAuth).toHaveBeenCalledWith('claude');
  });

  it('returns null when the platform throws', async () => {
    mock.cliproxy.startOAuth.mockRejectedValueOnce(new Error('offline'));
    expect(await startCliOAuth('claude')).toBeNull();
  });
});

describe('pollCliOAuth error classification', () => {
  let mock: XaiMock;
  beforeEach(() => { mock = installXaiMock(); });
  afterEach(() => { clearXaiMock(); });

  it('passes through a successful platform response', async () => {
    mock.cliproxy.pollOAuth.mockResolvedValueOnce({ status: 'ok' });
    expect(await pollCliOAuth('s1', 't0', 'claude')).toEqual({ status: 'ok' });
    expect(mock.cliproxy.pollOAuth).toHaveBeenCalledWith('s1', 't0', 'claude');
  });

  it.each([
    ['Authentication required'],
    ['403 forbidden'],
    ['session forbidden'],
  ])('maps "%s" to a terminal error so polling stops', async (message) => {
    mock.cliproxy.pollOAuth.mockRejectedValueOnce(new Error(message));
    const result = await pollCliOAuth('s1', 't0', 'claude');
    expect(result.status).toBe('error');
    expect(result.message).toBe(message);
  });

  it('maps transient errors to a retryable wait', async () => {
    mock.cliproxy.pollOAuth.mockRejectedValueOnce(new Error('network reset'));
    const result = await pollCliOAuth('s1', 't0', 'claude');
    expect(result.status).toBe('wait');
    expect(result.message).toMatch(/waiting/i);
  });

  it('maps non-Error throwables to a retryable wait', async () => {
    mock.cliproxy.pollOAuth.mockRejectedValueOnce('timeout');
    const result = await pollCliOAuth('s1', 't0', 'claude');
    expect(result.status).toBe('wait');
  });
});
