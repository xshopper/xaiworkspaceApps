import type { PanelState, ProviderDef } from './types';
import { getModels, deriveStatus, groupProviders, getTokenStatus, updateToken, disconnectProvider, connectApiKeyProvider, connectProviderChat, startCliOAuth, pollCliOAuth, submitOAuthPaste } from './api';

// ---------------------------------------------------------------------------
// Provider definitions for the connect form
// ---------------------------------------------------------------------------

const PROVIDERS: (ProviderDef & { icon: string })[] = [
  { id: 'claude',      label: 'Claude Code',     type: 'cli-subscription', hint: 'Browser OAuth — no API key needed',  icon: '\u{1F9E0}' },
  { id: 'codex',       label: 'OpenAI Codex',    type: 'cli-subscription', hint: 'Browser OAuth — GPT models',         icon: '\u{1F9E9}' },
  { id: 'gemini',      label: 'Gemini CLI',      type: 'cli-subscription', hint: 'Browser OAuth — no API key needed',  icon: '\u{2728}' },
  { id: 'qwen',        label: 'Qwen Code',       type: 'cli-subscription', hint: 'Browser OAuth — no API key needed',  icon: '\u{1F396}\u{FE0F}' },
  { id: 'iflow',       label: 'iFlow',           type: 'cli-subscription', hint: 'Browser OAuth — no API key needed',  icon: '\u{1F30A}' },
  { id: 'zai',         label: 'Z.ai / Zhipu',    type: 'api-key',          hint: 'Get key at z.ai',                     icon: '\u{1F4A1}' },
  { id: 'grok',        label: 'xAI Grok',        type: 'api-key',          hint: 'Get key at console.x.ai',             icon: '\u{1F916}' },
  { id: 'openai',      label: 'OpenAI',          type: 'api-key',          hint: 'Get key at platform.openai.com',      icon: '\u{1F7E2}' },
  { id: 'anthropic',   label: 'Anthropic',       type: 'api-key',          hint: 'Get key at console.anthropic.com',    icon: '\u{1F53A}' },
  { id: 'gemini-api',  label: 'Gemini API',      type: 'api-key',          hint: 'Get key at aistudio.google.com',      icon: '\u{1F48E}' },
  { id: 'groq',        label: 'Groq',            type: 'api-key',          hint: 'Get key at console.groq.com',         icon: '\u{26A1}' },
  { id: 'mistral',     label: 'Mistral',         type: 'api-key',          hint: 'Get key at console.mistral.ai',       icon: '\u{1F32C}\u{FE0F}' },
];

function providerIcon(id: string): string {
  return PROVIDERS.find(p => p.id === id)?.icon ?? '\u{1F50C}';
}

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
let oauthPollTimer: ReturnType<typeof setTimeout> | null = null;
let oauthState: string | null = null;
let oauthConnecting = false;
let oauthAuthUrl: string | null = null;
let tokenCardProvider: string | null = null; // which CLI provider the token card is showing
let oauthSessionId = 0; // incremented on each new OAuth flow to detect stale polls

// Form state preserved across re-renders
let selectedProviderId = '';
let apiKeyDraft = '';
let tokenInputDraft = '';
let manualTokenOpen = false;
let connecting = false; // API key connect in progress
let pasteDraft = ''; // OAuth redirect URL paste
let submittingPaste = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Look up human-readable label for a provider name (owned_by / id) */
function providerLabel(name: string): string {
  return PROVIDERS.find(p => p.id === name)?.label ?? name;
}

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
  state.error = null; // clear any existing error — only show one banner at a time
  if (successTimer) clearTimeout(successTimer);
  successTimer = setTimeout(() => { state.success = null; render(); }, 6000);
  render();
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

    // Get token status — prefer 'claude' if connected, else first CLI subscription
    const cliProviders = state.providers.filter(p => p.type === 'cli-subscription');
    const cliProvider = cliProviders.find(p => p.name === 'claude') ?? cliProviders[0] ?? null;
    if (cliProvider) {
      tokenCardProvider = cliProvider.name;
      state.tokenStatus = await getTokenStatus(cliProvider.name);
    } else {
      tokenCardProvider = null;
      state.tokenStatus = null;
    }
  } catch (err: any) {
    state.status = null; // don't show "Stopped" on network errors — status is unknown
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
  const token = tokenInputDraft.trim();
  if (!token) return;

  // Use the provider the token card is actually showing
  const provider = tokenCardProvider || 'claude';

  state.error = null;
  state.savingToken = true;
  render();

  try {
    const result = await updateToken(provider, token);
    if (result.ok) {
      showSuccess(result.expired ? `Token updated. Expires: ${formatDate(result.expired)}` : 'Token updated successfully.');
      tokenInputDraft = '';
      await loadData(); // refresh status
    } else {
      state.error = result.error ?? 'Token update failed';
      state.success = null;
    }
  } catch (err: any) {
    state.error = err?.message ?? 'Token update failed';
    state.success = null;
  } finally {
    state.savingToken = false;
    render();
  }
}

