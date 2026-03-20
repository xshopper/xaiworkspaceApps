import type { ModelsResponse, TokenStatus, Provider, ServiceStatus, Model } from './types';

const BASE = 'http://localhost:4001';

/** Known CLI subscription provider prefixes in model owned_by / id */
const CLI_PROVIDERS = new Set(['claude', 'gemini', 'codex', 'qwen', 'iflow']);

/** Fetch available models from CLIProxyAPI */
export async function getModels(): Promise<ModelsResponse> {
  const res = await xai.http<ModelsResponse>(`${BASE}/v1/models`);
  return res.data;
}

/** Derive service status from a models response */
export function deriveStatus(models: ModelsResponse): ServiceStatus {
  const providerNames = new Set(models.data.map(m => m.owned_by ?? 'unknown'));
  return {
    running: true,
    port: 4001,
    providerCount: providerNames.size,
    modelCount: models.data.length,
  };
}

/** Group models into providers */
export function groupProviders(models: Model[]): Provider[] {
  const groups = new Map<string, Model[]>();
  for (const m of models) {
    const owner = m.owned_by ?? 'unknown';
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner)!.push(m);
  }
  return Array.from(groups.entries()).map(([name, provModels]) => ({
    name,
    type: CLI_PROVIDERS.has(name) ? 'cli-subscription' as const : 'api-key' as const,
    models: provModels,
  }));
}

/** Get token status for a CLI subscription (e.g. Claude) */
export async function getTokenStatus(provider: string): Promise<TokenStatus | null> {
  try {
    const res = await xai.http<TokenStatus>(`${BASE}/admin/token?provider=${encodeURIComponent(provider)}`, {
      headers: { Authorization: 'Bearer local-only' },
    });
    return res.data;
  } catch {
    return null;
  }
}

/** Update token for a provider */
export async function updateToken(provider: string, accessToken: string): Promise<{ ok: boolean; expired?: string; error?: string }> {
  const res = await xai.http<{ ok: boolean; expired?: string; error?: string }>(`${BASE}/admin/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local-only' },
    body: JSON.stringify({ provider, access_token: accessToken }),
  });
  return res.data;
}

/** Disconnect a provider via chat command (no direct API) */
export function disconnectProvider(name: string): void {
  xai.chat.send(`@cliproxy disconnect ${name}`);
}

/** Connect a provider via chat command */
export function connectProvider(providerId: string, apiKey?: string): void {
  if (apiKey) {
    xai.chat.send(`@cliproxy connect ${providerId}`, [
      [{ text: apiKey, data: `api-key:${apiKey}` }],
    ]);
  } else {
    xai.chat.send(`@cliproxy connect ${providerId}`);
  }
}

// ── CLIProxyAPI OAuth (device-code flow) ────────────────────────────────

/**
 * Start OAuth device-code flow via CLIProxyAPI's built-in endpoint.
 *
 * CLIProxyAPI exposes provider-specific auth-url endpoints matching the
 * `cli-proxy-api auth add {provider}` CLI commands. The endpoint naming
 * convention is `/{provider}-auth-url` (e.g. `/anthropic-auth-url` for
 * Claude, `/codex-auth-url` for OpenAI Codex).
 *
 * If the provider-specific endpoint returns 404, falls back to a generic
 * `/auth-url?provider={name}` endpoint (supported in newer CLIProxyAPI versions).
 * If both fail, the caller falls back to the chat command.
 */
const CLI_AUTH_ENDPOINTS: Record<string, string> = {
  claude: '/anthropic-auth-url',
  codex: '/codex-auth-url',
  gemini: '/gemini-auth-url',
  qwen: '/qwen-auth-url',
  iflow: '/iflow-auth-url',
};

export async function startCliOAuth(provider: string): Promise<{ url: string; state: string } | null> {
  // Try provider-specific endpoint first
  const endpoint = CLI_AUTH_ENDPOINTS[provider];
  if (endpoint) {
    try {
      const res = await xai.http<{ url: string; state: string }>(`${BASE}${endpoint}`, {
        headers: { Authorization: 'Bearer local-only' },
      });
      if (res.data?.url) return res.data;
    } catch {
      // endpoint not available — try generic fallback
    }
  }

  // Generic fallback for newer CLIProxyAPI versions or unknown providers
  try {
    const res = await xai.http<{ url: string; state: string }>(
      `${BASE}/auth-url?provider=${encodeURIComponent(provider)}`, {
        headers: { Authorization: 'Bearer local-only' },
      });
    if (res.data?.url) return res.data;
  } catch {
    // neither endpoint available
  }

  return null;
}

/** Poll CLIProxyAPI for OAuth completion */
export async function pollCliOAuth(state: string): Promise<{ status: string; message?: string }> {
  try {
    const res = await xai.http<{ status: string; message?: string }>(
      `${BASE}/get-auth-status?state=${encodeURIComponent(state)}`, {
        headers: { Authorization: 'Bearer local-only' },
      });
    return res.data;
  } catch (err: any) {
    // 4xx = session expired or invalid state — stop polling
    const status = err?.status ?? err?.response?.status;
    if (status && status >= 400 && status < 500) {
      return { status: 'error', message: 'OAuth session expired. Please try again.' };
    }
    // Transient network/5xx error — return 'wait' to retry
    return { status: 'wait', message: 'Polling — waiting for authentication...' };
  }
}
