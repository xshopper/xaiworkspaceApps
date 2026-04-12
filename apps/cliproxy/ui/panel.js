(() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __esm = (fn, res) => function __init() {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  };
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };

  // apps/cliproxy/ui/api.ts
  async function getModels() {
    const res = await xai.http(`${BASE}/v1/models`);
    return res.data;
  }
  function deriveStatus(models) {
    const providerNames = new Set(models.data.map((m) => m.owned_by ?? "unknown"));
    return {
      running: true,
      port: 4001,
      providerCount: providerNames.size,
      modelCount: models.data.length
    };
  }
  function groupProviders(models) {
    const groups = /* @__PURE__ */ new Map();
    for (const m of models) {
      const owner = m.owned_by ?? "unknown";
      if (!groups.has(owner)) groups.set(owner, []);
      groups.get(owner).push(m);
    }
    return Array.from(groups.entries()).map(([name, provModels]) => ({
      name,
      type: CLI_PROVIDERS.has(name) ? "cli-subscription" : "api-key",
      models: provModels
    }));
  }
  async function getTokenStatus(provider) {
    try {
      const res = await xai.http(`${BASE}/admin/token?provider=${encodeURIComponent(provider)}`);
      return res.data;
    } catch {
      return null;
    }
  }
  async function updateToken(provider, accessToken) {
    const res = await xai.http(`${BASE}/admin/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, access_token: accessToken })
    });
    return res.data;
  }
  function disconnectProvider(name) {
    xai.chat.send(`@cliproxy disconnect ${name}`);
  }
  async function connectApiKeyProvider(providerId, apiKey) {
    const res = await xai.http(
      `${BASE}/admin/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId, access_token: apiKey })
      }
    );
    return res.data;
  }
  function connectProviderChat(providerId) {
    xai.chat.send(`@cliproxy connect ${providerId}`);
  }
  async function startCliOAuth(provider) {
    try {
      return await xai.cliproxy.startOAuth(provider);
    } catch {
      return null;
    }
  }
  async function pollCliOAuth(state, started_at, provider) {
    try {
      return await xai.cliproxy.pollOAuth(state, started_at, provider);
    } catch (err) {
      const msg = err?.message || "";
      if (msg.includes("Authentication required") || msg.includes("403") || msg.includes("forbidden")) {
        return { status: "error", message: msg || "OAuth session expired. Please try again." };
      }
      return { status: "wait", message: "Polling \u2014 waiting for authentication..." };
    }
  }
  var BASE, CLI_PROVIDERS;
  var init_api = __esm({
    "apps/cliproxy/ui/api.ts"() {
      BASE = "http://localhost:4001";
      CLI_PROVIDERS = /* @__PURE__ */ new Set(["claude", "gemini", "codex", "qwen", "iflow"]);
    }
  });

  // apps/cliproxy/ui/panel.ts
  var require_panel = __commonJS({
    "apps/cliproxy/ui/panel.ts"() {
      init_api();
      var PROVIDERS = [
        { id: "claude", label: "Claude Code", type: "cli-subscription", hint: "Browser OAuth \u2014 no API key needed" },
        { id: "codex", label: "OpenAI Codex", type: "cli-subscription", hint: "Browser OAuth \u2014 GPT models" },
        { id: "gemini", label: "Gemini CLI", type: "cli-subscription", hint: "Browser OAuth \u2014 no API key needed" },
        { id: "qwen", label: "Qwen Code", type: "cli-subscription", hint: "Browser OAuth \u2014 no API key needed" },
        { id: "iflow", label: "iFlow", type: "cli-subscription", hint: "Browser OAuth \u2014 no API key needed" },
        { id: "zai", label: "Z.ai / Zhipu", type: "api-key", hint: "Get key at z.ai" },
        { id: "grok", label: "xAI Grok", type: "api-key", hint: "Get key at console.x.ai" },
        { id: "openai", label: "OpenAI", type: "api-key", hint: "Get key at platform.openai.com" },
        { id: "anthropic", label: "Anthropic", type: "api-key", hint: "Get key at console.anthropic.com" },
        { id: "gemini-api", label: "Gemini API", type: "api-key", hint: "Get key at aistudio.google.com" },
        { id: "groq", label: "Groq", type: "api-key", hint: "Get key at console.groq.com" },
        { id: "mistral", label: "Mistral", type: "api-key", hint: "Get key at console.mistral.ai" }
      ];
      var state = {
        loading: false,
        error: null,
        success: null,
        status: null,
        providers: [],
        tokenStatus: null,
        savingToken: false
      };
      var successTimer = null;
      var pollTimer = null;
      var oauthPollTimer = null;
      var oauthState = null;
      var oauthConnecting = false;
      var oauthAuthUrl = null;
      var tokenCardProvider = null;
      var oauthSessionId = 0;
      var selectedProviderId = "";
      var apiKeyDraft = "";
      var tokenInputDraft = "";
      var manualTokenOpen = false;
      var connecting = false;
      function providerLabel(name) {
        return PROVIDERS.find((p) => p.id === name)?.label ?? name;
      }
      function formatDate(iso) {
        if (!iso) return "\u2014";
        try {
          return new Date(iso).toLocaleString();
        } catch {
          return iso;
        }
      }
      function showSuccess(msg) {
        state.success = msg;
        state.error = null;
        if (successTimer) clearTimeout(successTimer);
        successTimer = setTimeout(() => {
          state.success = null;
          render();
        }, 6e3);
        render();
      }
      async function loadData() {
        state.loading = true;
        state.error = null;
        render();
        try {
          const models = await getModels();
          state.status = deriveStatus(models);
          state.providers = groupProviders(models.data);
          const cliProviders = state.providers.filter((p) => p.type === "cli-subscription");
          const cliProvider = cliProviders.find((p) => p.name === "claude") ?? cliProviders[0] ?? null;
          if (cliProvider) {
            tokenCardProvider = cliProvider.name;
            state.tokenStatus = await getTokenStatus(cliProvider.name);
          } else {
            tokenCardProvider = null;
            state.tokenStatus = null;
          }
        } catch (err) {
          state.status = null;
          state.providers = [];
          state.tokenStatus = null;
          state.error = err?.message ?? "Could not reach CLIProxyAPI on localhost:4001";
        } finally {
          state.loading = false;
          render();
        }
      }
      async function handleUpdateToken() {
        const token = tokenInputDraft.trim();
        if (!token) return;
        const provider = tokenCardProvider || "claude";
        state.error = null;
        state.savingToken = true;
        render();
        try {
          const result = await updateToken(provider, token);
          if (result.ok) {
            showSuccess(result.expired ? `Token updated. Expires: ${formatDate(result.expired)}` : "Token updated successfully.");
            tokenInputDraft = "";
            await loadData();
          } else {
            state.error = result.error ?? "Token update failed";
            state.success = null;
          }
        } catch (err) {
          state.error = err?.message ?? "Token update failed";
          state.success = null;
        } finally {
          state.savingToken = false;
          render();
        }
      }
      function handleDisconnect(providerName) {
        const label = providerLabel(providerName);
        disconnectProvider(providerName);
        showSuccess(`Disconnect request sent for ${label}. Refreshing...`);
        setTimeout(loadData, 4e3);
      }
      async function handleConnect() {
        if (!selectedProviderId) return;
        const def = PROVIDERS.find((p) => p.id === selectedProviderId);
        if (!def) return;
        if (def.type === "api-key") {
          const key = apiKeyDraft.trim();
          if (!key) {
            state.error = "Please enter an API key";
            state.success = null;
            render();
            return;
          }
          connecting = true;
          state.error = null;
          render();
          const submittedProvider = selectedProviderId;
          try {
            const result = await connectApiKeyProvider(submittedProvider, key);
            if (result.ok) {
              showSuccess(`${def.label} API key configured. Refreshing models...`);
              apiKeyDraft = "";
              setTimeout(async () => {
                connecting = false;
                await loadData();
                if (state.providers.some((p) => p.name === submittedProvider)) {
                  selectedProviderId = "";
                }
                render();
              }, 3e3);
            } else {
              connecting = false;
              state.error = result.error ?? `Failed to set API key for ${def.label}`;
              state.success = null;
              render();
            }
          } catch (err) {
            connecting = false;
            state.error = err?.message ?? `Could not reach CLIProxyAPI to set ${def.label} key`;
            state.success = null;
            render();
          }
        } else {
          handleOAuthConnect(selectedProviderId, def.label).catch((err) => {
            oauthConnecting = false;
            state.error = err?.message ?? "OAuth failed to start";
            state.success = null;
            render();
          });
        }
      }
      async function handleOAuthConnect(providerId, label) {
        if (oauthConnecting) {
          state.error = "Authentication already in progress \u2014 cancel it first.";
          render();
          return;
        }
        oauthConnecting = true;
        state.error = null;
        const thisSession = ++oauthSessionId;
        render();
        const result = await startCliOAuth(providerId);
        if (thisSession !== oauthSessionId || !oauthConnecting) return;
        if (result?.authorize_url) {
          let cleanupSession = function() {
            if (oauthPollTimer === localTimer) oauthPollTimer = null;
            localTimer = null;
            oauthState = null;
            oauthAuthUrl = null;
            oauthConnecting = false;
          }, scheduleOAuthPoll = function() {
            localTimer = setTimeout(async () => {
              try {
                if (thisSession !== oauthSessionId) return;
                const currentState = oauthState;
                if (!currentState || Date.now() - oauthPollStart > OAUTH_POLL_MAX_MS) {
                  cleanupSession();
                  state.error = "OAuth timed out. Please try again.";
                  render();
                  return;
                }
                const poll = await pollCliOAuth(currentState, startedAt, providerId);
                if (thisSession !== oauthSessionId) return;
                if (!oauthConnecting) return;
                if (poll.status === "ok") {
                  cleanupSession();
                  showSuccess(`${label} connected successfully! Models are now available.`);
                  await loadData();
                  tokenCardProvider = providerId;
                  render();
                } else if (poll.status === "error") {
                  cleanupSession();
                  state.error = poll.message || "OAuth failed. Try again or use the chat command.";
                  render();
                } else {
                  if (poll.status === "slow_down") pollDelay = Math.min(pollDelay + 5e3, 3e4);
                  scheduleOAuthPoll();
                }
              } catch (err) {
                cleanupSession();
                state.error = err?.message ?? "OAuth polling failed unexpectedly";
                render();
              }
            }, pollDelay);
            oauthPollTimer = localTimer;
          };
          oauthState = result.state;
          const authUrl = result.authorize_url;
          const startedAt = result.started_at;
          if (!/^https?:\/\//i.test(authUrl)) {
            oauthState = null;
            oauthConnecting = false;
            connectProviderChat(providerId);
            showSuccess(`Connecting ${label}... Check chat for auth instructions.`);
            render();
            return;
          }
          oauthAuthUrl = authUrl;
          try {
            await xai.openUrl(authUrl);
            showSuccess(`OAuth started for ${label}. Complete authentication in the browser tab.`);
          } catch {
            showSuccess(`Could not open browser \u2014 use the link in the authenticating card below.`);
          }
          const oauthPollStart = Date.now();
          const OAUTH_POLL_MAX_MS = 15 * 60 * 1e3;
          let pollDelay = 3e3;
          if (oauthPollTimer) clearTimeout(oauthPollTimer);
          let localTimer = null;
          scheduleOAuthPoll();
        } else {
          oauthConnecting = false;
          connectProviderChat(providerId);
          showSuccess(`Connecting ${label}... Check chat for auth instructions.`);
        }
        render();
      }
      function handleCancelOAuth() {
        ++oauthSessionId;
        if (oauthPollTimer) clearTimeout(oauthPollTimer);
        oauthPollTimer = null;
        oauthState = null;
        oauthAuthUrl = null;
        oauthConnecting = false;
        showSuccess("Authentication cancelled.");
      }
      function render() {
        const tokenCardTitle = tokenCardProvider ? providerLabel(tokenCardProvider) + " OAuth Token" : "OAuth Token";
        const html = `
    <style>${CSS}</style>
    <div class="panel">
      <div class="panel-header">
        <h1 class="panel-title">CLI Proxy</h1>
        <button class="btn btn-secondary" onclick="__refresh()" ${state.loading ? "disabled" : ""}>
          ${state.loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      ${state.error ? `<div class="banner banner-error">${escapeHtml(state.error)}</div>` : ""}
      ${state.success ? `<div class="banner banner-success">${escapeHtml(state.success)}</div>` : ""}

      <!-- Status Card -->
      <div class="card">
        <h2 class="section-heading">Service Status</h2>
        ${state.status ? `
          <div class="config-grid">
            <div class="config-row">
              <span class="config-label">Status</span>
              <span class="badge ${state.status.running ? "badge-active" : "badge-expired"}">
                ${state.status.running ? "Running" : "Stopped"}
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
            ${state.loading ? "Checking service..." : "CLIProxyAPI not reachable. Use <code>@cliproxy status</code> in chat to install and start."}
          </p>
        `}
      </div>

      <!-- Token Management (shown if a CLI subscription provider is connected) -->
      ${state.tokenStatus ? `
      <div class="card">
        <h2 class="section-heading">${escapeHtml(tokenCardTitle)}</h2>
        <div class="config-grid">
          <div class="config-row">
            <span class="config-label">Status</span>
            <span class="badge ${state.tokenStatus.is_expired ? "badge-expired" : "badge-active"}">
              ${state.tokenStatus.is_expired ? "Expired" : "Active"}
            </span>
          </div>
          ${state.tokenStatus.type ? `
          <div class="config-row">
            <span class="config-label">Type</span>
            <span class="config-value">${escapeHtml(state.tokenStatus.type)}</span>
          </div>` : ""}
          ${state.tokenStatus.email ? `
          <div class="config-row">
            <span class="config-label">Email</span>
            <span class="config-value">${escapeHtml(state.tokenStatus.email)}</span>
          </div>` : ""}
          ${state.tokenStatus.access_token_prefix ? `
          <div class="config-row">
            <span class="config-label">Access Token</span>
            <span class="config-value mono">${escapeHtml(state.tokenStatus.access_token_prefix)}...</span>
          </div>` : ""}
          <div class="config-row">
            <span class="config-label">Expires</span>
            <span class="config-value ${state.tokenStatus.is_expired ? "text-danger" : ""}">${formatDate(state.tokenStatus.expired)}</span>
          </div>
          ${state.tokenStatus.last_refresh ? `
          <div class="config-row">
            <span class="config-label">Last Refresh</span>
            <span class="config-value">${formatDate(state.tokenStatus.last_refresh)}</span>
          </div>` : ""}
          <div class="config-row">
            <span class="config-label">Refresh Token</span>
            <span class="config-value">${state.tokenStatus.has_refresh_token ? "Present" : "None"}</span>
          </div>
        </div>

        ${!state.tokenStatus?.has_refresh_token ? `
        <div class="form-card">
          <p class="form-hint" style="color: var(--fg-danger, #ef4444);">No refresh token \u2014 auto-refresh will not work. Re-connect via OAuth to get a refresh token.</p>
        </div>
        ` : ""}

        <!-- Manual token paste (collapsed fallback) -->
        <details class="form-card" ${manualTokenOpen ? "open" : ""} ontoggle="__onTokenToggle()">
          <summary class="form-hint" style="cursor: pointer;">Manual token update (fallback)</summary>
          <div class="form-row" style="margin-top: 8px;">
            <input type="password" id="token-input" class="form-input mono" placeholder="${escapeHtml(tokenCardProvider === "claude" ? "sk-ant-oat01-..." : "Paste OAuth token...")}" value="${escapeHtml(tokenInputDraft)}" oninput="__onTokenInput()" />
            <button class="btn btn-primary" onclick="__updateToken()" ${state.savingToken ? "disabled" : ""}>
              ${state.savingToken ? "Updating..." : "Update"}
            </button>
          </div>
        </details>
      </div>
      ` : ""}

      <!-- OAuth Connecting State (shown above providers for visibility) -->
      ${oauthConnecting ? `
      <div class="card">
        <h2 class="section-heading">Authenticating...</h2>
        <p class="form-hint">Complete the authentication in the browser tab. This will update automatically.</p>
        ${oauthAuthUrl ? `<p class="form-hint"><a href="${escapeHtml(oauthAuthUrl)}" target="_blank" rel="noopener noreferrer" style="color: var(--fg-link, #3b82f6);">Open authentication page</a></p>` : ""}
        <div class="form-row">
          <button class="btn btn-secondary" onclick="__cancelOAuth()">Cancel</button>
        </div>
      </div>
      ` : ""}

      <!-- Provider List -->
      <div class="card">
        <h2 class="section-heading">Connected Providers</h2>
        ${state.providers.length > 0 ? state.providers.map((p) => `
          <div class="provider-card">
            <div class="provider-header">
              <span class="provider-name">${escapeHtml(providerLabel(p.name))}</span>
              <span class="provider-type badge ${p.type === "cli-subscription" ? "badge-cli" : "badge-api"}">${p.type === "cli-subscription" ? "CLI" : "API"}</span>
              <button class="btn btn-danger btn-sm" data-disconnect="${escapeHtml(p.name)}">Disconnect</button>
            </div>
            <div class="model-list">
              ${p.models.map((m) => `<span class="model-tag">${escapeHtml(m.id)}</span>`).join("")}
            </div>
          </div>
        `).join("") : `
          <p class="empty-text">No providers connected. Use the form below or type <code>@cliproxy connect claude</code> in chat.</p>
        `}
      </div>

      <!-- Connect Form -->
      <div class="card">
        <h2 class="section-heading">Connect Provider</h2>
        ${(() => {
          const selDef = PROVIDERS.find((p) => p.id === selectedProviderId);
          const showKeyRow = selDef?.type === "api-key";
          const formDisabled = oauthConnecting || connecting;
          const connectDisabled = formDisabled || !selectedProviderId;
          return `
            <div class="form-row">
              <select id="provider-select" class="form-input" onchange="__onProviderChange()" ${formDisabled ? "disabled" : ""}>
                <option value="">Select a provider...</option>
                ${PROVIDERS.map((p) => `<option value="${p.id}" ${p.id === selectedProviderId ? "selected" : ""}>${escapeHtml(p.label)}</option>`).join("")}
              </select>
            </div>
            ${selDef ? `<div class="form-hint">${escapeHtml(selDef.hint)}</div>` : ""}
            ${showKeyRow ? `
            <div class="form-row">
              <input type="password" id="api-key-input" class="form-input mono" placeholder="Paste your API key..." value="${escapeHtml(apiKeyDraft)}" oninput="__onKeyInput()" />
            </div>` : ""}
            <div class="form-row">
              <button class="btn btn-primary" onclick="__connect()" ${connectDisabled ? "disabled" : ""}>${connecting ? "Connecting..." : selDef ? "Connect " + escapeHtml(selDef.label) : "Connect"}</button>
            </div>`;
        })()}
      </div>
    </div>
  `;
        xai.render(html);
        window.__refresh = loadData;
        window.__updateToken = handleUpdateToken;
        window.__connect = handleConnect;
        window.__onProviderChange = onProviderChange;
        window.__cancelOAuth = handleCancelOAuth;
        window.__onKeyInput = onKeyInput;
        window.__onTokenInput = onTokenInput;
        window.__onTokenToggle = onTokenToggle;
      }
      function onProviderChange() {
        const select = document.getElementById("provider-select");
        if (!select) return;
        selectedProviderId = select.value;
        apiKeyDraft = "";
        render();
      }
      function onKeyInput() {
        const input = document.getElementById("api-key-input");
        if (input) apiKeyDraft = input.value;
      }
      function onTokenInput() {
        const input = document.getElementById("token-input");
        if (input) tokenInputDraft = input.value;
      }
      function onTokenToggle() {
        const details = document.querySelector(".form-card[ontoggle]");
        if (details) manualTokenOpen = details.open;
      }
      function escapeHtml(str) {
        return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      }
      var CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-text-size-adjust: 100%; }

  body {
    font-family: var(--font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    background: var(--surface-base, #0a0a0a);
    color: var(--fg-primary, #e5e5e5);
    font-size: 13px;
    line-height: 1.5;
  }

  .panel { padding: 16px; max-width: 480px; width: 100%; }

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
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    min-height: 36px;
    background: var(--surface-base, #0a0a0a);
    border: 1px solid var(--border-l2, #333);
    border-radius: var(--radius-sm, 6px);
    color: var(--fg-primary, #e5e5e5);
    font-size: 12px;
    outline: none;
    transition: border-color 0.15s;
    -webkit-appearance: none;
    appearance: none;
  }

  .form-input:focus { border-color: var(--fg-link, #3b82f6); }

  select.form-input { cursor: pointer; }
  select.form-input option { background: var(--surface-l1, #141414); }

  .btn {
    padding: 6px 14px;
    min-height: 36px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm, 6px);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s, opacity 0.15s;
    -webkit-appearance: none;
    appearance: none;
    touch-action: manipulation;
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

  .btn-sm { font-size: 11px; padding: 3px 8px; flex-shrink: 0; }

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

  @media (max-width: 600px) {
    .panel { padding: 12px; }
    .panel-title { font-size: 16px; }
    .config-grid { grid-template-columns: 1fr; }
    .config-row { padding: 6px 0; }
    .form-row { flex-direction: column; align-items: stretch; }
    .form-row .btn { width: 100%; }
    .form-input { font-size: 16px; padding: 10px 12px; }
    select.form-input { font-size: 16px; padding: 10px 12px; }
    .btn { padding: 10px 14px; font-size: 14px; }
    .provider-header { flex-wrap: wrap; }
    .model-list { margin-top: 4px; }
    .card { padding: 12px; }
  }

  @media (max-width: 360px) {
    .panel { padding: 8px; }
    .card { padding: 10px; }
    .provider-header { gap: 6px; }
    .model-tag { font-size: 10px; padding: 2px 4px; }
  }
`;
      xai.on("ready", () => {
        state.loading = true;
        render();
        loadData();
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(() => {
          const tag = document.activeElement?.tagName;
          if (tag === "INPUT" || tag === "SELECT") return;
          loadData();
        }, 3e4);
        if (!window.__cliproxyClickRegistered) {
          window.__cliproxyClickRegistered = true;
          document.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-disconnect]");
            if (btn?.dataset.disconnect) handleDisconnect(btn.dataset.disconnect);
          });
        }
      });
      xai.on("chat.message", (msg) => {
        if (msg?.text?.includes?.("@cliproxy")) {
          setTimeout(loadData, 3e3);
        }
      });
      xai.on("cliproxy.oauth.callback", (data) => {
        if (!oauthConnecting || !oauthState) return;
        if (!data?.state || data.state === oauthState) {
          let immediateOAuthPoll = function() {
            oauthPollTimer = setTimeout(async () => {
              if (!oauthConnecting || !oauthState) return;
              try {
                const poll = await pollCliOAuth(oauthState, "", data?.provider ?? "");
                if (poll.status === "ok") {
                  const label = PROVIDERS.find((p) => p.id === selectedProviderId)?.label ?? data?.provider ?? "";
                  oauthState = null;
                  oauthAuthUrl = null;
                  oauthConnecting = false;
                  oauthPollTimer = null;
                  showSuccess(`${label} connected successfully! Models are now available.`);
                  await loadData();
                  tokenCardProvider = data?.provider ?? selectedProviderId;
                  render();
                } else if (++retries < maxRetries) {
                  immediateOAuthPoll();
                }
              } catch {
              }
            }, 500 + retries * 1e3);
          };
          if (oauthPollTimer) clearTimeout(oauthPollTimer);
          let retries = 0;
          const maxRetries = 5;
          immediateOAuthPoll();
        }
      });
    }
  });
  require_panel();
})();
