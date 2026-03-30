#!/usr/bin/env node
'use strict';

/**
 * bridge.js — WebSocket bridge between the xAI Workspace router and the local
 * OpenClaw gateway.
 *
 * Architecture:
 *   ┌──────────┐   outbound WS    ┌──────────┐   local WS    ┌──────────────┐
 *   │  Router   │ ←──────────────→ │  Bridge  │ ←───────────→ │ OpenClaw GW  │
 *   │ /ws/gw    │                  │  (this)  │               │ localhost:PORT│
 *   └──────────┘                   └──────────┘               └──────────────┘
 *
 * Responsibilities:
 *   1. Authenticate with router via gateway_auth (instanceId + instanceToken)
 *   2. Relay JSON-RPC requests (chat.send etc.) from router → local gateway
 *   3. Relay events (delta, final, error) from local gateway → router
 *   4. Execute shell commands (exec) requested by router
 *   5. Apply config updates (config_update) to openclaw.json
 *   6. Auto-reconnect both connections with exponential backoff
 */

const WebSocket = require('ws');
const { spawn, execSync } = require('child_process');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ── Configuration ────────────────────────────────────────────────────────────

// Load secrets.env — simple KEY=value format (no quotes needed, no multi-line values)
function loadSecretsEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1).replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

loadSecretsEnv('/etc/openclaw/secrets.env');

const ROUTER_URL     = process.env.ROUTER_URL;
const INSTANCE_ID    = process.env.INSTANCE_ID;
const INSTANCE_TOKEN = process.env.INSTANCE_TOKEN;
const PORT           = parseInt(process.env.PORT || '19001', 10);
const GW_PASSWORD    = process.env.GW_PASSWORD || '';
const CLIENT_USER    = process.env.CLIENT_USER || '';
const HOME_DIR       = process.env.HOME || `/home/${CLIENT_USER}`;
const HEALTH_PORT    = parseInt(process.env.BRIDGE_HEALTH_PORT || '19099', 10);

if (!ROUTER_URL)     { console.error('[bridge] ROUTER_URL not set');     process.exit(1); }
if (!INSTANCE_ID)    { console.error('[bridge] INSTANCE_ID not set');    process.exit(1); }
if (!INSTANCE_TOKEN) { console.error('[bridge] INSTANCE_TOKEN not set'); process.exit(1); }

const OC_CONFIG_PATH = path.join(HOME_DIR, '.openclaw', 'openclaw.json');

// ── Constants ────────────────────────────────────────────────────────────────

const INITIAL_BACKOFF    = 1000;
const MAX_BACKOFF        = 60000;
const SHUTDOWN_GRACE_MS  = 1500;
const EXEC_TIMEOUT_MS    = 30000;
const EXEC_MAX_BUFFER    = 1024 * 1024;

function backoff(attempt) {
  const delay = Math.min(INITIAL_BACKOFF * Math.pow(2, attempt), MAX_BACKOFF);
  return delay * (0.75 + Math.random() * 0.5); // ±25% jitter
}

// ── Router connection (uplink) ───────────────────────────────────────────────

let routerWs = null;
let routerReconnectAttempt = 0;
let routerReconnectTimer = null;

function connectRouter() {
  if (routerReconnectTimer) { clearTimeout(routerReconnectTimer); routerReconnectTimer = null; }

  const wsUrl = ROUTER_URL.replace(/^http/, 'ws') + '/ws/gateway';
  console.log(`[bridge] Connecting to router: ${wsUrl}`);

  const ws = new WebSocket(wsUrl);
  let authenticated = false;
  let pingTimer = null;

  ws.on('open', () => {
    console.log('[bridge] Router WS open — sending auth');
    ws.send(JSON.stringify({
      type: 'gateway_auth',
      instanceId: INSTANCE_ID,
      instanceToken: INSTANCE_TOKEN,
      port: PORT,
    }));
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'gateway_auth_ok') {
      authenticated = true;
      routerReconnectAttempt = 0;
      routerWs = ws;
      console.log(`[bridge] Authenticated with router (instanceId=${INSTANCE_ID})`);

      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 25000);

      // Ensure local gateway connection is up
      if (!localWs || localWs.readyState !== WebSocket.OPEN) {
        connectLocal();
      }
      return;
    }

    if (msg.type === 'gateway_auth_error') {
      console.error(`[bridge] Auth failed: ${msg.error}`);
      ws.close();
      return;
    }

    if (!authenticated) return;

    if (msg.type === 'config_update') {
      handleConfigUpdate(msg);
      return;
    }

    if (msg.type === 'exec') {
      handleExec(ws, msg);
      return;
    }

    if (msg.type === 'install_app') {
      handleInstallApp(ws, msg);
      return;
    }

    if (msg.type === 'uninstall_app') {
      handleUninstallApp(ws, msg);
      return;
    }

    // Everything else: forward to local OpenClaw gateway
    forwardToLocal(ws, raw, msg);
  });

  ws.on('pong', () => {});

  ws.on('close', (code, reason) => {
    const reasonStr = reason ? reason.toString().slice(0, 100) : '';
    console.log(`[bridge] Router WS closed: code=${code} ${reasonStr}`);
    cleanup();
  });

  ws.on('error', (err) => {
    console.error(`[bridge] Router WS error: ${err.message}`);
    cleanup();
  });

  function cleanup() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    authenticated = false;
    if (routerWs === ws) routerWs = null;
    scheduleRouterReconnect();
  }
}

