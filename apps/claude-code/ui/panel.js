(() => {
'use strict';

/**
 * Claude Code panel — sandbox iframe UI
 *
 * Terminal-style interface with:
 * - Status card (server health, active queries, API key)
 * - Command buttons (Status, Start, Stop, Restart, Logs, Sessions)
 * - Prompt input for Claude Code queries
 * - Scrollable output history
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SERVER = 'http://localhost:3457';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  output: [],       // { type: 'system'|'cmd'|'response'|'error'|'info', text }
  running: false,
  draft: '',
  sessionId: null,  // current Agent SDK session (set after first query)
  health: null,     // last /health response
  sessions: [],     // past sessions from /sessions
  showSessions: false,
};

let pollTimer = null;

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMd(text) {
  // Fenced code blocks
  let html = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) =>
    `<pre><code>${esc(code.trimEnd())}</code></pre>`
  );
  // Inline code
  html = html.replace(/`([^`\n]+)`/g, (_m, code) =>
    `<code class="il">${esc(code)}</code>`
  );
  // Bold (escape capture to prevent XSS from AI responses)
  html = html.replace(/\*\*([^*\n]+)\*\*/g, (_m, t) => `<strong>${esc(t)}</strong>`);
  // Newlines
  html = html.replace(/\n/g, '<br>');
  return html;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function checkHealth() {
  try {
    const resp = await xai.http(`${SERVER}/health`);
    state.health = resp.data;
    return true;
  } catch {
    state.health = null;
    return false;
  }
}

async function loadSessions() {
  try {
    const resp = await xai.http(`${SERVER}/sessions`);
    state.sessions = (resp.data && resp.data.sessions) || [];
  } catch {
    state.sessions = [];
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function buildStatusCard() {
  if (!state.health) {
    return `
      <div class="card card-error">
        <div class="card-row">
          <span class="label">Server</span>
          <span class="badge badge-off">Offline</span>
        </div>
        <p class="hint">Use <code>@claude-code start</code> in chat or click Start below.</p>
      </div>`;
  }
  const h = state.health;
  return `
    <div class="card">
      <div class="card-row">
        <span class="label">Server</span>
        <span class="badge badge-on">Running</span>
      </div>
      <div class="card-row">
        <span class="label">Port</span>
        <span class="val">${h.port}</span>
      </div>
      <div class="card-row">
        <span class="label">CWD</span>
        <span class="val mono">${esc(h.cwd || '~')}</span>
      </div>
      <div class="card-row">
        <span class="label">Active queries</span>
        <span class="val">${h.activeQueries || 0}</span>
      </div>
      <div class="card-row">
        <span class="label">API Key</span>
        <span class="badge ${h.hasApiKey ? 'badge-on' : 'badge-off'}">
          ${h.hasApiKey ? 'Set' : 'Missing'}
        </span>
      </div>
    </div>`;
}

function buildCommandBar() {
  const online = !!state.health;
  return `
    <div class="cmd-bar">
      <button class="chip" onclick="__cmd('status')">Status</button>
      <button class="chip" onclick="__cmd('start')" ${online ? 'disabled' : ''}>Start</button>
      <button class="chip" onclick="__cmd('stop')" ${!online ? 'disabled' : ''}>Stop</button>
      <button class="chip" onclick="__cmd('restart')">Restart</button>
      <button class="chip" onclick="__cmd('logs')">Logs</button>
      <button class="chip ${state.showSessions ? 'chip-active' : ''}" onclick="__toggleSessions()">Sessions</button>
    </div>`;
}

function buildSessionList() {
  if (!state.showSessions) return '';
  if (state.sessions.length === 0) {
    return `<div class="card"><p class="hint">No past sessions found.</p></div>`;
  }
  const items = state.sessions.map(s => `
    <div class="session-row" onclick="__resumeSession('${esc(s.sessionId)}')">
      <span class="session-id mono">${esc(s.sessionId.slice(0, 12))}…</span>
      <span class="session-cwd">${esc(s.summary || s.cwd || '~')}</span>
      ${s.tag ? `<span class="session-tag">${esc(s.tag)}</span>` : ''}
    </div>
  `).join('');
  return `<div class="card"><div class="section-heading">Sessions</div>${items}</div>`;
}

function buildOutput() {
  return state.output.map(entry => {
    switch (entry.type) {
      case 'system':
        return `<div class="e e-sys">${esc(entry.text)}</div>`;
      case 'cmd':
        return `<div class="e e-cmd"><span class="ps">❯</span> ${esc(entry.text)}</div>`;
      case 'response':
        return `<div class="e e-res">${renderMd(entry.text)}</div>`;
      case 'error':
        return `<div class="e e-err">✖ ${esc(entry.text)}</div>`;
      case 'info':
        return `<div class="e e-info">${renderMd(entry.text)}</div>`;
      default:
        return '';
    }
  }).join('');
}

function render() {
  const spinnerHtml = state.running
    ? `<div class="spinner">
         <span class="dot">●</span><span class="dot">●</span><span class="dot">●</span>
         <span class="spin-text">Claude Code is working…</span>
       </div>`
    : '';

  const sessionBadge = state.sessionId
    ? `<span class="session-badge" title="${esc(state.sessionId)}">
         session: ${esc(state.sessionId.slice(0, 8))}…
       </span>`
    : '';

  xai.render(`
    <style>${CSS}</style>
    <div class="panel">
      <div class="header">
        <span class="title">Claude Code</span>
        ${sessionBadge}
      </div>

      ${buildStatusCard()}
      ${buildCommandBar()}
      ${buildSessionList()}

      <div class="output" id="output">
        ${buildOutput()}
        ${spinnerHtml}
      </div>

      <div class="input-row">
        <span class="ps-main">❯</span>
        <input
          id="cmd-input"
          class="cmd-input"
          type="text"
          autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
          placeholder="${state.running ? 'working…' : 'prompt or command'}"
          value="${esc(state.draft)}"
          ${state.running ? 'disabled' : ''}
        />
        <button class="btn-run" onclick="__run()" ${state.running ? 'disabled' : ''}>
          ${state.running ? '…' : '↵'}
        </button>
        ${state.running ? '<button class="btn-stop" onclick="__stop()">■</button>' : ''}
      </div>
    </div>
  `);

  // Re-bind globals
  window.__run = run;
  window.__stop = stopQuery;
  window.__cmd = runCommand;
  window.__toggleSessions = toggleSessions;
  window.__resumeSession = resumeSession;

  // Scroll + focus
  const out = document.getElementById('output');
  if (out) out.scrollTop = out.scrollHeight;

  const input = document.getElementById('cmd-input');
  if (input) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !state.running) run();
    });
    input.addEventListener('input', () => { state.draft = input.value; });
    if (!state.running) input.focus();
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function run() {
  const input = document.getElementById('cmd-input');
  const text = (input ? input.value : state.draft).trim();
  if (!text || state.running) return;

  state.draft = '';
  state.running = true;
  state.output.push({ type: 'cmd', text });
  render();

  try {
    const resp = await xai.http(`${SERVER}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: text,
        sessionId: state.sessionId,
      }),
    });

    if (resp.data && resp.data.ok) {
      if (resp.data.sessionId) state.sessionId = resp.data.sessionId;
      state.output.push({ type: 'response', text: resp.data.output || '(no output)' });
    } else {
      state.output.push({ type: 'error', text: (resp.data && resp.data.error) || 'Unknown error' });
    }
  } catch (err) {
    state.health = null;
    state.output.push({
      type: 'error',
      text: 'Could not reach Claude Code server: ' + (err && err.message ? err.message : String(err)),
    });
  }

  state.running = false;
  await checkHealth();
  render();
}

async function stopQuery() {
  if (!state.sessionId) return;
  try {
    await xai.http(`${SERVER}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId }),
    });
    state.output.push({ type: 'system', text: 'Stop signal sent.' });
  } catch {
    state.output.push({ type: 'error', text: 'Could not send stop signal.' });
  }
  state.running = false;
  render();
}

