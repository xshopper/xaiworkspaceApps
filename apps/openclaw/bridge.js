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
const { spawn } = require('child_process');
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

    if (changed) {
      fs.writeFileSync(OC_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
      console.log('[bridge] openclaw.json updated from config_update');
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
  const opts = {
    shell: false,
    cwd: cwd || HOME_DIR,
    timeout: EXEC_TIMEOUT_MS,
    maxBuffer: EXEC_MAX_BUFFER,
    env: { ...process.env, HOME: HOME_DIR },
  };

  const proc = spawn(binary, spawnArgs, opts);
  let stdout = '';
  let stderr = '';
  let streamed = false;

  proc.stdout.on('data', (chunk) => {
    const data = chunk.toString();
    stdout += data;
    streamed = true;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'exec_output', id, data }));
    }
  });

  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  proc.on('close', (code, signal) => {
    if (ws.readyState === WebSocket.OPEN) {
      // Omit stdout from final result if already streamed via exec_output
      ws.send(JSON.stringify({
        type: 'exec_result', id,
        code: code ?? (signal ? 1 : 0),
        stdout: streamed ? '' : stdout,
        stderr: stderr || (signal ? `Killed by ${signal}` : ''),
      }));
    }
  });

  proc.on('error', (err) => {
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