function scheduleRouterReconnect() {
  if (routerReconnectTimer) return;
  const delay = backoff(routerReconnectAttempt++);
  console.log(`[bridge] Reconnecting to router in ${Math.round(delay)}ms (attempt ${routerReconnectAttempt})`);
  routerReconnectTimer = setTimeout(connectRouter, delay);
}

// ── Local OpenClaw gateway connection (downlink) ─────────────────────────────

let localWs = null;
let localReconnectAttempt = 0;
let localReconnectTimer = null;
let localAuthenticated = false;

function connectLocal() {
  if (localReconnectTimer) { clearTimeout(localReconnectTimer); localReconnectTimer = null; }

  const wsUrl = `ws://127.0.0.1:${PORT}`;
  console.log(`[bridge] Connecting to local gateway: ${wsUrl}`);

  const ws = new WebSocket(wsUrl);
  localAuthenticated = false;

  ws.on('open', () => {
    console.log('[bridge] Local gateway WS open — waiting for challenge');
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Handle OpenClaw connect handshake
    if (!localAuthenticated) {
      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        const password = readGwPassword();
        // Note: requires cloud-init gateway patch to preserve operator scopes for non-device connections
        ws.send(JSON.stringify({
          type: 'req',
          id: randomUUID(),
          method: 'connect',
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: { id: 'bridge-client', version: '1.0.0', platform: 'linux', mode: 'bridge' },
            caps: [],
            auth: { password },
            role: 'operator',
            scopes: ['operator.read', 'operator.write', 'operator.admin'],
          },
        }));
        return;
      }

      if (msg.type === 'res' && msg.ok && msg.payload?.type === 'hello-ok') {
        localAuthenticated = true;
        localReconnectAttempt = 0;
        localWs = ws;
        console.log('[bridge] Local gateway authenticated');
        return;
      }

      if (msg.type === 'res' && !msg.ok) {
        console.error(`[bridge] Local gateway auth failed: ${JSON.stringify(msg.error)}`);
        ws.close();
        return;
      }
      return;
    }

    // Forward gateway events to router (delta, final, error, subagent, etc.)
    // Skip internal housekeeping events
    if (msg.type === 'event' && (msg.event === 'health' || msg.event === 'tick' || msg.event === 'heartbeat')) {
      return;
    }
    forwardToRouter(raw);
  });

  ws.on('close', (code) => {
    console.log(`[bridge] Local gateway WS closed: code=${code}`);
    localAuthenticated = false;
    if (localWs === ws) localWs = null;
    scheduleLocalReconnect();
  });

  ws.on('error', (err) => {
    if (err.code === 'ECONNREFUSED') {
      if (localReconnectAttempt === 0) console.log('[bridge] Local gateway not ready yet');
    } else {
      console.error(`[bridge] Local gateway WS error: ${err.message}`);
    }
    localAuthenticated = false;
    if (localWs === ws) localWs = null;
    scheduleLocalReconnect();
  });
}

function scheduleLocalReconnect() {
  if (localReconnectTimer) return;
  const delay = backoff(localReconnectAttempt++);
  localReconnectTimer = setTimeout(connectLocal, delay);
}

// ── Message forwarding ───────────────────────────────────────────────────────

