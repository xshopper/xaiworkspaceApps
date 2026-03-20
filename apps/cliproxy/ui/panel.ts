import type { PanelState, ProviderDef } from './types';
import { getModels, deriveStatus, groupProviders, getTokenStatus, updateToken, disconnectProvider, connectProvider } from './api';

// ---------------------------------------------------------------------------
// Provider definitions for the connect form
// ---------------------------------------------------------------------------

const PROVIDERS: ProviderDef[] = [
  { id: 'claude',      label: 'Claude (CLI)',    type: 'cli-subscription', hint: 'Browser OAuth — no API key needed' },
  { id: 'gemini',      label: 'Gemini (CLI)',    type: 'cli-subscription', hint: 'Browser OAuth — no API key needed' },
  { id: 'codex',       label: 'Codex (CLI)',     type: 'cli-subscription', hint: 'Browser OAuth — no API key needed' },
  { id: 'qwen',        label: 'Qwen (CLI)',      type: 'cli-subscription', hint: 'Browser OAuth — no API key needed' },
  { id: 'zai',         label: 'Z.ai / Zhipu',    type: 'api-key',          hint: 'Get key at z.ai' },
  { id: 'grok',        label: 'xAI Grok',        type: 'api-key',          hint: 'Get key at console.x.ai' },
  { id: 'openai',      label: 'OpenAI',          type: 'api-key',          hint: 'Get key at platform.openai.com' },
  { id: 'anthropic',   label: 'Anthropic',       type: 'api-key',          hint: 'Get key at console.anthropic.com' },
  { id: 'gemini-api',  label: 'Gemini API',      type: 'api-key',          hint: 'Get key at aistudio.google.com' },
  { id: 'groq',        label: 'Groq',            type: 'api-key',          hint: 'Get key at console.groq.com' },
  { id: 'mistral',     label: 'Mistral',         type: 'api-key',          hint: 'Get key at console.mistral.ai' },
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state: PanelState = {
  loading: false,
  error: null,
  success: null,
  status: null,
  providers: [],
  tokenStatus: null,
  savingToken: false,
};

let successTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function showSuccess(msg: string) {
  state.success = msg;
  if (successTimer) clearTimeout(successTimer);
  successTimer = setTimeout(() => { state.success = null; render(); }, 6000);
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadData() {
  state.loading = true;
  state.error = null;
  render();

  try {
    const models = await getModels();
    state.status = deriveStatus(models);
    state.providers = groupProviders(models.data);

    // Try to get Claude token status (primary CLI subscription)
    const claudeProvider = state.providers.find(p => p.name === 'claude');
    if (claudeProvider) {
      state.tokenStatus = await getTokenStatus('claude');
    } else {
      state.tokenStatus = null;
    }
  } catch (err: any) {
    state.status = { running: false, port: 4001, providerCount: 0, modelCount: 0 };
    state.providers = [];
    state.tokenStatus = null;
    state.error = err?.message ?? 'Could not reach CLIProxyAPI on localhost:4001';
  } finally {
    state.loading = false;
    render();
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function handleUpdateToken() {
  const input = document.getElementById('token-input') as HTMLInputElement | null;
  if (!input) return;
  const token = input.value.trim();
  if (!token || !token.startsWith('sk-ant-')) return;

  state.savingToken = true;
  render();

  try {
    const result = await updateToken('claude', token);
    if (result.ok) {
      showSuccess(`Token updated. Expires: ${formatDate(result.expired ?? null)}`);
      input.value = '';
      await loadData(); // refresh status
    } else {
      state.error = result.error ?? 'Token update failed';
    }
  } catch (err: any) {
    state.error = err?.message ?? 'Token update failed';
  } finally {
    state.savingToken = false;
    render();
  }
}

function handleDisconnect(providerName: string) {
  disconnectProvider(providerName);
  showSuccess(`Disconnecting ${providerName}... Check chat for status.`);
}

function handleConnect() {
  const select = document.getElementById('provider-select') as HTMLSelectElement | null;
  const keyInput = document.getElementById('api-key-input') as HTMLInputElement | null;
  if (!select) return;

  const providerId = select.value;
  if (!providerId) return;

  const def = PROVIDERS.find(p => p.id === providerId);
  if (!def) return;

  if (def.type === 'api-key') {
    const key = keyInput?.value.trim();
    if (!key) { state.error = 'Please enter an API key'; render(); return; }
    connectProvider(providerId, key);
  } else {
    connectProvider(providerId);
  }

  showSuccess(`Connecting ${def.label}... Check chat for auth instructions.`);
  if (keyInput) keyInput.value = '';
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  const html = `
    <style>${CSS}</style>
    <div class="panel">
      <div class="panel-header">
        <h1 class="panel-title">CLI Proxy</h1>
        <button class="btn btn-secondary" onclick="__refresh()" ${state.loading ? 'disabled' : ''}>
          ${state.loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      ${state.error ? `<div class="banner banner-error">${escapeHtml(state.error)}</div>` : ''}
      ${state.success ? `<div class="banner banner-success">${escapeHtml(state.success)}</div>` : ''}

      <!-- Status Card -->
      <div class="card">
        <h2 class="section-heading">Service Status</h2>
        ${state.status ? `
          <div class="config-grid">
            <div class="config-row">
              <span class="config-label">Status</span>
              <span class="badge ${state.status.running ? 'badge-active' : 'badge-expired'}">
                ${state.status.running ? 'Running' : 'Stopped'}
              </span>
            </div>
            <div class="config-row">
              <span class="config-label">Port</span>
              <span class="config-value">${state.status.port}</span>
            </div>
            <div class="config-row">
              <span class="config-label">Providers</span>
              <span class="config-value">${state.status.providerCount}</span>
            </div>
            <div class="config-row">
              <span class="config-label">Models</span>
              <span class="config-value">${state.status.modelCount}</span>
            </div>
          </div>
        ` : `
          <p class="empty-text">
            ${state.loading ? 'Checking service...' : 'CLIProxyAPI not reachable. Use <code>@cliproxy status</code> in chat to install and start.'}
          </p>
        `}
      </div>

      <!-- Token Management (shown if Claude provider connected) -->
      ${state.tokenStatus ? `
      <div class="card">
        <h2 class="section-heading">Claude OAuth Token</h2>
        <div class="config-grid">
          <div class="config-row">
            <span class="config-label">Status</span>
            <span class="badge ${state.tokenStatus.is_expired ? 'badge-expired' : 'badge-active'}">
              ${state.tokenStatus.is_expired ? 'Expired' : 'Active'}
            </span>
          </div>
          ${state.tokenStatus.type ? `
          <div class="config-row">
            <span class="config-label">Type</span>
            <span class="config-value">${escapeHtml(state.tokenStatus.type)}</span>
          </div>` : ''}
          ${state.tokenStatus.email ? `
          <div class="config-row">
            <span class="config-label">Email</span>
            <span class="config-value">${escapeHtml(state.tokenStatus.email)}</span>
          </div>` : ''}
          ${state.tokenStatus.access_token_prefix ? `
          <div class="config-row">
            <span class="config-label">Access Token</span>
            <span class="config-value mono">${escapeHtml(state.tokenStatus.access_token_prefix)}...</span>
          </div>` : ''}
          <div class="config-row">
            <span class="config-label">Expires</span>
            <span class="config-value ${state.tokenStatus.is_expired ? 'text-danger' : ''}">${formatDate(state.tokenStatus.expired)}</span>
          </div>
          ${state.tokenStatus.last_refresh ? `
          <div class="config-row">
            <span class="config-label">Last Refresh</span>
            <span class="config-value">${formatDate(state.tokenStatus.last_refresh)}</span>
          </div>` : ''}
          <div class="config-row">
            <span class="config-label">Refresh Token</span>
            <span class="config-value">${state.tokenStatus.has_refresh_token ? 'Present' : 'None'}</span>
          </div>
        </div>

        <div class="form-card">
          <p class="form-hint">Paste a new Claude access token to update:</p>
          <div class="form-row">
            <input type="text" id="token-input" class="form-input mono" placeholder="sk-ant-oat01-..." />
            <button class="btn btn-primary" onclick="__updateToken()" ${state.savingToken ? 'disabled' : ''}>
              ${state.savingToken ? 'Updating...' : 'Update'}
            </button>
          </div>
        </div>
      </div>
      ` : ''}

      <!-- Provider List -->
      <div class="card">
        <h2 class="section-heading">Connected Providers</h2>
        ${state.providers.length > 0 ? state.providers.map(p => `
          <div class="provider-card">
            <div class="provider-header">
              <span class="provider-name">${escapeHtml(p.name)}</span>
              <span class="provider-type badge ${p.type === 'cli-subscription' ? 'badge-cli' : 'badge-api'}">${p.type === 'cli-subscription' ? 'CLI' : 'API'}</span>
              <button class="btn btn-danger btn-sm" onclick="__disconnect('${escapeAttr(p.name)}')">Disconnect</button>
            </div>
            <div class="model-list">
              ${p.models.map(m => `<span class="model-tag">${escapeHtml(m.id)}</span>`).join('')}
            </div>
          </div>
        `).join('') : `
          <p class="empty-text">No providers connected. Use the form below or type <code>@cliproxy connect claude</code> in chat.</p>
        `}
      </div>

      <!-- Connect Form -->
      <div class="card">
        <h2 class="section-heading">Connect Provider</h2>
        <div class="form-row">
          <select id="provider-select" class="form-input" onchange="__onProviderChange()">
            <option value="">Select a provider...</option>
            ${PROVIDERS.map(p => `<option value="${p.id}">${escapeHtml(p.label)}</option>`).join('')}
          </select>
        </div>
        <div id="provider-hint" class="form-hint" style="display:none"></div>
        <div id="api-key-row" class="form-row" style="display:none">
          <input type="text" id="api-key-input" class="form-input mono" placeholder="Paste your API key..." />
        </div>
        <div class="form-row">
          <button class="btn btn-primary" onclick="__connect()">Connect</button>
        </div>
      </div>
    </div>
  `;

  xai.render(html);

  // Re-attach global handlers after render (xai.render replaces innerHTML)
  (window as any).__refresh = loadData;
  (window as any).__updateToken = handleUpdateToken;
  (window as any).__disconnect = handleDisconnect;
  (window as any).__connect = handleConnect;
  (window as any).__onProviderChange = onProviderChange;
}

function onProviderChange() {
  const select = document.getElementById('provider-select') as HTMLSelectElement | null;
  const hintEl = document.getElementById('provider-hint');
  const keyRow = document.getElementById('api-key-row');
  if (!select || !hintEl || !keyRow) return;

  const def = PROVIDERS.find(p => p.id === select.value);
  if (def) {
    hintEl.textContent = def.hint;
    hintEl.style.display = 'block';
    keyRow.style.display = def.type === 'api-key' ? 'flex' : 'none';
  } else {
    hintEl.style.display = 'none';
    keyRow.style.display = 'none';
  }
}

// ---------------------------------------------------------------------------
// Escape helpers
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(str: string): string {
  return str.replace(/'/g, "\\'").replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// Styles (platform CSS variables)
// ---------------------------------------------------------------------------

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    background: var(--surface-base, #0a0a0a);
    color: var(--fg-primary, #e5e5e5);
    font-size: 13px;
    line-height: 1.5;
  }

  .panel { padding: 16px; max-width: 480px; }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }

  .panel-title {
    font-size: 18px;
    font-weight: 600;
    color: var(--fg-primary, #e5e5e5);
  }

  .section-heading {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--fg-tertiary, #888);
    margin-bottom: 10px;
  }

  .card {
    background: var(--surface-l1, #141414);
    border: 1px solid var(--border-l1, #262626);
    border-radius: var(--radius-md, 8px);
    padding: 14px;
    margin-bottom: 12px;
  }

  .config-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px 12px;
  }

  .config-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 0;
  }

  .config-label {
    color: var(--fg-secondary, #aaa);
    font-size: 12px;
  }

  .config-value {
    color: var(--fg-primary, #e5e5e5);
    font-size: 12px;
  }

  .mono {
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 11px;
  }

  .text-danger { color: var(--fg-danger, #ef4444); }

  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: var(--radius-full, 9999px);
    font-size: 11px;
    font-weight: 500;
  }

  .badge-active { background: rgba(34,197,94,0.15); color: #22c55e; }
  .badge-expired { background: rgba(239,68,68,0.15); color: #ef4444; }
  .badge-cli { background: rgba(99,102,241,0.15); color: #818cf8; }
  .badge-api { background: rgba(245,158,11,0.15); color: #f59e0b; }

  .banner {
    padding: 10px 14px;
    border-radius: var(--radius-sm, 6px);
    margin-bottom: 12px;
    font-size: 12px;
  }

  .banner-error { background: rgba(239,68,68,0.12); color: #ef4444; border: 1px solid rgba(239,68,68,0.25); }
  .banner-success { background: rgba(34,197,94,0.12); color: #22c55e; border: 1px solid rgba(34,197,94,0.25); }

  .provider-card {
    padding: 10px 0;
    border-bottom: 1px solid var(--border-l1, #262626);
  }

  .provider-card:last-child { border-bottom: none; }

  .provider-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }

  .provider-name {
    font-weight: 600;
    font-size: 13px;
    flex: 1;
  }

  .provider-type { font-size: 10px; }

  .model-list { display: flex; flex-wrap: wrap; gap: 4px; }

  .model-tag {
    display: inline-block;
    padding: 2px 6px;
    background: var(--surface-l2, #1e1e1e);
    border: 1px solid var(--border-l2, #333);
    border-radius: var(--radius-sm, 6px);
    font-size: 11px;
    font-family: 'SFMono-Regular', Consolas, monospace;
    color: var(--fg-secondary, #aaa);
  }

  .form-card { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border-l1, #262626); }

  .form-hint {
    font-size: 12px;
    color: var(--fg-tertiary, #888);
    margin-bottom: 8px;
  }

  .form-row {
    display: flex;
    gap: 8px;
    margin-bottom: 8px;
    align-items: center;
  }

  .form-input {
    flex: 1;
    padding: 7px 10px;
    background: var(--surface-base, #0a0a0a);
    border: 1px solid var(--border-l2, #333);
    border-radius: var(--radius-sm, 6px);
    color: var(--fg-primary, #e5e5e5);
    font-size: 12px;
    outline: none;
    transition: border-color 0.15s;
  }

  .form-input:focus { border-color: var(--fg-link, #3b82f6); }

  select.form-input { cursor: pointer; }
  select.form-input option { background: var(--surface-l1, #141414); }

  .btn {
    padding: 6px 14px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm, 6px);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s, opacity 0.15s;
  }

  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-primary {
    background: var(--fg-link, #3b82f6);
    color: #fff;
    border-color: var(--fg-link, #3b82f6);
  }

  .btn-primary:hover:not(:disabled) { opacity: 0.85; }

  .btn-secondary {
    background: transparent;
    color: var(--fg-secondary, #aaa);
    border-color: var(--border-l2, #333);
  }

  .btn-secondary:hover:not(:disabled) { background: var(--button-ghost-hover, rgba(255,255,255,0.06)); }

  .btn-danger {
    background: transparent;
    color: var(--fg-danger, #ef4444);
    border-color: rgba(239,68,68,0.3);
    font-size: 11px;
    padding: 3px 8px;
  }

  .btn-danger:hover:not(:disabled) { background: rgba(239,68,68,0.1); }

  .btn-sm { font-size: 11px; padding: 3px 8px; }

  .empty-text {
    font-size: 12px;
    color: var(--fg-tertiary, #888);
    padding: 8px 0;
  }

  .empty-text code {
    background: var(--surface-l2, #1e1e1e);
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 11px;
  }

  @media (max-width: 400px) {
    .config-grid { grid-template-columns: 1fr; }
    .form-row { flex-direction: column; }
    .form-row .btn { width: 100%; }
  }
`;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

xai.on('ready', () => {
  loadData();

  // Poll every 30 seconds
  pollTimer = setInterval(loadData, 30_000);
});

// Sync with chat — refresh when cliproxy commands are used
xai.on('chat.message', (msg: any) => {
  if (msg?.text?.includes?.('@cliproxy')) {
    // Delay a bit to let the command execute
    setTimeout(loadData, 3000);
  }
});
