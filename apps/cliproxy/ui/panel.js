"use strict";
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
  async function submitOAuthPaste(pasted, expectedState) {
    const trimmed = (pasted || "").trim();
    if (!trimmed) return { ok: false, error: "Paste the redirect URL or code" };
    let code = "";
    let state = "";
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        const u = new URL(trimmed);
        code = (u.searchParams.get("code") || "").split("#")[0].trim();
        state = (u.searchParams.get("state") || "").trim();
        const err = u.searchParams.get("error");
        if (err) return { ok: false, error: u.searchParams.get("error_description") || err };
      } catch {
        return { ok: false, error: "Invalid URL" };
      }
    } else if (trimmed.includes("=")) {
      const qs = new URLSearchParams(trimmed.replace(/^\?/, ""));
      code = (qs.get("code") || "").split("#")[0].trim();
      state = (qs.get("state") || "").trim();
    } else {
      code = trimmed.split("#")[0].trim();
    }
    if (!state) state = (expectedState || "").trim();
    if (!code) return { ok: false, error: "Could not find code in paste" };
    if (!state) return { ok: false, error: "Could not find state in paste" };
    if (expectedState && state !== expectedState) {
      return { ok: false, error: "State mismatch \u2014 paste may be from a different login attempt" };
    }
    try {
      const result = await xai.cliproxy.submitCallback(state, code);
      if (result?.ok) return { ok: true };
      return { ok: false, error: result?.error ?? "Callback submission failed" };
    } catch (err) {
      return { ok: false, error: err?.message ?? "Callback submission failed" };
    }
  }
  var BASE, CLI_PROVIDERS;
  var init_api = __esm({
    "apps/cliproxy/ui/api.ts"() {
      "use strict";
      BASE = "http://localhost:4001";
      CLI_PROVIDERS = /* @__PURE__ */ new Set(["claude", "gemini", "codex", "qwen", "iflow"]);
    }
  });

  // apps/cliproxy/ui/panel.ts
  var require_panel = __commonJS({
    "apps/cliproxy/ui/panel.ts"() {
      init_api();
      var PROVIDERS = [
        { id: "claude", label: "Claude Code", type: "cli-subscription", hint: "Browser OAuth \u2014 no API key needed", icon: "\u{1F9E0}" },
        { id: "codex", label: "OpenAI Codex", type: "cli-subscription", hint: "Browser OAuth \u2014 GPT models", icon: "\u{1F9E9}" },
        { id: "gemini", label: "Gemini CLI", type: "cli-subscription", hint: "Browser OAuth \u2014 no API key needed", icon: "\u2728" },
        { id: "qwen", label: "Qwen Code", type: "cli-subscription", hint: "Browser OAuth \u2014 no API key needed", icon: "\u{1F396}\uFE0F" },
        { id: "iflow", label: "iFlow", type: "cli-subscription", hint: "Browser OAuth \u2014 no API key needed", icon: "\u{1F30A}" },
        { id: "zai", label: "Z.ai / Zhipu", type: "api-key", hint: "Get key at z.ai", icon: "\u{1F4A1}" },
        { id: "grok", label: "xAI Grok", type: "api-key", hint: "Get key at console.x.ai", icon: "\u{1F916}" },
        { id: "openai", label: "OpenAI", type: "api-key", hint: "Get key at platform.openai.com", icon: "\u{1F7E2}" },
        { id: "anthropic", label: "Anthropic", type: "api-key", hint: "Get key at console.anthropic.com", icon: "\u{1F53A}" },
        { id: "gemini-api", label: "Gemini API", type: "api-key", hint: "Get key at aistudio.google.com", icon: "\u{1F48E}" },
        { id: "groq", label: "Groq", type: "api-key", hint: "Get key at console.groq.com", icon: "\u26A1" },
        { id: "mistral", label: "Mistral", type: "api-key", hint: "Get key at console.mistral.ai", icon: "\u{1F32C}\uFE0F" }
      ];
      function providerIcon(id) {
        return PROVIDERS.find((p) => p.id === id)?.icon ?? "\u{1F50C}";
      }
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
      var pasteDraft = "";
      var submittingPaste = false;
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
          let cleanupSession2 = function() {
            if (oauthPollTimer === localTimer) oauthPollTimer = null;
            localTimer = null;
            oauthState = null;
            oauthAuthUrl = null;
            oauthConnecting = false;
            pasteDraft = "";
          }, scheduleOAuthPoll2 = function() {
            localTimer = setTimeout(async () => {
              try {
                if (thisSession !== oauthSessionId) return;
                const currentState = oauthState;
                if (!currentState || Date.now() - oauthPollStart > OAUTH_POLL_MAX_MS) {
                  cleanupSession2();
                  state.error = "OAuth timed out. Please try again.";
                  render();
                  return;
                }
                const poll = await pollCliOAuth(currentState, startedAt, providerId);
                if (thisSession !== oauthSessionId) return;
                if (!oauthConnecting) return;
                if (poll.status === "ok") {
                  cleanupSession2();
                  showSuccess(`${label} connected successfully! Models are now available.`);
                  await loadData();
                  tokenCardProvider = providerId;
                  render();
                } else if (poll.status === "error") {
                  cleanupSession2();
                  state.error = poll.message || "OAuth failed. Try again or use the chat command.";
                  render();
                } else {
                  if (poll.status === "slow_down") pollDelay = Math.min(pollDelay + 5e3, 3e4);
                  scheduleOAuthPoll2();
                }
              } catch (err) {
                cleanupSession2();
                state.error = err?.message ?? "OAuth polling failed unexpectedly";
                render();
              }
            }, pollDelay);
            oauthPollTimer = localTimer;
          };
          var cleanupSession = cleanupSession2, scheduleOAuthPoll = scheduleOAuthPoll2;
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
          scheduleOAuthPoll2();
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
        pasteDraft = "";
        showSuccess("Authentication cancelled.");
      }
      async function handleSubmitPaste() {
        const pasted = pasteDraft.trim();
        if (!pasted || submittingPaste) return;
        submittingPaste = true;
        state.error = null;
        render();
        try {
          const result = await submitOAuthPaste(pasted, oauthState);
          if (result.ok) {
            pasteDraft = "";
            showSuccess("Callback submitted. Completing authentication...");
          } else {
            state.error = result.error ?? "Callback submission failed";
            state.success = null;
          }
        } catch (err) {
          state.error = err?.message ?? "Callback submission failed";
          state.success = null;
        } finally {
          submittingPaste = false;
          render();
        }
      }
      function onPasteInput() {
        const input = document.getElementById("oauth-paste-input");
        if (!input) return;
        const prev = pasteDraft;
        pasteDraft = input.value;
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
        }
      }
      function render() {
        const tokenCardTitle = tokenCardProvider ? providerLabel(tokenCardProvider) + " OAuth Token" : "OAuth Token";
        const connectedIds = new Set(state.providers.map((p) => p.name));
        const unconnected = PROVIDERS.filter((p) => !connectedIds.has(p.id));
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
          <button class="btn-refresh" onclick="__refresh()" ${state.loading ? "disabled" : ""} title="Refresh">&#x21bb;</button>
        </div>
      </div>

      ${state.error ? `<div class="banner banner-error">${escapeHtml(state.error)}</div>` : ""}
      ${state.success ? `<div class="banner banner-success">${escapeHtml(state.success)}</div>` : ""}

      <!-- Status Card -->
      <div class="section-card">
        <div class="section-title">Service Status</div>
        ${state.status ? `
          <div class="config-row">
            <span class="config-label">Status</span>
            <span class="status-wrap">
              <span class="app-dot ${running ? "app-dot--running" : "app-dot--error"}"></span>
              <span class="config-value">${running ? "Running" : "Stopped"}</span>
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
              ${state.loading ? "Checking service..." : "CLIProxyAPI not reachable. Use <code>@cliproxy status</code> in chat to install and start."}
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
            <span class="app-dot ${state.tokenStatus.is_expired ? "app-dot--error" : "app-dot--running"}"></span>
            <span class="badge ${state.tokenStatus.is_expired ? "badge-expired" : "badge-active"}">
              ${state.tokenStatus.is_expired ? "Expired" : "Active"}
            </span>
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

        ${!state.tokenStatus?.has_refresh_token ? (() => {
          const provider = tokenCardProvider || "this provider";
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
          if (!expiredAt) return "";
          const expiresMs = new Date(expiredAt).getTime();
          if (!Number.isFinite(expiresMs)) return "";
          const msUntil = expiresMs - Date.now();
          const FIVE_MIN_MS = 5 * 60 * 1e3;
          if (msUntil <= 0 || msUntil > FIVE_MIN_MS) return "";
          const minutes = Math.max(1, Math.ceil(msUntil / 6e4));
          const provider = tokenCardProvider || "this provider";
          const label = providerLabel(provider);
          return `
          <div class="inline-notice inline-notice--warn">
            <p>Token for ${escapeHtml(label)} expires in ~${minutes} minute${minutes === 1 ? "" : "s"}. If auto-refresh fails, re-connect here to avoid auth errors mid-session.</p>
            <button class="btn-action btn-action--secondary" onclick="__reconnectCurrentProvider()">
              Re-connect ${escapeHtml(label)}
            </button>
          </div>
          `;
        })()}

        <!-- Manual token paste (collapsed fallback) -->
        <details class="inline-expander" ${manualTokenOpen ? "open" : ""} ontoggle="__onTokenToggle()">
          <summary>Manual token update (fallback)</summary>
          <div class="form-row">
            <input type="password" id="token-input" class="form-input mono" placeholder="${escapeHtml(tokenCardProvider === "claude" ? "sk-ant-oat01-..." : "Paste OAuth token...")}" value="${escapeHtml(tokenInputDraft)}" oninput="__onTokenInput()" />
            <button class="btn-action btn-action--primary" onclick="__updateToken()" ${state.savingToken ? "disabled" : ""}>
              ${state.savingToken ? "Updating..." : "Update"}
            </button>
          </div>
        </details>
      </div>
      ` : ""}

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
        </div>` : ""}

        <div class="inline-notice">
          <p><strong>Page stuck on "this site can't be reached"?</strong> That's expected \u2014 copy the full URL from the address bar and paste it below.</p>
          <div class="form-row">
            <input type="text" id="oauth-paste-input" class="form-input mono" placeholder="http://localhost:54545/callback?code=...&amp;state=..." value="${escapeHtml(pasteDraft)}" oninput="__onPasteInput()" ${submittingPaste ? "disabled" : ""} />
          </div>
          <div class="form-row">
            <button class="btn-action btn-action--secondary" onclick="__pasteFromClipboard()" ${submittingPaste ? "disabled" : ""}>Paste from clipboard</button>
            <button class="btn-action btn-action--primary" onclick="__submitPaste()" ${submittingPaste || !pasteDraft.trim() ? "disabled" : ""}>
              ${submittingPaste ? "Submitting..." : "Submit URL"}
            </button>
            <button class="btn-action btn-action--danger" onclick="__cancelOAuth()" ${submittingPaste ? "disabled" : ""}>Cancel</button>
          </div>
        </div>
      </div>
      ` : ""}

      <!-- Connected Providers -->
      <div class="section-card">
        <div class="section-title">Connected Providers</div>
        ${state.providers.length > 0 ? state.providers.map((p) => {
          const def = PROVIDERS.find((d) => d.id === p.name);
          const kind = p.type === "cli-subscription" ? "CLI" : "API KEY";
          return `
          <div class="app-card">
            <div class="app-card-main">
              <div class="app-icon">${providerIcon(p.name)}</div>
              <span class="app-dot app-dot--running" title="Connected"></span>
              <div class="app-info">
                <div class="app-name">${escapeHtml(providerLabel(p.name))}</div>
                <div class="app-meta">
                  <span class="app-kind-badge ${p.type === "cli-subscription" ? "app-kind-badge--cli" : "app-kind-badge--api"}">${kind}</span>
                  <span class="app-status app-status--running">${p.models.length} model${p.models.length === 1 ? "" : "s"}</span>
                </div>
              </div>
              <div class="app-actions">
                <button class="btn-action btn-action--danger" data-disconnect="${escapeHtml(p.name)}">Disconnect</button>
              </div>
            </div>
            ${def ? `<div class="app-description">${escapeHtml(def.hint)}</div>` : ""}
          </div>
          `;
        }).join("") : `
          <div class="app-card">
            <p class="empty-text">No providers connected. Pick one below or type <code>@cliproxy connect claude</code> in chat.</p>
          </div>
        `}
      </div>

      <!-- Connect Provider (single row per provider) -->
      <div class="section-card">
        <div class="section-title">Connect Provider</div>
        ${unconnected.length > 0 ? unconnected.map((def) => {
          const kind = def.type === "cli-subscription" ? "CLI" : "API KEY";
          const isSelected = selectedProviderId === def.id && def.type === "api-key";
          const formDisabled = oauthConnecting || connecting;
          const keyDisabled = formDisabled && !isSelected;
          const cta = def.type === "cli-subscription" ? oauthConnecting && selectedProviderId === def.id ? "Connecting..." : "Connect" : connecting && selectedProviderId === def.id ? "Connecting..." : "Connect";
          return `
          <div class="app-card">
            <div class="app-card-main">
              <div class="app-icon">${providerIcon(def.id)}</div>
              <span class="app-dot" title="Not connected"></span>
              <div class="app-info">
                <div class="app-name">${escapeHtml(def.label)}</div>
                <div class="app-meta">
                  <span class="app-kind-badge ${def.type === "cli-subscription" ? "app-kind-badge--cli" : "app-kind-badge--api"}">${kind}</span>
                  <span class="app-status">${escapeHtml(def.hint)}</span>
                </div>
              </div>
              <div class="app-actions">
                <button class="btn-action btn-action--primary" onclick="__startConnect('${def.id}')" ${keyDisabled ? "disabled" : ""}>${cta}</button>
              </div>
            </div>
            ${isSelected ? `
            <div class="inline-expander-body">
              <div class="form-row">
                <input type="password" id="api-key-input" class="form-input mono" placeholder="Paste your API key..." value="${escapeHtml(apiKeyDraft)}" oninput="__onKeyInput()" ${connecting ? "disabled" : ""} />
                <button class="btn-action btn-action--primary" onclick="__submitApiKey('${def.id}')" ${connecting || !apiKeyDraft.trim() ? "disabled" : ""}>
                  ${connecting ? "Saving..." : "Save key"}
                </button>
                <button class="btn-action btn-action--secondary" onclick="__cancelApiKey()" ${connecting ? "disabled" : ""}>Cancel</button>
              </div>
            </div>` : ""}
          </div>
          `;
        }).join("") : `
          <div class="app-card">
            <p class="empty-text">All known providers are connected.</p>
          </div>
        `}
      </div>
    </div>
  `;
        xai.render(html);
        window.__refresh = loadData;
        window.__updateToken = handleUpdateToken;
        window.__cancelOAuth = handleCancelOAuth;
        window.__onKeyInput = onKeyInput;
        window.__onTokenInput = onTokenInput;
        window.__onTokenToggle = onTokenToggle;
        window.__onPasteInput = onPasteInput;
        window.__submitPaste = handleSubmitPaste;
        window.__pasteFromClipboard = handlePasteFromClipboard;
        window.__startConnect = (id) => {
          const def = PROVIDERS.find((p) => p.id === id);
          if (!def) return;
          if (def.type === "api-key") {
            if (selectedProviderId === id) {
              selectedProviderId = "";
              apiKeyDraft = "";
            } else {
              selectedProviderId = id;
              apiKeyDraft = "";
            }
            render();
          } else {
            selectedProviderId = id;
            handleConnect();
          }
        };
        window.__submitApiKey = (id) => {
          selectedProviderId = id;
          handleConnect();
        };
        window.__cancelApiKey = () => {
          selectedProviderId = "";
          apiKeyDraft = "";
          render();
        };
        window.__reconnectCurrentProvider = () => {
          if (!tokenCardProvider) return;
          selectedProviderId = tokenCardProvider;
          handleConnect();
        };
      }
      function onKeyInput() {
        const input = document.getElementById("api-key-input");
        if (!input) return;
        const prev = apiKeyDraft;
        apiKeyDraft = input.value;
        if (!prev.trim() !== !apiKeyDraft.trim()) render();
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
    font-size: 14px;
    line-height: 1.5;
  }

  .panel {
    /* Fill sandbox iframe width \u2014 the service-host area is already width-
       constrained by the shell. Capping to 700px inside a wide iframe
       leaves huge gutters and makes the content look tiny. */
    max-width: none;
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
    content: '\u25B8';
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
          let immediateOAuthPoll2 = function() {
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
                  pasteDraft = "";
                  showSuccess(`${label} connected successfully! Models are now available.`);
                  await loadData();
                  tokenCardProvider = data?.provider ?? selectedProviderId;
                  render();
                } else if (++retries < maxRetries) {
                  immediateOAuthPoll2();
                } else {
                  oauthState = null;
                  oauthAuthUrl = null;
                  oauthConnecting = false;
                  oauthPollTimer = null;
                  state.error = "Authentication confirmation timed out. Please try again.";
                  render();
                }
              } catch {
                oauthState = null;
                oauthAuthUrl = null;
                oauthConnecting = false;
                oauthPollTimer = null;
                state.error = "Authentication confirmation failed unexpectedly.";
                render();
              }
            }, 500 + retries * 1e3);
          };
          var immediateOAuthPoll = immediateOAuthPoll2;
          if (oauthPollTimer) clearTimeout(oauthPollTimer);
          let retries = 0;
          const maxRetries = 5;
          immediateOAuthPoll2();
        }
      });
    }
  });
  require_panel();
})();