/** Forward a router message to the local gateway. If down, send RPC error back to router. */
function forwardToLocal(routerSocket, raw, msg) {
  if (localWs && localWs.readyState === WebSocket.OPEN && localAuthenticated) {
    localWs.send(raw);
  } else {
    // Send RPC error so router's sendMessageViaWs rejects instead of timing out
    if (msg.type === 'req' && msg.id) {
      const errReply = JSON.stringify({
        type: 'res', id: msg.id, ok: false,
        error: { message: 'Gateway not available — bridge cannot reach local gateway' },
      });
      if (routerSocket.readyState === WebSocket.OPEN) routerSocket.send(errReply);
    } else {
      console.warn('[bridge] Cannot forward to local gateway (not connected)');
    }
  }
}

function forwardToRouter(raw) {
  if (routerWs && routerWs.readyState === WebSocket.OPEN) {
    routerWs.send(raw);
  }
}

// ── Config update handler ────────────────────────────────────────────────────

function handleConfigUpdate(msg) {
  // File-based mutex: the config-sync pm2 process (openclaw-config-sync.sh)
  // watches openclaw.json for changes and pushes them upstream. This pull flag
  // tells config-sync to skip its sync cycle while we're doing a pull (read →
  // modify → write). Without this, config-sync could read a half-written file
  // or push stale values back upstream immediately after we write.
  //
  // Protocol: create flag → read → modify → write → remove flag (in finally).
  const pullFlag = '/tmp/.config-pull-active';
  try {
    if (!fs.existsSync(OC_CONFIG_PATH)) {
      console.warn(`[bridge] openclaw.json not found at ${OC_CONFIG_PATH}`);
      return;
    }

    // Set pull flag BEFORE reading — prevents config-sync from racing
    fs.writeFileSync(pullFlag, '');

    const config = JSON.parse(fs.readFileSync(OC_CONFIG_PATH, 'utf8'));
    let changed = false;

    if (msg.litellmKey) {
      const providers = config.models?.providers;
      if (providers?.litellm) {
        providers.litellm.apiKey = msg.litellmKey;
        changed = true;
      } else {
        console.warn('[bridge] openclaw.json has no providers.litellm — cannot apply litellmKey');
      }
    }

    if (msg.routerUrl) {
      const providers = config.models?.providers;
      if (providers?.litellm) {
        providers.litellm.baseUrl = msg.routerUrl + '/v1';
        changed = true;
      }
    }

    // Fix gateway auth: ensure password mode with correct GW_PASSWORD
    if (msg.gwPassword) {
      if (!config.gateway) config.gateway = {};
      const needsFix = !config.gateway.auth
        || config.gateway.auth.mode !== 'password'
        || config.gateway.auth.password !== msg.gwPassword;
      if (needsFix) {
        config.gateway.auth = { mode: 'password', password: msg.gwPassword };
        changed = true;
        console.log('[bridge] Fixed gateway auth mode to password');
      }
      // Ensure controlUi is configured for Docker/LAN
      if (!config.gateway.controlUi?.dangerouslyAllowHostHeaderOriginFallback) {
        if (!config.gateway.controlUi) config.gateway.controlUi = {};
        config.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback = true;
        changed = true;
      }
    }

    if (changed) {
      fs.writeFileSync(OC_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
      console.log('[bridge] openclaw.json updated from config_update');
      // Restart openclaw gateway to pick up config changes
      try { execSync('pm2 restart openclaw --no-color', { timeout: 10000 }); } catch {}
    }
  } catch (err) {
    console.error(`[bridge] Config update failed: ${err.message}`);
  } finally {
    // Always release pull flag — use try/finally so it's cleaned up even on error
    try { fs.unlinkSync(pullFlag); } catch {}
  }
}

// ── Exec handler ─────────────────────────────────────────────────────────────

function handleExec(ws, msg) {
  const { id, command, user, cwd } = msg;
  if (!id || !command) return;

  // Validate user: only allow CLIENT_USER or no user (never arbitrary usernames)
  if (user && CLIENT_USER && user !== CLIENT_USER) {
    console.warn(`[bridge] Exec rejected: requested user '${user}' does not match CLIENT_USER '${CLIENT_USER}'`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'exec_result', id, code: 1, stdout: '', stderr: 'User mismatch' }));
    }
    return;
  }

  console.log(`[bridge] Exec: ${command.slice(0, 200)}`);

  const execUser = user || CLIENT_USER || undefined;
  const usesSudo = execUser && process.getuid && process.getuid() === 0;
  const binary = usesSudo ? 'sudo' : '/bin/bash';
  const spawnArgs = usesSudo
    ? ['-u', execUser, '/bin/bash', '-c', command]
    : ['-c', command];
  // Note: spawn() ignores timeout and maxBuffer (those are exec/execFile only).
  // We enforce both manually below via setTimeout and byte counting.
  const opts = {
    shell: false,
    cwd: cwd || HOME_DIR,
    env: { ...process.env, HOME: HOME_DIR },
  };

  const proc = spawn(binary, spawnArgs, opts);
  let stdout = '';
  let stderr = '';
  let streamed = false;
  let killed = false;
  let totalBytes = 0;

  // Manual timeout — spawn does not support the timeout option
  const killTimer = setTimeout(() => {
    if (!killed) {
      killed = true;
      proc.kill('SIGTERM');
      // Give it a moment to clean up, then force kill
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000);
    }
  }, EXEC_TIMEOUT_MS);

  function sendResult(code, signal) {
    clearTimeout(killTimer);
    if (ws.readyState !== WebSocket.OPEN) return;
    const timedOut = killed && !signal;
    ws.send(JSON.stringify({
      type: 'exec_result', id,
      code: code ?? (signal ? 1 : 0),
      stdout: streamed ? '' : stdout,
      stderr: stderr
        || (timedOut ? `Timed out after ${EXEC_TIMEOUT_MS}ms` : '')
        || (signal ? `Killed by ${signal}` : ''),
    }));
  }

  proc.stdout.on('data', (chunk) => {
    totalBytes += chunk.length;
    // Manual buffer limit — spawn does not support maxBuffer
    if (totalBytes > EXEC_MAX_BUFFER) {
      if (!killed) {
        killed = true;
        stderr += `\nOutput exceeded max buffer (${EXEC_MAX_BUFFER} bytes)`;
        proc.kill('SIGTERM');
      }
      return;
    }
    const data = chunk.toString();
    stdout += data;
    streamed = true;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'exec_output', id, data }));
    }
  });

  proc.stderr.on('data', (chunk) => {
    totalBytes += chunk.length;
    if (totalBytes > EXEC_MAX_BUFFER) {
      if (!killed) {
        killed = true;
        stderr += `\nOutput exceeded max buffer (${EXEC_MAX_BUFFER} bytes)`;
        proc.kill('SIGTERM');
      }
      return;
    }
    stderr += chunk.toString();
  });

  proc.on('close', (code, signal) => {
    sendResult(code, signal);
  });

  proc.on('error', (err) => {
    clearTimeout(killTimer);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'exec_result', id, code: 1, stdout: '', stderr: err.message }));
    }
  });
}