function handleDisconnect(providerName: string) {
  const label = providerLabel(providerName);
  // confirm() doesn't work in sandbox iframes (no allow-modals) — proceed directly
  disconnectProvider(providerName);
  showSuccess(`Disconnect request sent for ${label}. Refreshing...`);
  setTimeout(loadData, 4000);
}

async function handleConnect() {
  if (!selectedProviderId) return;

  const def = PROVIDERS.find(p => p.id === selectedProviderId);
  if (!def) return;

  if (def.type === 'api-key') {
    const key = apiKeyDraft.trim();
    if (!key) { state.error = 'Please enter an API key'; state.success = null; render(); return; }
    connecting = true;
    state.error = null;
    render();

    const submittedProvider = selectedProviderId;
    try {
      const result = await connectApiKeyProvider(submittedProvider, key);
      if (result.ok) {
        showSuccess(`${def.label} API key configured. Refreshing models...`);
        apiKeyDraft = '';
        // Give CLIProxyAPI a moment to discover new models
        setTimeout(async () => {
          connecting = false;
          await loadData();
          if (state.providers.some(p => p.name === submittedProvider)) {
            selectedProviderId = '';
          }
          render();
        }, 3000);
      } else {
        connecting = false;
        state.error = result.error ?? `Failed to set API key for ${def.label}`;
        state.success = null;
        render();
      }
    } catch (err: any) {
      connecting = false;
      state.error = err?.message ?? `Could not reach CLIProxyAPI to set ${def.label} key`;
      state.success = null;
      render();
    }
  } else {
    // CLI subscription — start OAuth via CLIProxyAPI or chat
    handleOAuthConnect(selectedProviderId, def.label).catch(err => {
      oauthConnecting = false;
      state.error = err?.message ?? 'OAuth failed to start';
      state.success = null;
      render();
    });
  }
}

async function handleOAuthConnect(providerId: string, label: string) {
  if (oauthConnecting) {
    state.error = 'Authentication already in progress — cancel it first.';
    render();
    return;
  }
  oauthConnecting = true;
  state.error = null;
  const thisSession = ++oauthSessionId;
  render();

  // Start OAuth via the router backend (proxies to user's EC2 CLIProxyAPI)
  const result = await startCliOAuth(providerId);
  // Guard: user may have cancelled during the await
  if (thisSession !== oauthSessionId || !oauthConnecting) return;
  if (result?.authorize_url) {
    oauthState = result.state;
    const authUrl = result.authorize_url;
    const startedAt = result.started_at;
    // Validate URL scheme
    if (!/^https?:\/\//i.test(authUrl)) {
      oauthState = null;
      oauthConnecting = false;
      connectProviderChat(providerId);
      showSuccess(`Connecting ${label}... Check chat for auth instructions.`);
      render();
      return;
    }
    oauthAuthUrl = authUrl;
    // Open the verification URL via the host bridge (handles web popup + native browser)
    try {
      await xai.openUrl(authUrl);
      showSuccess(`OAuth started for ${label}. Complete authentication in the browser tab.`);
    } catch {
      showSuccess(`Could not open browser — use the link in the authenticating card below.`);
    }

    // Poll for completion using setTimeout recursion (supports slow_down backoff)
    const oauthPollStart = Date.now();
    const OAUTH_POLL_MAX_MS = 15 * 60 * 1000;
    let pollDelay = 3000;
    if (oauthPollTimer) clearTimeout(oauthPollTimer);

    // Use a local timer handle per session to avoid aliasing with newer sessions
    let localTimer: ReturnType<typeof setTimeout> | null = null;

    function cleanupSession() {
      // Only clear the shared timer if it's still ours
      if (oauthPollTimer === localTimer) oauthPollTimer = null;
      localTimer = null;
      oauthState = null;
      oauthAuthUrl = null;
      oauthConnecting = false;
      pasteDraft = '';
    }

    function scheduleOAuthPoll() {
      localTimer = setTimeout(async () => {
        try {
        if (thisSession !== oauthSessionId) return; // stale session — exit silently
        const currentState = oauthState;
        if (!currentState || Date.now() - oauthPollStart > OAUTH_POLL_MAX_MS) {
          cleanupSession();
          state.error = 'OAuth timed out. Please try again.';
          render();
          return;
        }
        const poll = await pollCliOAuth(currentState, startedAt, providerId);
        if (thisSession !== oauthSessionId) return; // superseded during await
        if (!oauthConnecting) return; // cancelled during await
        if (poll.status === 'ok') {
          cleanupSession();
          showSuccess(`${label} connected successfully! Models are now available.`);
          await loadData();
          tokenCardProvider = providerId; // show the just-connected provider after loadData
          render();
        } else if (poll.status === 'error') {
          cleanupSession();
          state.error = poll.message || 'OAuth failed. Try again or use the chat command.';
          render();
        } else {
          // 'wait' or 'slow_down' — schedule next poll
          if (poll.status === 'slow_down') pollDelay = Math.min(pollDelay + 5000, 30000); // RFC 8628 §3.5
          scheduleOAuthPoll();
        }
        } catch (err: any) {
          cleanupSession();
          state.error = err?.message ?? 'OAuth polling failed unexpectedly';
          render();
        }
      }, pollDelay);
      oauthPollTimer = localTimer; // sync shared handle for cancel
    }
    scheduleOAuthPoll();
  } else {
    // Fallback: use chat command
    oauthConnecting = false;
    connectProviderChat(providerId);
    showSuccess(`Connecting ${label}... Check chat for auth instructions.`);
  }
  render();
}

