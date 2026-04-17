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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    // Auth failures or explicit denials — stop polling
    if (msg.includes('Authentication required') || msg.includes('403') || msg.includes('forbidden')) {
      return { status: 'error', message: msg || 'OAuth session expired. Please try again.' };
    }
    // Transient error — return 'wait' to retry
    return { status: 'wait', message: 'Polling — waiting for authentication...' };
  }
}