// ── Helper: read gateway password from openclaw.json ─────────────────────────

function readGwPassword() {
  try {
    const config = JSON.parse(fs.readFileSync(OC_CONFIG_PATH, 'utf8'));
    return config.gateway?.auth?.password || GW_PASSWORD || '';
  } catch {
    return GW_PASSWORD || '';
  }
}

// ── Runtime app install/uninstall (for additional mini-apps) ─────────────────

const APPS_DIR = path.join(HOME_DIR, 'apps');

async function handleInstallApp(ws, msg) {
  const { id, slug, identifier, artifactUrl, sourceUrl, env, manifest } = msg;
  const appDir = path.join(APPS_DIR, identifier || `com.xshopper.${slug}`);

  console.log(`[bridge] Installing app: ${slug}`);

  try {
    // Write env vars to secrets.env
    if (env && typeof env === 'object') {
      const secretsPath = '/etc/openclaw/secrets.env';
      let existing = '';
      try { existing = fs.readFileSync(secretsPath, 'utf8'); } catch {}
      for (const [k, v] of Object.entries(env)) {
        if (!existing.includes(`${k}=`)) {
          fs.appendFileSync(secretsPath, `${k}=${v}\n`);
        }
        process.env[k] = String(v);
      }
    }

    // Download
    fs.mkdirSync(appDir, { recursive: true });
    if (artifactUrl) {
      const tmpFile = `/tmp/app-${slug}.zip`;
      execSync(`curl -sfL "${artifactUrl}" -o "${tmpFile}"`, { timeout: 60000 });
      const tmpDir = `/tmp/app-${slug}-extract`;
      execSync(`rm -rf "${tmpDir}" && mkdir -p "${tmpDir}" && unzip -qo "${tmpFile}" -d "${tmpDir}"`, { timeout: 30000 });
      const entries = fs.readdirSync(tmpDir);
      const src = entries.length === 1 && fs.statSync(path.join(tmpDir, entries[0])).isDirectory()
        ? path.join(tmpDir, entries[0]) : tmpDir;
      execSync(`cp -a "${src}/." "${appDir}/"`, { timeout: 15000 });
      execSync(`rm -rf "${tmpFile}" "${tmpDir}"`);
    } else if (sourceUrl) {
      execSync(`git clone --depth 1 "${sourceUrl}" "${appDir}" 2>/dev/null || (cd "${appDir}" && git pull)`, { timeout: 120000 });
    }

    // Run install.sh
    const installScript = path.join(appDir, 'scripts', 'install.sh');
    if (fs.existsSync(installScript)) {
      execSync(`bash "${installScript}"`, { cwd: appDir, env: { ...process.env, APP_DIR: appDir, HOME: HOME_DIR }, timeout: 120000, stdio: 'inherit' });
    }

    // Install npm deps
    if (fs.existsSync(path.join(appDir, 'package.json')) && !fs.existsSync(path.join(appDir, 'node_modules'))) {
      execSync('npm install --omit=dev --loglevel=error', { cwd: appDir, timeout: 60000 });
    }

    // Regenerate ecosystem + restart pm2
    const genScript = path.join(appDir, 'scripts', 'generate-ecosystem.sh');
    if (fs.existsSync(genScript)) {
      execSync(`bash "${genScript}"`, { cwd: appDir, env: { ...process.env, APP_DIR: appDir, HOME: HOME_DIR }, timeout: 30000, stdio: 'inherit' });
    }
    const ecoFile = path.join(appDir, 'ecosystem.config.js');
    if (fs.existsSync(ecoFile)) {
      execSync(`pm2 start "${ecoFile}" --update-env`, { timeout: 30000, stdio: 'inherit' });
    }

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'install_result', id, slug, status: 'ok' }));
    }
    console.log(`[bridge] App installed: ${slug}`);
  } catch (err) {
    console.error(`[bridge] Install failed for ${slug}:`, err.message);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'install_result', id, slug, status: 'error', error: err.message }));
    }
  }
}