function handleCancelOAuth() {
  ++oauthSessionId; // invalidate any in-flight poll callbacks
  if (oauthPollTimer) clearTimeout(oauthPollTimer);
  oauthPollTimer = null;
  oauthState = null;
  oauthAuthUrl = null;
  oauthConnecting = false;
  pasteDraft = '';
  showSuccess('Authentication cancelled.');
}

/**
 * Submit a pasted OAuth redirect URL. User lands on
 * `localhost:54545/callback?code=...&state=...` after login — that URL never
 * loads a page (nothing binds the port in cloud workers), but the address bar
 * still shows the code + state. Pasting the URL here routes the callback
 * through the router backend to the user's workspace CLIProxyAPI, which
 * completes the token exchange using the PKCE verifier it stored at start.
 */
async function handleSubmitPaste() {
  const pasted = pasteDraft.trim();
  if (!pasted || submittingPaste) return;

  submittingPaste = true;
  state.error = null;
  render();

  try {
    const result = await submitOAuthPaste(pasted, oauthState);
    if (result.ok) {
      pasteDraft = '';
      showSuccess('Callback submitted. Completing authentication...');
      // Polling loop picks up the tokens once CLIProxyAPI finishes the exchange.
    } else {
      state.error = result.error ?? 'Callback submission failed';
      state.success = null;
    }
  } catch (err: any) {
    state.error = err?.message ?? 'Callback submission failed';
    state.success = null;
  } finally {
    submittingPaste = false;
    render();
  }
}

function onPasteInput() {
  const input = document.getElementById('oauth-paste-input') as HTMLInputElement | null;
  if (!input) return;
  const prev = pasteDraft;
  pasteDraft = input.value;
  // Re-render on empty ↔ non-empty transition so the Submit button toggles
  // disabled state immediately. Skip re-render on keystrokes that don't change
  // enabled state — avoids losing the input's caret position mid-typing.
  if (!prev.trim() !== !pasteDraft.trim()) render();
}

