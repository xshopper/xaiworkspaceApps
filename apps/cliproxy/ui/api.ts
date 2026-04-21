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
    // Auth header is injected automatically by the backend proxy
    const res = await xai.http<TokenStatus>(`${BASE}/admin/token?provider=${encodeURIComponent(provider)}`);
    return res.data;
  } catch {
    return null;
  }
}

/** Update token for a provider */
export async function updateToken(provider: string, accessToken: string): Promise<{ ok: boolean; expired?: string; error?: string }> {
  // Auth header is injected automatically by the backend proxy
  const res = await xai.http<{ ok: boolean; expired?: string; error?: string }>(`${BASE}/admin/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, access_token: accessToken }),
  });
  return res.data;
}

/** Disconnect a provider via chat command (no direct API) */
export function disconnectProvider(name: string): void {
  xai.chat.send(`@cliproxy disconnect ${name}`);
}

/**
 * Connect an API-key provider by setting the key directly via the admin
 * endpoint (same as `updateToken`).  Returns the endpoint response so the
 * caller can report success/failure.  The raw key never travels through a
 * chat message.
 */
export async function connectApiKeyProvider(
  providerId: string,
  apiKey: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await xai.http<{ ok: boolean; error?: string }>(
    `${BASE}/admin/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: providerId, access_token: apiKey }),
    },
  );
  return res.data;
}

/** Start a CLI-subscription or legacy connect flow via chat command */
export function connectProviderChat(providerId: string): void {
  xai.chat.send(`@cliproxy connect ${providerId}`);
}

// ── CLIProxy OAuth (via router backend) ──────────────────────────────────

/**
 * Start OAuth flow via the router backend.
 * The backend proxies to the user's EC2 CLIProxyAPI and handles callback routing.
 */
export async function startCliOAuth(provider: string): Promise<{ authorize_url: string; state: string; started_at: string } | null> {
  try {
    return await xai.cliproxy.startOAuth(provider);
  } catch {
    return null;
  }
}

/** Poll OAuth status via the router backend */
export async function pollCliOAuth(state: string, started_at: string, provider: string): Promise<{ status: string; message?: string }> {
  try {
    return await xai.cliproxy.pollOAuth(state, started_at, provider);
  } catch (err: any) {
    const msg = err?.message || '';
    // Auth failures or explicit denials — stop polling
    if (msg.includes('Authentication required') || msg.includes('403') || msg.includes('forbidden')) {
      return { status: 'error', message: msg || 'OAuth session expired. Please try again.' };
    }
    // Transient error — return 'wait' to retry
    return { status: 'wait', message: 'Polling — waiting for authentication...' };
  }
}

/**
 * Parse a pasted OAuth redirect URL and submit the extracted `code`+`state`
 * to the router backend, which forwards to the user's workspace CLIProxyAPI.
 * Accepts either a full URL (`http://localhost:54545/callback?code=X&state=Y`)
 * or bare `code#state` / `code` values.
 */
export async function submitOAuthPaste(
  pasted: string,
  expectedState: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const trimmed = (pasted || '').trim();
  if (!trimmed) return { ok: false, error: 'Paste the redirect URL or code' };

  let code = '';
  let state = '';

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      code = (u.searchParams.get('code') || '').split('#')[0].trim();
      state = (u.searchParams.get('state') || '').trim();
      const err = u.searchParams.get('error');
      if (err) return { ok: false, error: u.searchParams.get('error_description') || err };
    } catch {
      return { ok: false, error: 'Invalid URL' };
    }
  } else if (trimmed.includes('=')) {
    // Raw query string fragment e.g. "code=X&state=Y"
    const qs = new URLSearchParams(trimmed.replace(/^\?/, ''));
    code = (qs.get('code') || '').split('#')[0].trim();
    state = (qs.get('state') || '').trim();
  } else {
    code = trimmed.split('#')[0].trim();
  }

  if (!state) state = (expectedState || '').trim();
  if (!code) return { ok: false, error: 'Could not find code in paste' };
  if (!state) return { ok: false, error: 'Could not find state in paste' };
  if (expectedState && state !== expectedState) {
    return { ok: false, error: 'State mismatch — paste may be from a different login attempt' };
  }

  try {
    const result = await xai.cliproxy.submitCallback(state, code);
    if (result?.ok) return { ok: true };
    return { ok: false, error: result?.error ?? 'Callback submission failed' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Callback submission failed' };
  }
}