function handleUninstallApp(ws, msg) {
  const { id, slug, identifier } = msg;
  const appDir = path.join(APPS_DIR, identifier || `com.xshopper.${slug}`);
  try {
    const uninstallScript = path.join(appDir, 'scripts', 'uninstall.sh');
    if (fs.existsSync(uninstallScript)) {
      execSync(`bash "${uninstallScript}"`, { cwd: appDir, timeout: 30000, stdio: 'inherit' });
    }
    try { execSync(`pm2 delete app-${slug}`, { timeout: 10000 }); } catch {}
    try { execSync(`pm2 delete ${slug}`, { timeout: 10000 }); } catch {}
    execSync(`rm -rf "${appDir}"`, { timeout: 10000 });
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'uninstall_result', id, slug, status: 'ok' }));
    }
  } catch (err) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'uninstall_result', id, slug, status: 'error', error: err.message }));
    }
  }
}

// ── Health endpoint ──────────────────────────────────────────────────────────

const healthServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    const status = {
      router: routerWs?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
      local: localWs?.readyState === WebSocket.OPEN && localAuthenticated ? 'connected' : 'disconnected',
      uptime: process.uptime(),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  } else {
    res.writeHead(404);
    res.end();
  }
});
healthServer.listen(HEALTH_PORT, '127.0.0.1', () => {
  console.log(`[bridge] Health endpoint on http://127.0.0.1:${HEALTH_PORT}/health`);
});

// ── Startup ──────────────────────────────────────────────────────────────────

console.log(`[bridge] Starting — instance=${INSTANCE_ID} port=${PORT} router=${ROUTER_URL}`);

// Connect to router first; local connection initiated after router auth (line 117)
connectRouter();

// ── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`[bridge] ${signal} received — shutting down`);
  if (routerReconnectTimer) clearTimeout(routerReconnectTimer);
  if (localReconnectTimer) clearTimeout(localReconnectTimer);
  try { routerWs?.close(1000, 'Bridge shutdown'); } catch {}
  try { localWs?.close(1000, 'Bridge shutdown'); } catch {}
  try { healthServer.close(); } catch {}
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