async function handlePasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      pasteDraft = text;
      render();
    }
  } catch {
    // Permission denied or unavailable — user can paste manually.
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  const tokenCardTitle = tokenCardProvider
    ? providerLabel(tokenCardProvider) + ' OAuth Token'
    : 'OAuth Token';
  const connectedIds = new Set(state.providers.map(p => p.name));
  const unconnected = PROVIDERS.filter(p => !connectedIds.has(p.id));
  const running = !!state.status?.running;

  const html = `
    <style>${CSS}</style>
    <div class="panel">
      <div class="panel-header">
        <div class="panel-header-row">
          <div>
            <h1>CLI Proxy</h1>
            <p class="panel-sub">Manage AI model providers</p>
          </div>
          <button class="btn-refresh" onclick="__refresh()" ${state.loading ? 'disabled' : ''} title="Refresh">&#x21bb;</button>
        </div>
      </div>

      ${state.error ? `<div class="banner banner-error">${escapeHtml(state.error)}</div>` : ''}
      ${state.success ? `<div class="banner banner-success">${escapeHtml(state.success)}</div>` : ''}

      <!-- Status Card -->
      <div class="section-card">
        <div class="section-title">Service Status</div>
        ${state.status ? `
          <div class="config-row">
            <span class="config-label">Status</span>
            <span class="status-wrap">
              <span class="app-dot ${running ? 'app-dot--running' : 'app-dot--error'}"></span>
              <span class="config-value">${running ? 'Running' : 'Stopped'}</span>
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
        ` : `
          <div class="config-row">
            <span class="empty-text">
              ${state.loading ? 'Checking service...' : 'CLIProxyAPI not reachable. Use <code>@cliproxy status</code> in chat to install and start.'}
            </span>
          </div>
        `}
      </div>

      <!-- Token Management (shown if a CLI subscription provider is connected) -->
      ${state.tokenStatus ? `
      <div class="section-card">
        <div class="section-title">${escapeHtml(tokenCardTitle)}</div>
        <div class="config-row">
          <span class="config-label">Status</span>
          <span class="status-wrap">
            <span class="app-dot ${state.tokenStatus.is_expired ? 'app-dot--error' : 'app-dot--running'}"></span>
            <span class="badge ${state.tokenStatus.is_expired ? 'badge-expired' : 'badge-active'}">
              ${state.tokenStatus.is_expired ? 'Expired' : 'Active'}
            </span>
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

        ${!state.tokenStatus?.has_refresh_token ? (() => {
          // All five CLI subscription providers (Claude, Codex, Gemini, Qwen, iFlow)
          // do issue refresh tokens via the upstream cli-proxy-api binary, so a
          // missing refresh token here means the OAuth flow was incomplete or the
          // user pasted a manual short-lived token. Surface that honestly instead
          // of claiming auto-refresh is broken for the provider.
          const provider = tokenCardProvider || 'this provider';
          const label = providerLabel(provider);
          return `
          <div class="inline-notice inline-notice--warn">
            <p>No refresh token stored for ${escapeHtml(label)}. Auto-refresh will be unavailable until you re-connect via the OAuth flow (manual token pastes do not include a refresh token).</p>
            <button class="btn-action btn-action--primary" onclick="__reconnectCurrentProvider()">
              Re-connect ${escapeHtml(label)}
            </button>
          </div>
          `;
        })() : (() => {
          const expiredAt = state.tokenStatus?.expired;
          if (!expiredAt) return '';
          const expiresMs = new Date(expiredAt).getTime();
          if (!Number.isFinite(expiresMs)) return '';
          const msUntil = expiresMs - Date.now();
          const FIVE_MIN_MS = 5 * 60 * 1000;
          if (msUntil <= 0 || msUntil > FIVE_MIN_MS) return '';
          const minutes = Math.max(1, Math.ceil(msUntil / 60_000));
          const provider = tokenCardProvider || 'this provider';
          const label = providerLabel(provider);
          return `
          <div class="inline-notice inline-notice--warn">
            <p>Token for ${escapeHtml(label)} expires in ~${minutes} minute${minutes === 1 ? '' : 's'}. If auto-refresh fails, re-connect here to avoid auth errors mid-session.</p>
            <button class="btn-action btn-action--secondary" onclick="__reconnectCurrentProvider()">
              Re-connect ${escapeHtml(label)}
            </button>
          </div>
          `;
        })()}

        <!-- Manual token paste (collapsed fallback) -->
        <details class="inline-expander" ${manualTokenOpen ? 'open' : ''} ontoggle="__onTokenToggle()">
          <summary>Manual token update (fallback)</summary>
          <div class="form-row">
            <input type="password" id="token-input" class="form-input mono" placeholder="${escapeHtml(tokenCardProvider === 'claude' ? 'sk-ant-oat01-...' : 'Paste OAuth token...')}" value="${escapeHtml(tokenInputDraft)}" oninput="__onTokenInput()" />
            <button class="btn-action btn-action--primary" onclick="__updateToken()" ${state.savingToken ? 'disabled' : ''}>
              ${state.savingToken ? 'Updating...' : 'Update'}
            </button>
          </div>
        </details>
      </div>
      ` : ''}

      <!-- OAuth Connecting State (shown above providers for visibility) -->
      ${oauthConnecting ? `
      <div class="section-card">
        <div class="section-title">Authenticating...</div>
        <div class="config-row">
          <span class="config-label">Provider</span>
          <span class="status-wrap">
            <span class="app-dot app-dot--installing"></span>
            <span class="config-value">Waiting for browser authorization</span>
          </span>
        </div>
        ${oauthAuthUrl ? `
        <div class="config-row">
          <span class="config-label">Auth URL</span>
          <a class="config-link" href="${escapeHtml(oauthAuthUrl)}" target="_blank" rel="noopener noreferrer">Open authentication page</a>
        </div>` : ''}

        <div class="inline-notice">
          <p><strong>Page stuck on "this site can't be reached"?</strong> That's expected — copy the full URL from the address bar and paste it below.</p>
          <div class="form-row">
            <input type="text" id="oauth-paste-input" class="form-input mono" placeholder="http://localhost:54545/callback?code=...&amp;state=..." value="${escapeHtml(pasteDraft)}" oninput="__onPasteInput()" ${submittingPaste ? 'disabled' : ''} />
          </div>
          <div class="form-row">
            <button class="btn-action btn-action--secondary" onclick="__pasteFromClipboard()" ${submittingPaste ? 'disabled' : ''}>Paste from clipboard</button>
            <button class="btn-action btn-action--primary" onclick="__submitPaste()" ${submittingPaste || !pasteDraft.trim() ? 'disabled' : ''}>
              ${submittingPaste ? 'Submitting...' : 'Submit URL'}
            </button>
            <button class="btn-action btn-action--danger" onclick="__cancelOAuth()" ${submittingPaste ? 'disabled' : ''}>Cancel</button>
          </div>
        </div>
      </div>
      ` : ''}

      <!-- Connected Providers -->
      <div class="section-card">
        <div class="section-title">Connected Providers</div>
        ${state.providers.length > 0 ? state.providers.map(p => {
          const def = PROVIDERS.find(d => d.id === p.name);
          const kind = p.type === 'cli-subscription' ? 'CLI' : 'API KEY';
          return `
          <div class="app-card">
            <div class="app-card-main">
              <div class="app-icon">${providerIcon(p.name)}</div>
              <span class="app-dot app-dot--running" title="Connected"></span>
              <div class="app-info">
                <div class="app-name">${escapeHtml(providerLabel(p.name))}</div>
                <div class="app-meta">
                  <span class="app-kind-badge ${p.type === 'cli-subscription' ? 'app-kind-badge--cli' : 'app-kind-badge--api'}">${kind}</span>
                  <span class="app-status app-status--running">${p.models.length} model${p.models.length === 1 ? '' : 's'}</span>
                </div>
              </div>
              <div class="app-actions">
                <button class="btn-action btn-action--danger" data-disconnect="${escapeHtml(p.name)}">Disconnect</button>
              </div>
            </div>
            ${def ? `<div class="app-description">${escapeHtml(def.hint)}</div>` : ''}
          </div>
          `;
        }).join('') : `
          <div class="app-card">
            <p class="empty-text">No providers connected. Pick one below or type <code>@cliproxy connect claude</code> in chat.</p>
          </div>
        `}
      </div>

      <!-- Connect Provider (single row per provider) -->
      <div class="section-card">
        <div class="section-title">Connect Provider</div>
        ${unconnected.length > 0 ? unconnected.map(def => {
          const kind = def.type === 'cli-subscription' ? 'CLI' : 'API KEY';
          const isSelected = selectedProviderId === def.id && def.type === 'api-key';
          const formDisabled = oauthConnecting || connecting;
          const keyDisabled = formDisabled && !isSelected;
          const cta = def.type === 'cli-subscription'
            ? (oauthConnecting && selectedProviderId === def.id ? 'Connecting...' : 'Connect')
            : (connecting && selectedProviderId === def.id ? 'Connecting...' : 'Connect');
          return `
          <div class="app-card">
            <div class="app-card-main">
              <div class="app-icon">${providerIcon(def.id)}</div>
              <span class="app-dot" title="Not connected"></span>
              <div class="app-info">
                <div class="app-name">${escapeHtml(def.label)}</div>
                <div class="app-meta">
                  <span class="app-kind-badge ${def.type === 'cli-subscription' ? 'app-kind-badge--cli' : 'app-kind-badge--api'}">${kind}</span>
                  <span class="app-status">${escapeHtml(def.hint)}</span>
                </div>
              </div>
              <div class="app-actions">
                <button class="btn-action btn-action--primary" onclick="__startConnect('${def.id}')" ${keyDisabled ? 'disabled' : ''}>${cta}</button>
              </div>
            </div>
            ${isSelected ? `
            <div class="inline-expander-body">
              <div class="form-row">
                <input type="password" id="api-key-input" class="form-input mono" placeholder="Paste your API key..." value="${escapeHtml(apiKeyDraft)}" oninput="__onKeyInput()" ${connecting ? 'disabled' : ''} />
                <button class="btn-action btn-action--primary" onclick="__submitApiKey('${def.id}')" ${connecting || !apiKeyDraft.trim() ? 'disabled' : ''}>
                  ${connecting ? 'Saving...' : 'Save key'}
                </button>
                <button class="btn-action btn-action--secondary" onclick="__cancelApiKey()" ${connecting ? 'disabled' : ''}>Cancel</button>
              </div>
            </div>` : ''}
          </div>
          `;
        }).join('') : `
          <div class="app-card">
            <p class="empty-text">All known providers are connected.</p>
          </div>
        `}
      </div>
    </div>
  `;

  xai.render(html);

  // Re-attach global handlers after render (xai.render replaces innerHTML)
  (window as any).__refresh = loadData;
  (window as any).__updateToken = handleUpdateToken;
  (window as any).__cancelOAuth = handleCancelOAuth;
  (window as any).__onKeyInput = onKeyInput;
  (window as any).__onTokenInput = onTokenInput;
  (window as any).__onTokenToggle = onTokenToggle;
  (window as any).__onPasteInput = onPasteInput;
  (window as any).__submitPaste = handleSubmitPaste;
  (window as any).__pasteFromClipboard = handlePasteFromClipboard;
  // New per-row connect flow — replaces the dropdown-driven __connect path.
  (window as any).__startConnect = (id: string) => {
    const def = PROVIDERS.find(p => p.id === id);
    if (!def) return;
    if (def.type === 'api-key') {
      // Toggle inline expander
      if (selectedProviderId === id) {
        selectedProviderId = '';
        apiKeyDraft = '';
      } else {
        selectedProviderId = id;
        apiKeyDraft = '';
      }
      render();
    } else {
      selectedProviderId = id;
      handleConnect();
    }
  };
  (window as any).__submitApiKey = (id: string) => {
    selectedProviderId = id;
    handleConnect();
  };
  (window as any).__cancelApiKey = () => {
    selectedProviderId = '';
    apiKeyDraft = '';
    render();
  };
  // Pre-expiry / missing-refresh-token reconnect shortcut. Selects the current
  // provider and kicks off the OAuth flow without the user having to re-choose.
  (window as any).__reconnectCurrentProvider = () => {
    if (!tokenCardProvider) return;
    selectedProviderId = tokenCardProvider;
    handleConnect();
  };
}