async function runCommand(cmd) {
  // Route management commands through chat (manifest commands handle them)
  xai.chat.send(`@claude-code ${cmd}`);
  state.output.push({ type: 'info', text: `Sent \`@claude-code ${cmd}\` to chat.` });

  // Refresh health after a delay (give the command time to execute)
  setTimeout(async () => {
    await checkHealth();
    render();
  }, 3000);

  render();
}

async function toggleSessions() {
  state.showSessions = !state.showSessions;
  if (state.showSessions) await loadSessions();
  render();
}

async function resumeSession(sessionId) {
  state.sessionId = sessionId;
  state.showSessions = false;
  state.output.push({ type: 'system', text: `Resumed session ${sessionId.slice(0, 12)}…` });
  render();
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  html, body {
    height: 100%;
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 13px;
    background: var(--surface-base, #0a0a0a);
    color: var(--fg-primary, #e0e0e0);
    line-height: 1.5;
  }

  .panel {
    display: flex;
    flex-direction: column;
    height: 100vh;
    padding: 12px;
  }

  /* ---- header ---- */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }

  .title {
    font-size: 13px;
    font-weight: 700;
    color: #a78bfa;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .session-badge {
    font-size: 10px;
    color: var(--fg-tertiary, #555);
    background: var(--surface-l1, #141414);
    border: 1px solid var(--border-l1, #222);
    padding: 2px 6px;
    border-radius: 4px;
  }

  /* ---- status card ---- */
  .card {
    background: var(--surface-l1, #141414);
    border: 1px solid var(--border-l1, #222);
    border-radius: 6px;
    padding: 10px 12px;
    margin-bottom: 8px;
    font-size: 12px;
  }

  .card-error { border-color: rgba(248,113,113,0.25); }

  .card-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 3px 0;
  }

  .label { color: var(--fg-secondary, #888); }
  .val { color: var(--fg-primary, #e0e0e0); }
  .mono { font-family: inherit; font-size: 11px; }

  .badge {
    display: inline-block;
    padding: 1px 7px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 600;
  }

  .badge-on { background: rgba(34,197,94,0.15); color: #22c55e; }
  .badge-off { background: rgba(248,113,113,0.15); color: #f87171; }

  .hint {
    color: var(--fg-tertiary, #555);
    font-size: 11px;
    margin-top: 6px;
  }

  .hint code {
    background: var(--surface-l2, #1e1e1e);
    padding: 1px 4px;
    border-radius: 3px;
  }

  .section-heading {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--fg-tertiary, #666);
    margin-bottom: 6px;
  }

  /* ---- command bar ---- */
  .cmd-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 10px;
  }

  .chip {
    background: var(--surface-l1, #141414);
    border: 1px solid var(--border-l1, #262626);
    color: var(--fg-secondary, #aaa);
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 11px;
    font-family: inherit;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
    -webkit-appearance: none;
    appearance: none;
  }

  .chip:hover:not(:disabled) { border-color: #a78bfa; color: #a78bfa; }
  .chip:disabled { opacity: 0.35; cursor: not-allowed; }
  .chip-active { border-color: #a78bfa; color: #a78bfa; }

  /* ---- sessions list ---- */
  .session-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 0;
    border-bottom: 1px solid var(--border-l1, #1e1e1e);
    cursor: pointer;
    transition: background 0.1s;
  }

  .session-row:hover { background: rgba(167,139,250,0.06); }
  .session-row:last-child { border-bottom: none; }
  .session-id { color: #a78bfa; font-size: 11px; flex-shrink: 0; }
  .session-cwd { color: var(--fg-secondary, #888); font-size: 11px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .session-tag { color: var(--fg-tertiary, #555); font-size: 10px; background: var(--surface-l2, #1e1e1e); padding: 1px 5px; border-radius: 3px; }

  /* ---- output area ---- */
  .output {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
    scroll-behavior: smooth;
  }

  .e { margin-bottom: 10px; }
  .e-sys { color: var(--fg-tertiary, #555); font-style: italic; font-size: 12px; }
  .e-cmd { color: #22c55e; font-weight: 700; }
  .ps { color: #22c55e; margin-right: 6px; }

  .e-res {
    color: var(--fg-primary, #d4d4d4);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .e-res code.il {
    background: rgba(167,139,250,0.15);
    color: #a78bfa;
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 12px;
  }

  .e-res pre {
    background: #111;
    border: 1px solid #222;
    border-radius: 6px;
    padding: 10px 12px;
    margin: 6px 0;
    overflow-x: auto;
    white-space: pre;
    word-break: normal;
  }

  .e-res pre code { background: none; color: #d4d4d4; padding: 0; font-size: 12px; }
  .e-res strong { color: #fff; font-weight: 700; }

  .e-err { color: #f87171; word-break: break-word; }

  .e-info {
    color: var(--fg-secondary, #aaa);
    font-size: 12px;
  }

  .e-info code.il {
    background: rgba(167,139,250,0.15);
    color: #a78bfa;
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 11px;
  }

  /* ---- spinner ---- */
  .spinner {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 10px;
  }

  .dot {
    color: #a78bfa;
    font-size: 10px;
    animation: blink 1.2s infinite;
    opacity: 0.3;
  }

  .dot:nth-child(2) { animation-delay: 0.4s; }
  .dot:nth-child(3) { animation-delay: 0.8s; }

  @keyframes blink {
    0%, 100% { opacity: 0.2; }
    50%       { opacity: 1;   }
  }

  .spin-text {
    font-size: 12px;
    color: var(--fg-tertiary, #555);
    margin-left: 6px;
    font-style: italic;
  }

  /* ---- input row ---- */
  .input-row {
    display: flex;
    align-items: center;
    gap: 8px;
    border-top: 1px solid #1e1e1e;
    padding-top: 10px;
    flex-shrink: 0;
  }

  .ps-main {
    color: #a78bfa;
    font-size: 15px;
    flex-shrink: 0;
    line-height: 1;
  }

  .cmd-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: var(--fg-primary, #e0e0e0);
    font-family: inherit;
    font-size: 13px;
    caret-color: #a78bfa;
    min-width: 0;
  }

  .cmd-input::placeholder { color: #333; }
  .cmd-input:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-run {
    background: transparent;
    border: 1px solid #2a2a2a;
    color: #555;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    flex-shrink: 0;
    transition: border-color 0.15s, color 0.15s;
    -webkit-appearance: none;
    appearance: none;
  }

  .btn-run:hover:not(:disabled) { border-color: #a78bfa; color: #a78bfa; }
  .btn-run:disabled { opacity: 0.35; cursor: not-allowed; }

  .btn-stop {
    background: rgba(248,113,113,0.1);
    border: 1px solid rgba(248,113,113,0.3);
    color: #f87171;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    flex-shrink: 0;
    -webkit-appearance: none;
    appearance: none;
  }

  .btn-stop:hover { background: rgba(248,113,113,0.2); }

  /* ---- scrollbar ---- */
  .output::-webkit-scrollbar { width: 4px; }
  .output::-webkit-scrollbar-track { background: transparent; }
  .output::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 2px; }

  /* ---- mobile ---- */
  @media (max-width: 480px) {
    .panel { padding: 8px; }
    .cmd-input { font-size: 16px; }
    .cmd-bar { gap: 4px; }
    .chip { padding: 6px 8px; font-size: 12px; }
    .card-row { flex-wrap: wrap; gap: 4px; }
  }
`;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

xai.on('ready', async () => {
  const ok = await checkHealth();
  if (ok) {
    state.output.push({
      type: 'system',
      text: 'Claude Code ready. Type a prompt — files, bash, and tools are available.',
    });
  } else {
    state.output.push({
      type: 'system',
      text: 'Claude Code server not running. Use Start or @claude-code start.',
    });
  }
  render();

  // Poll health every 30 seconds
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'SELECT')) return;
    await checkHealth();
    render();
  }, 30000);
});

xai.on('chat.message', msg => {
  if (msg && msg.text && msg.text.includes('@claude-code')) {
    setTimeout(async () => {
      await checkHealth();
      render();
    }, 3000);
  }
});

})();