function onKeyInput() {
  const input = document.getElementById('api-key-input') as HTMLInputElement | null;
  if (!input) return;
  const prev = apiKeyDraft;
  apiKeyDraft = input.value;
  // Re-render on empty ↔ non-empty transition so Save key button toggles.
  // Skip re-render on mid-typing keystrokes to preserve caret position.
  if (!prev.trim() !== !apiKeyDraft.trim()) render();
}

function onTokenInput() {
  const input = document.getElementById('token-input') as HTMLInputElement | null;
  if (input) tokenInputDraft = input.value;
}

function onTokenToggle() {
  const details = document.querySelector('.form-card[ontoggle]') as HTMLDetailsElement | null;
  if (details) manualTokenOpen = details.open;
}

// ---------------------------------------------------------------------------
// Escape helpers
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Styles (platform CSS variables)
// ---------------------------------------------------------------------------

const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-text-size-adjust: 100%; }

  body {
    font-family: var(--font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    background: var(--surface-base, #0a0a0a);
    color: var(--fg-primary, #e5e5e5);
    font-size: 14px;
    line-height: 1.5;
  }

  .panel {
    max-width: 700px;
    width: 100%;
    margin: 0 auto;
    padding: 32px 24px;
  }

  /* --- Header --- */

  .panel-header { margin-bottom: 24px; }

  .panel-header-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .panel-header-row h1 {
    font-size: 24px;
    font-weight: 700;
    margin: 0 0 4px;
    color: var(--fg-primary, #e5e5e5);
  }

  .panel-sub {
    font-size: 14px;
    color: var(--fg-tertiary, #888);
    margin: 0;
  }

  .btn-refresh {
    background: none;
    border: 1px solid var(--border-l2, #333);
    border-radius: 6px;
    color: var(--fg-secondary, #aaa);
    font-size: 18px;
    padding: 4px 8px;
    cursor: pointer;
    font-family: inherit;
    line-height: 1;
  }
  .btn-refresh:hover:not(:disabled) { color: var(--fg-primary, #e5e5e5); }
  .btn-refresh:disabled { opacity: 0.4; cursor: default; }

  /* --- Banners --- */

  .banner {
    padding: 10px 14px;
    border-radius: 6px;
    margin-bottom: 16px;
    font-size: 13px;
  }
  .banner-error {
    background: rgba(255, 59, 48, 0.12);
    color: #ff3b30;
    border: 1px solid rgba(255, 59, 48, 0.25);
  }
  .banner-success {
    background: rgba(52, 199, 89, 0.15);
    color: #34c759;
    border: 1px solid rgba(52, 199, 89, 0.25);
  }

  /* --- Section cards --- */

  .section-card {
    border: 1px solid var(--border-l2, #333);
    border-radius: 10px;
    background: var(--surface-l1, #141414);
    margin-bottom: 16px;
    overflow: hidden;
  }

  .section-title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--fg-tertiary, #888);
    padding: 12px 16px 8px;
  }

  /* --- Config rows (status / token metadata) --- */

  .config-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 16px;
    border-top: 1px solid var(--border-l1, #262626);
  }
  .config-row:first-of-type { border-top: none; }

  .config-label {
    font-size: 12px;
    color: var(--fg-secondary, #aaa);
    flex-shrink: 0;
  }

  .config-value {
    font-size: 13px;
    color: var(--fg-primary, #e5e5e5);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .config-link {
    font-size: 13px;
    color: var(--accent, #3b82f6);
    text-decoration: none;
  }
  .config-link:hover { text-decoration: underline; }

  .status-wrap {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .mono {
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 12px;
  }

  .text-danger { color: #ff3b30; }

  /* --- Dots (status indicator) --- */

  .app-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--fg-tertiary, #888);
    flex-shrink: 0;
    display: inline-block;
  }
  .app-dot--running { background: #34c759; }
  .app-dot--error { background: #ff3b30; }
  .app-dot--installing { background: #ffcc00; animation: pulse 1.5s infinite; }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  /* --- Badges --- */

  .badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
  .badge-active { background: rgba(52, 199, 89, 0.15); color: #34c759; }
  .badge-expired { background: rgba(255, 59, 48, 0.15); color: #ff3b30; }
  .badge-cli { background: rgba(99, 102, 241, 0.15); color: #818cf8; }
  .badge-api { background: rgba(245, 158, 11, 0.15); color: #f59e0b; }

  /* --- App-card rows (provider list / connect list) --- */

  .app-card {
    padding: 12px 16px;
    border-top: 1px solid var(--border-l1, #262626);
  }
  .app-card:first-of-type { border-top: none; }

  .app-card-main {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .app-icon {
    font-size: 20px;
    width: 28px;
    text-align: center;
    flex-shrink: 0;
  }

  .app-info {
    flex: 1;
    min-width: 0;
  }

  .app-name {
    font-weight: 500;
    font-size: 14px;
    color: var(--fg-primary, #e5e5e5);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .app-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 2px;
    flex-wrap: wrap;
  }

  .app-kind-badge {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    padding: 1px 6px;
    border-radius: 4px;
    background: rgba(128, 128, 128, 0.1);
    color: var(--fg-tertiary, #888);
  }
  .app-kind-badge--cli { background: rgba(99, 102, 241, 0.15); color: #818cf8; }
  .app-kind-badge--api { background: rgba(245, 158, 11, 0.15); color: #f59e0b; }

  .app-status {
    font-size: 11px;
    color: var(--fg-tertiary, #888);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .app-status--running { color: #34c759; }
  .app-status--error { color: #ff3b30; }

  .app-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }

  .app-description {
    font-size: 12px;
    color: var(--fg-secondary, #aaa);
    margin-top: 6px;
    padding-left: 46px;
    line-height: 1.4;
  }

  /* --- Action buttons --- */

  .btn-action {
    padding: 5px 14px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    flex-shrink: 0;
    border: none;
    transition: opacity 0.15s;
    white-space: nowrap;
  }
  .btn-action:hover:not(:disabled) { opacity: 0.85; }
  .btn-action:disabled { opacity: 0.5; cursor: default; }

  .btn-action--primary {
    background: var(--accent, #3b82f6);
    color: #fff;
  }
  .btn-action--danger {
    background: rgba(255, 59, 48, 0.12);
    color: #ff3b30;
  }
  .btn-action--secondary {
    background: rgba(128, 128, 128, 0.1);
    color: var(--fg-secondary, #aaa);
  }

  /* --- Inline notices (warn/info within a card) --- */

  .inline-notice {
    margin: 4px 16px 12px;
    padding: 12px;
    border-radius: 8px;
    background: var(--surface-l2, #1e1e1e);
    border: 1px solid var(--border-l1, #262626);
    font-size: 13px;
    color: var(--fg-secondary, #aaa);
  }
  .inline-notice--warn {
    background: rgba(245, 158, 11, 0.08);
    border-color: rgba(245, 158, 11, 0.25);
    color: var(--fg-primary, #e5e5e5);
  }
  .inline-notice p { margin: 0 0 8px; line-height: 1.45; }
  .inline-notice p:last-child { margin-bottom: 0; }

  /* --- Expanders (manual token, api-key input) --- */

  .inline-expander {
    padding: 12px 16px;
    border-top: 1px solid var(--border-l1, #262626);
    font-size: 12px;
  }
  .inline-expander > summary {
    cursor: pointer;
    color: var(--fg-tertiary, #888);
    font-size: 12px;
    user-select: none;
    list-style: none;
  }
  .inline-expander > summary::-webkit-details-marker { display: none; }
  .inline-expander > summary::before {
    content: '\u{25B8}';
    display: inline-block;
    margin-right: 6px;
    transition: transform 0.15s;
  }
  .inline-expander[open] > summary::before { transform: rotate(90deg); }
  .inline-expander[open] { padding-bottom: 16px; }
  .inline-expander > .form-row { margin-top: 10px; }

  .inline-expander-body {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px dashed var(--border-l1, #262626);
  }

  /* --- Form inputs --- */

  .form-row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .form-row + .form-row { margin-top: 8px; }

  .form-input {
    flex: 1 1 220px;
    padding: 8px 10px;
    min-height: 34px;
    background: var(--surface-base, #0a0a0a);
    border: 1px solid var(--border-l2, #333);
    border-radius: 6px;
    color: var(--fg-primary, #e5e5e5);
    font-size: 13px;
    outline: none;
    transition: border-color 0.15s;
    -webkit-appearance: none;
    appearance: none;
  }
  .form-input:focus { border-color: var(--accent, #3b82f6); }

  /* --- Empty state --- */

  .empty-text {
    font-size: 13px;
    color: var(--fg-tertiary, #888);
    margin: 0;
  }
  .empty-text code {
    background: var(--surface-l2, #1e1e1e);
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 12px;
    font-family: 'SFMono-Regular', Consolas, monospace;
  }

  /* --- Responsive --- */

  @media (max-width: 600px) {
    .panel { padding: 20px 16px; }
    .panel-header-row h1 { font-size: 20px; }
    .app-card-main { flex-wrap: wrap; }
    .app-actions { margin-left: auto; }
    .app-description { padding-left: 0; }
    .config-row { flex-wrap: wrap; gap: 4px; }
    .form-input { font-size: 16px; }
  }

  @media (max-width: 360px) {
    .panel { padding: 16px 12px; }
    .app-icon { width: 24px; font-size: 18px; }
  }
`;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

xai.on('ready', () => {
  state.loading = true;
  render(); // show loading state immediately
  loadData();

  // Poll every 30 seconds (clear previous if re-initialized)
  // Skip poll when user is actively interacting with form inputs
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT') return; // don't interrupt typing
    loadData();
  }, 30_000);

  // Event delegation for disconnect buttons (registered once, not per render)
  if (!(window as any).__cliproxyClickRegistered) {
    (window as any).__cliproxyClickRegistered = true;
    document.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-disconnect]') as HTMLElement | null;
      if (btn?.dataset.disconnect) handleDisconnect(btn.dataset.disconnect);
    });
  }
});

// Sync with chat — refresh when cliproxy commands are used
xai.on('chat.message', (msg: any) => {
  if (msg?.text?.includes?.('@cliproxy')) {
    // Delay a bit to let the command execute
    setTimeout(loadData, 3000);
  }
});

// OAuth callback received via WS push (router sandbox-proxy → WS → here).
// Triggers an immediate poll so the user doesn't wait for the 3s timer.
xai.on('cliproxy.oauth.callback', (data: any) => {
  if (!oauthConnecting || !oauthState) return;
  if (!data?.state || data.state === oauthState) {
    if (oauthPollTimer) clearTimeout(oauthPollTimer);
    let retries = 0;
    const maxRetries = 5;
    function immediateOAuthPoll() {
      oauthPollTimer = setTimeout(async () => {
        if (!oauthConnecting || !oauthState) return;
        try {
          const poll = await pollCliOAuth(oauthState!, '', data?.provider ?? '');
          if (poll.status === 'ok') {
            const label = PROVIDERS.find(p => p.id === selectedProviderId)?.label ?? data?.provider ?? '';
            oauthState = null;
            oauthAuthUrl = null;
            oauthConnecting = false;
            oauthPollTimer = null;
            pasteDraft = '';
            showSuccess(`${label} connected successfully! Models are now available.`);
            await loadData();
            tokenCardProvider = data?.provider ?? selectedProviderId;
            render();
          } else if (++retries < maxRetries) {
            // CLIProxyAPI still exchanging the code — retry with backoff
            immediateOAuthPoll();
          } else {
            // Exhausted retries — clean up and show error
            oauthState = null;
            oauthAuthUrl = null;
            oauthConnecting = false;
            oauthPollTimer = null;
            state.error = 'Authentication confirmation timed out. Please try again.';
            render();
          }
        } catch {
          oauthState = null;
          oauthAuthUrl = null;
          oauthConnecting = false;
          oauthPollTimer = null;
          state.error = 'Authentication confirmation failed unexpectedly.';
          render();
        }
      }, 500 + retries * 1000);
    }
    immediateOAuthPoll();
  }
});
