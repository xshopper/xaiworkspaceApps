#!/usr/bin/env node
// ── Workspace Agent v1.1.0 (CURRENT production ECS/Docker path) ────────────
//
// ROLE: This is the active workspace agent for the app platform. It runs
// as a pm2 process inside every ECS Fargate workspace container and every
// local Docker workspace container. It is shipped as a mini-app
// (`apps/workspace-agent` in xaiworkspaceApps) and installed via the
// install_app flow triggered from `src/routes/ws-gateway.js` on every
// gateway auth (see WORKSPACE_AGENT_VERSION self-update logic).
//
// It is NOT the same file as `xaiworkspace-backend/bridge.js`, which is
// the legacy EC2 cloud-init bridge for deprecated `i-*` instances.
//
// Single WS bridge between the router and all installed apps inside the
// workspace container.
//
// Architecture:
//   Router ←──WS──→ workspace-agent ←──WS──→ app gateway (discovered from manifests)
//
// Discovers app gateways by scanning ~/apps/*/manifest.yml for `gateway:` blocks.
// Non-management messages from the router are forwarded to the gateway.
// Gateway responses are forwarded back to the router.
//
// Management messages (install_app, uninstall_app, exec, etc.) are handled
// directly by the agent — they never reach the app gateway.
//
// Environment (from /etc/xai/secrets.env):
//   ROUTER_URL, INSTANCE_ID, INSTANCE_TOKEN, CHAT_ID, PORT, GW_PASSWORD
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const AGENT_VERSION = '1.1.0';

const http = require('http');
const { execFileSync } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(require('child_process').execFile);
const { spawn } = require('child_process');
const { randomUUID, randomBytes, timingSafeEqual } = require('crypto');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// ── Load secrets from env file ──────────────────────────────────────────────

const SECRETS_FILE = '/etc/xai/secrets.env';
if (fs.existsSync(SECRETS_FILE)) {
  for (const line of fs.readFileSync(SECRETS_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      let val = m[2];
      // Strip surrounding matched single or double quotes — some secret
      // writers (including us) emit `KEY="value"` and we would otherwise
      // propagate the literal quote characters into the env var.
      if (val.length >= 2) {
        const first = val[0];
        const last = val[val.length - 1];
        if ((first === '"' || first === "'") && first === last) {
          val = val.slice(1, -1);
        }
      }
      process.env[m[1]] = val;
    }
  }
}

const ROUTER_URL     = process.env.ROUTER_URL || 'https://router.xaiworkspace.com';
const INSTANCE_ID    = process.env.INSTANCE_ID || '';
// Domain this worker belongs to — used by agent_message routing as the first
// segment of the address (domain/worker_id/app_identifier/instance_name).
// Derived from ROUTER_URL hostname when BRIDGE_DOMAIN is not provided.
const BRIDGE_DOMAIN  = process.env.BRIDGE_DOMAIN || (() => {
  try { return new URL(ROUTER_URL).hostname.replace(/^router\./, '').replace(/^test-router\./, 'test.'); }
  catch { return 'xaiworkspace.com'; }
})();
const INSTANCE_TOKEN = process.env.INSTANCE_TOKEN || '';
const CHAT_ID        = process.env.CHAT_ID || '';
const GW_PASSWORD    = process.env.GW_PASSWORD || '';
const CLIENT_USER    = process.env.CLIENT_USER || '';
const HOME           = process.env.HOME || `/home/${CLIENT_USER || 'workspace'}`;
const HEALTH_PORT    = parseInt(process.env.BRIDGE_HEALTH_PORT || '19099', 10);
const APPS_DIR       = path.join(HOME, 'apps');

const OC_CONFIG_PATH = path.join(HOME, '.openclaw', 'openclaw.json');

// ── Input validation patterns ───────────────────────────────────────────────

const SAFE_SLUG         = /^[a-z0-9][a-z0-9._-]*$/;
const SAFE_IDENTIFIER   = /^[a-zA-Z0-9._-]+$/;
const VALID_ENV_KEY     = /^[A-Z_][A-Z0-9_]*$/;
const SAFE_PROCESS_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;

if (!INSTANCE_ID || !INSTANCE_TOKEN) {
  console.error('[workspace-agent] INSTANCE_ID and INSTANCE_TOKEN are required');
  process.exit(1);
}

// ── Constants ───────────────────────────────────────────────────────────────

const INITIAL_BACKOFF    = 3000;
const MAX_BACKOFF        = 60000;
const SHUTDOWN_GRACE_MS  = 1500;
const MAX_COMMAND_LENGTH = 10240;

function backoff(attempt) {
  const delay = Math.min(INITIAL_BACKOFF * Math.pow(2, attempt), MAX_BACKOFF);
  return delay * (0.75 + Math.random() * 0.5); // +/-25% jitter
}

// ── Gateway discovery from manifests ────────────────────────────────────────

let gateways = []; // [{ slug, port, protocol }]
let activeGatewayPort = null; // port the active gatewayWs is connected to (null = not connected)

function loadGateways() {
  const found = [];
  try {
    if (!fs.existsSync(APPS_DIR)) return found;
    for (const entry of fs.readdirSync(APPS_DIR)) {
      const manifestPath = path.join(APPS_DIR, entry, 'manifest.yml');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        let raw = fs.readFileSync(manifestPath, 'utf8');
        raw = raw.replace(/\r\n/g, '\n'); // normalize line endings for cross-platform manifests
        // Parse gateway block from YAML without js-yaml dependency.
        // Match "gateway:" as a top-level key, then extract port/protocol
        // from indented lines immediately following it (stop at next
        // non-indented line or EOF).
        const gwBlockMatch = raw.match(/^gateway:\s*\n((?:[ \t]+.+\n?)*)/m);
        if (!gwBlockMatch) continue;
        const gwBlock = gwBlockMatch[1];
        const portMatch = gwBlock.match(/^\s+port:\s*(\d+)/m);
        const protoMatch = gwBlock.match(/^\s+protocol:\s*(\w+)/m);
        if (!portMatch) continue;
        const slugMatch = raw.match(/^slug:\s*['"]?([^\s'"]+)/m);
        found.push({
          slug: slugMatch ? slugMatch[1] : entry,
          port: parseInt(portMatch[1], 10),
          protocol: protoMatch ? protoMatch[1] : 'ws',
        });
      } catch (e) { console.warn(`[workspace-agent] Failed to parse manifest: ${manifestPath}`, e.message); }
    }
  } catch (e) { console.warn('[workspace-agent] Failed to read apps dir:', e.message); }
  gateways = found;
  if (found.length > 0) {
    console.log('[workspace-agent] Discovered gateways:', found.map(g => `${g.slug}@${g.port}/${g.protocol}`).join(', '));
  }
  return found;
}

// ── Router connection (uplink) ──────────────────────────────────────────────

let routerWs = null;
let routerAuthenticated = false;
let routerReconnectAttempt = 0;
let routerReconnectTimer = null;
let shuttingDown = false;

function connectRouter() {
  if (shuttingDown) return;
  if (routerReconnectTimer) { clearTimeout(routerReconnectTimer); routerReconnectTimer = null; }

  const wsUrl = ROUTER_URL.replace(/^http/, 'ws') + '/ws/gateway';
  console.log(`[workspace-agent] -> ${wsUrl}`);

  const ws = new WebSocket(wsUrl);
  let pingTimer = null;

  ws.on('open', () => {
    console.log(`[workspace-agent] Connected, authenticating as ${INSTANCE_ID}...`);
    ws.send(JSON.stringify({
      type: 'gateway_auth',
      instanceId: INSTANCE_ID,
      instanceToken: INSTANCE_TOKEN,
      chatId: CHAT_ID,
      port: gateways[0]?.port || 19001,
      agentVersion: AGENT_VERSION,
    }));
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'gateway_auth_ok') {
      routerAuthenticated = true;
      routerReconnectAttempt = 0;
      routerWs = ws;
      console.log(`[workspace-agent] Authenticated (instanceId=${INSTANCE_ID})`);

      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 45000);

      // Repopulate per-app HMAC tokens from pm2 env. `_appBridgeTokens` is a
      // pure in-memory Map populated during handleInstallApp + upgrade. On a
      // bridge restart the Map resets to empty, while the app pm2 processes
      // keep running with their original APP_BRIDGE_TOKEN baked into env. Any
      // `deliverToLocalApp` call before the next install_app would then drop
      // the message (no token → warn + return false). Rehydrate from pm2's
      // view of the world so inter-agent + user→agent delivery works
      // immediately after restart.
      reconcileAppBridgeTokens();

      // Report installed apps
      reportInstalledApps();

      // Connect to discovered gateways
      loadGateways();
      if (gateways.length > 0 && (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN)) {
        connectGateway();
      }
      return;
    }

    if (msg.type === 'gateway_auth_error') {
      console.error(`[workspace-agent] Auth failed: ${msg.error}`);
      ws.close();
      return;
    }

    if (!routerAuthenticated) return;

    // Management messages — handle locally
    switch (msg.type) {
      case 'install_app':   handleInstallApp(msg); return;
      case 'uninstall_app': handleUninstallApp(msg); return;
      case 'uninstall_app_instance': handleUninstallAppInstance(msg); return;
      case 'stop_app_instance':  handleStopAppInstance(msg); return;
      case 'start_app_instance': handleStartAppInstance(msg); return;
      case 'restart_app':   handleRestartApp(msg); return;
      case 'list_apps':     handleListApps(msg); return;
      case 'exec':          handleExec(msg); return;
      case 'scan':          handleScan(); return;
      case 'config_update': handleConfigUpdate(msg); return;
      case 'app_message':   handleAppMessage(msg); return;
      case 'agent_message_deliver': handleAgentMessageDeliver(msg); return;
      case 'agent_message_error':   handleAgentMessageError(msg); return;
      case 'user_input':    handleUserInput(msg); return;
    }

    // Everything else: forward to app gateway
    forwardToGateway(ws, raw, msg);
  });

  ws.on('pong', () => {});

  ws.on('close', (code, reason) => {
    const reasonStr = reason ? reason.toString().slice(0, 100) : '';
    console.log(`[workspace-agent] Disconnected: ${code} ${reasonStr}`);
    cleanup();
  });

  ws.on('error', (err) => {
    console.warn('[workspace-agent] WS error:', err.message);
    cleanup();
  });

  function cleanup() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    routerAuthenticated = false;
    if (routerWs === ws) routerWs = null;
    scheduleRouterReconnect();
  }
}

function scheduleRouterReconnect() {
  if (routerReconnectTimer || shuttingDown) return;
  const delay = backoff(routerReconnectAttempt++);
  console.log(`[workspace-agent] Reconnecting in ${Math.round(delay)}ms (attempt ${routerReconnectAttempt})`);
  routerReconnectTimer = setTimeout(connectRouter, delay);
}

// ── App gateway connection (downlink) ───────────────────────────────────────

let gatewayWs = null;
let gatewayAuthenticated = false;
let gatewayReconnectAttempt = 0;
let gatewayReconnectTimer = null;

function connectGateway() {
  if (shuttingDown) return;
  if (gatewayReconnectTimer) { clearTimeout(gatewayReconnectTimer); gatewayReconnectTimer = null; }
  if (gateways.length === 0) return;

  const gw = gateways[0]; // primary gateway
  const wsUrl = `ws://127.0.0.1:${gw.port}`;
  console.log(`[workspace-agent] Connecting to gateway: ${gw.slug}@${wsUrl}`);

  const ws = new WebSocket(wsUrl);
  gatewayAuthenticated = false;

  ws.on('open', () => {
    console.log(`[workspace-agent] Gateway WS open (${gw.slug}) — waiting for challenge`);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Handle connect handshake
    if (!gatewayAuthenticated) {
      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        const password = readGwPassword();
        ws.send(JSON.stringify({
          type: 'req',
          id: randomUUID(),
          method: 'connect',
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: { id: 'workspace-agent', version: AGENT_VERSION, platform: 'linux', mode: 'bridge' },
            caps: [],
            auth: { password },
            role: 'operator',
            scopes: ['operator.read', 'operator.write', 'operator.admin'],
          },
        }));
        return;
      }

      if (msg.type === 'res' && msg.ok && msg.payload?.type === 'hello-ok') {
        gatewayAuthenticated = true;
        gatewayReconnectAttempt = 0;
        gatewayWs = ws;
        activeGatewayPort = gw.port;
        console.log(`[workspace-agent] Gateway authenticated (${gw.slug})`);
        return;
      }

      if (msg.type === 'res' && !msg.ok) {
        console.error(`[workspace-agent] Gateway auth failed: ${JSON.stringify(msg.error)}`);
        ws.close();
        return;
      }
      return;
    }

    // Skip internal housekeeping events
    if (msg.type === 'event' && (msg.event === 'health' || msg.event === 'tick' || msg.event === 'heartbeat')) {
      return;
    }

    // Forward gateway responses/events to router
    forwardToRouter(raw);
  });

  ws.on('close', (code) => {
    console.log(`[workspace-agent] Gateway WS closed: code=${code}`);
    gatewayAuthenticated = false;
    activeGatewayPort = null;
    if (gatewayWs === ws) gatewayWs = null;
    scheduleGatewayReconnect();
  });

  ws.on('error', (err) => {
    if (err.code === 'ECONNREFUSED') {
      if (gatewayReconnectAttempt === 0) console.log(`[workspace-agent] Gateway not ready yet (${gw.slug})`);
    } else {
      console.error(`[workspace-agent] Gateway WS error: ${err.message}`);
    }
    gatewayAuthenticated = false;
    activeGatewayPort = null;
    if (gatewayWs === ws) gatewayWs = null;
    scheduleGatewayReconnect();
  });
}

function scheduleGatewayReconnect() {
  if (gatewayReconnectTimer || shuttingDown) return;
  const delay = backoff(gatewayReconnectAttempt++);
  gatewayReconnectTimer = setTimeout(connectGateway, delay);
}

/**
 * Re-scan manifests for gateway declarations and reconnect if the primary gateway
 * port has changed (e.g. after an app reinstall) or if we are not currently connected.
 */
function refreshGatewayConnection() {
  loadGateways();
  if (shuttingDown) return;

  if (gateways.length === 0) {
    if (gatewayWs) { try { gatewayWs.close(); } catch {} }
    return;
  }

  const newPort = gateways[0].port;

  if (activeGatewayPort !== null && activeGatewayPort !== newPort) {
    // Primary gateway port changed after install/reinstall — close stale connection.
    // The close handler will call scheduleGatewayReconnect() which will pick up the new port.
    console.log(`[workspace-agent] Gateway port changed (${activeGatewayPort} → ${newPort}), reconnecting`);
    gatewayReconnectAttempt = 0;
    if (gatewayReconnectTimer) { clearTimeout(gatewayReconnectTimer); gatewayReconnectTimer = null; }
    if (gatewayWs) { try { gatewayWs.close(); } catch {} }
  } else if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN) {
    // Not connected — connect immediately
    if (gatewayReconnectTimer) { clearTimeout(gatewayReconnectTimer); gatewayReconnectTimer = null; }
    connectGateway();
  }
}

// ── Message forwarding ──────────────────────────────────────────────────────

function forwardToGateway(routerSocket, raw, msg) {
  if (gatewayWs && gatewayWs.readyState === WebSocket.OPEN && gatewayAuthenticated) {
    gatewayWs.send(raw);
  } else {
    // Send RPC error so router doesn't hang waiting for a response
    if (msg.type === 'req' && msg.id) {
      const errReply = JSON.stringify({
        type: 'res', id: msg.id, ok: false,
        error: { message: 'Gateway not available — workspace agent cannot reach app gateway' },
      });
      if (routerSocket.readyState === WebSocket.OPEN) routerSocket.send(errReply);
    } else {
      console.warn('[workspace-agent] Cannot forward to gateway (not connected)');
    }
  }
}

function forwardToRouter(raw) {
  if (routerWs && routerWs.readyState === WebSocket.OPEN) {
    routerWs.send(raw);
  }
}

function send(msg) {
  if (routerWs?.readyState === WebSocket.OPEN) routerWs.send(JSON.stringify(msg));
}

function sendProgress(id, slug, stage, percent, name = null) {
  send({ type: 'install_progress', id, slug, name: name || 'default', stage, percent });
}

// ── Helper: read gateway password ───────────────────────────────────────────

function readGwPassword() {
  try {
    const config = JSON.parse(fs.readFileSync(OC_CONFIG_PATH, 'utf8'));
    return config.gateway?.auth?.password || GW_PASSWORD || '';
  } catch {
    return GW_PASSWORD || '';
  }
}

// ── Config update handler ───────────────────────────────────────────────────

function handleConfigUpdate(msg) {
  const pullFlag = '/tmp/.config-pull-active';
  try {
    if (!fs.existsSync(OC_CONFIG_PATH)) {
      console.warn(`[workspace-agent] openclaw.json not found at ${OC_CONFIG_PATH}`);
      return;
    }

    fs.writeFileSync(pullFlag, '');

    const config = JSON.parse(fs.readFileSync(OC_CONFIG_PATH, 'utf8'));
    let changed = false;

    if (msg.litellmKey) {
      const providers = config.models?.providers;
      if (providers?.litellm) {
        providers.litellm.apiKey = msg.litellmKey;
        changed = true;
      } else {
        console.warn('[workspace-agent] openclaw.json has no providers.litellm');
      }
    }

    if (msg.routerUrl) {
      const providers = config.models?.providers;
      if (providers?.litellm) {
        providers.litellm.baseUrl = msg.routerUrl + '/v1';
        changed = true;
      }
    }

    if (msg.gwPassword) {
      if (!config.gateway) config.gateway = {};
      const needsFix = !config.gateway.auth
        || config.gateway.auth.mode !== 'password'
        || config.gateway.auth.password !== msg.gwPassword;
      if (needsFix) {
        config.gateway.auth = { mode: 'password', password: msg.gwPassword };
        changed = true;
        console.log('[workspace-agent] Fixed gateway auth mode to password');
      }
      if (!config.gateway.controlUi?.dangerouslyAllowHostHeaderOriginFallback) {
        if (!config.gateway.controlUi) config.gateway.controlUi = {};
        config.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback = true;
        changed = true;
      }
    }

    if (changed) {
      fs.writeFileSync(OC_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
      console.log('[workspace-agent] openclaw.json updated from config_update');
      try { execFileSync('pm2', ['restart', 'openclaw', '--no-color'], { timeout: 10000 }); } catch (e) {
        console.warn('[workspace-agent] pm2 restart openclaw failed:', e.message);
      }
    }
  } catch (err) {
    console.error(`[workspace-agent] Config update failed: ${err.message}`);
  } finally {
    try { fs.unlinkSync(pullFlag); } catch {}
  }
}

// ── Inter-app message delivery ──────────────────────────────────────────────

function handleAppMessage(msg) {
  const toName = msg.to?.name;
  const toSlug = msg.to?.slug || 'agent';
  if (!toName) {
    console.warn('[workspace-agent] app_message missing to.name');
    return;
  }
  deliverToLocalApp(toSlug, toName, msg).then(ok => {
    if (!ok) console.warn(`[workspace-agent] Could not deliver app_message to ${toSlug}/${toName}`);
  });
}

// ── Inter-worker agent messaging (Sprint 2 track C) ─────────────────────────
//
// Address format: domain/worker_id/app_identifier/instance_name (private)
//                 domain/app_identifier/instance_name           (public)
//
// All deliveries from the router arrive as agent_message_deliver. We resolve
// the local target by (app_identifier, instance_name) and POST to its
// loopback HTTP server. The slug is derived from the app_identifier suffix
// (e.g. com.xaiworkspace.agent → agent).

function parseAgentAddress(addr) {
  if (typeof addr !== 'string') return null;
  const parts = addr.split('/');
  if (parts.length === 4) return { domain: parts[0], workerId: parts[1], appIdentifier: parts[2], instanceName: parts[3], kind: 'private' };
  if (parts.length === 3) return { domain: parts[0], workerId: null, appIdentifier: parts[1], instanceName: parts[2], kind: 'public' };
  return null;
}

function slugFromIdentifier(identifier) {
  if (!identifier) return 'agent';
  const dot = identifier.lastIndexOf('.');
  return dot >= 0 ? identifier.slice(dot + 1) : identifier;
}

function handleAgentMessageDeliver(msg) {
  const parsed = parseAgentAddress(msg?.envelope?.to);
  if (!parsed) {
    console.warn('[workspace-agent] agent_message_deliver: invalid `to` address');
    return;
  }
  const slug = slugFromIdentifier(parsed.appIdentifier);
  deliverToLocalApp(slug, parsed.instanceName, msg).then(ok => {
    if (!ok) {
      console.warn(`[workspace-agent] Could not deliver agent_message to ${slug}/${parsed.instanceName}`);
      // Notify router that delivery failed; the message was already audited as
      // 'delivered' on the way in, so emit a follow-up failure for ops visibility.
      send({ type: 'agent_message_error', envelope: msg.envelope, reason: 'local_delivery_failed' });
    }
  });
}

function handleAgentMessageError(msg) {
  // The router replied that an outbound message could not be delivered.
  // For now just log — a future iteration can surface this to the source agent.
  console.warn(`[workspace-agent] agent_message_error from router: ${msg?.reason || 'unknown'} for msg_id=${msg?.envelope?.msg_id}`);
}

function handleUserInput(msg) {
  const toName = msg.to?.name;
  const toSlug = msg.to?.slug;
  if (!toName || !toSlug) {
    console.warn('[workspace-agent] user_input missing to.slug or to.name');
    return;
  }
  deliverToLocalApp(toSlug, toName, msg).then(ok => {
    if (!ok) console.warn(`[workspace-agent] Could not deliver user_input to ${toSlug}/${toName}`);
  });
}

// ── Report installed apps ───────────────────────────────────────────────────

function readManifestVersion(slug) {
  try {
    const dirs = fs.readdirSync(APPS_DIR);
    for (const dir of dirs) {
      const manifestPath = path.join(APPS_DIR, dir, 'manifest.yml');
      try {
        const yaml = fs.readFileSync(manifestPath, 'utf-8');
        const slugMatch = yaml.match(/^slug:\s*['"]?([^\s'"]+)/m);
        if (slugMatch && slugMatch[1] === slug) {
          const verMatch = yaml.match(/^version:\s*['"]?([^\s'"]+)/m);
          return verMatch ? verMatch[1] : null;
        }
      } catch {}
    }
  } catch {}
  return null;
}

// Rehydrate _appBridgeTokens from pm2's view after a bridge restart. The
// authoritative source is pm2_env.env.APP_BRIDGE_TOKEN for every running app
// pm2 process (matched by non-system name). Missing env keys are skipped with
// a warning — that app will 401 inbound deliveries until it is re-installed
// or upgraded, which is the correct fail-closed behavior.
function reconcileAppBridgeTokens() {
  try {
    const list = execFileSync('pm2', ['jlist', '--no-color'], { encoding: 'utf-8', timeout: 5000 });
    const procs = JSON.parse(list);
    const systemProcs = new Set(['workspace-agent', 'bootstrap-bridge', 'bridge', 'updater']);
    let hydrated = 0;
    let skipped = 0;
    for (const p of procs) {
      if (systemProcs.has(p.name)) continue;
      // pm2 names named instances as "slug--name"; default as "slug".
      const slug = p.name.includes('--') ? p.name.split('--')[0] : p.name;
      const instName = p.name.includes('--') ? p.name.split('--')[1] : 'default';
      const token = p.pm2_env?.env?.APP_BRIDGE_TOKEN;
      if (!token || typeof token !== 'string') {
        console.warn(`[workspace-agent] reconcile: no APP_BRIDGE_TOKEN for ${p.name} (likely pre-HMAC install — re-install to rotate)`);
        skipped++;
        continue;
      }
      _appBridgeTokens.set(_appTokenKey(slug, instName), token);
      hydrated++;
    }
    if (hydrated + skipped > 0) {
      console.log(`[workspace-agent] reconcile: rehydrated ${hydrated} app token(s), skipped ${skipped}`);
    }
  } catch (e) {
    console.warn('[workspace-agent] reconcile: failed to hydrate app tokens:', e.message);
  }
}

function reportInstalledApps() {
  try {
    const list = execFileSync('pm2', ['jlist', '--no-color'], { encoding: 'utf-8', timeout: 5000 });
    const procs = JSON.parse(list);
    const systemProcs = new Set(['workspace-agent', 'bootstrap-bridge', 'bridge', 'updater']);
    const apps = procs
      .filter(p => !systemProcs.has(p.name))
      .map(p => {
        // pm2 names multi-instance apps as "slug--instanceName"; strip suffix for slug lookup
        const slug = p.name.includes('--') ? p.name.split('--')[0] : p.name;
        return {
        slug,
        name: p.name.includes('--') ? p.name.split('--')[1] : 'default',
        status: p.pm2_env?.status || 'unknown',
        version: readManifestVersion(slug),
        restarts: p.pm2_env?.restart_time || 0,
        memory: p.monit?.memory || 0,
        cpu: p.monit?.cpu || 0,
      };
      });
    if (apps.length > 0) {
      send({
        type: 'apps_status',
        instanceId: INSTANCE_ID,
        agentVersion: AGENT_VERSION,
        apps,
      });
      console.log('[workspace-agent] Reported ' + apps.length + ' app(s): ' + apps.map(a => a.slug + ' v' + (a.version || '?') + ' (' + a.status + ')').join(', '));
    }
  } catch (e) {
    console.warn('[workspace-agent] Failed to report apps:', e.message);
  }
}

// ── URL validation for app installs ─────────────────────────────────────────

// Exact-match allowlist of hostnames we accept artifact/source downloads from.
// Anything else is rejected. We deliberately DO include `xaiworkspace.com`
// wildcard coverage below (router assets, test env subdomains, and CDN
// hosts under the root domain) but intentionally avoid suffix match for
// third-party hosts like `github.com` where subdomain takeover risk is
// non-zero.
const TRUSTED_DOMAINS = new Set([
  'github.com',
  'api.github.com',
  // `codeload.github.com` was historically the zip/tarball host for
  // /archive/ and /legacy.zip URLs, but GitHub now redirects those
  // requests to `objects.githubusercontent.com` (an S3-backed bucket).
  // Keeping codeload in the allowlist does nothing useful and keeps a
  // name in the list that future engineers might rely on for redirects
  // that no longer happen. Remove it to match reality.
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'registry.npmjs.org',
  'xaiworkspace.com',
  'router.xaiworkspace.com',
  'apps.xaiworkspace.com',
]);

// Suffix-match allowlist: only these roots are accepted for *.root matching.
// GitHub + npm are exact-match only because they host untrusted user content
// on arbitrary subdomains (e.g. `pages.github.com`, *.github.io) that we do
// not want to inherit trust.
//
// `xaiworkspace.com` is suffix-matched because all legitimate artifact/asset
// hosts are under it:
//   - apps.xaiworkspace.com, test-apps.xaiworkspace.com
//   - router.xaiworkspace.com, test-router.xaiworkspace.com
//   - dev001.xaiworkspace.com, app-dev001.xaiworkspace.com
//   - cdn.xaiworkspace.com (if added later)
// and we control the DNS zone.
const SUFFIX_TRUSTED_DOMAINS = new Set([
  'xaiworkspace.com',
]);

function isUrlTrusted(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (TRUSTED_DOMAINS.has(parsed.hostname)) return true;
    for (const d of SUFFIX_TRUSTED_DOMAINS) {
      if (parsed.hostname === d || parsed.hostname.endsWith('.' + d)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ── install_app ─────────────────────────────────────────────────────────────

const _installingApps = new Set();

// Per-app HMAC tokens, keyed by `${slug}--${instanceName}`. Injected at pm2
// start as APP_BRIDGE_TOKEN; validated on `/api/agent-message` via the
// `X-App-Bridge-Token` header. Primary identity boundary for inter-agent
// messaging (port-file check remains as defense-in-depth).
const _appBridgeTokens = new Map();

function _appTokenKey(slug, instanceName) {
  return `${slug}--${instanceName || 'default'}`;
}

async function handleInstallApp(msg) {
  const { id, slug, identifier, artifactUrl, sourceUrl, subdir, env, manifest, name: instanceName, parameters, upgrade, callbackToken } = msg;
  const instName = instanceName || 'default';

  // Validate instance name (defense-in-depth — router also validates)
  if (instName !== 'default' && !/^[a-z0-9][a-z0-9-]*$/.test(instName)) {
    send({ type: 'install_result', id, slug, name: instName, status: 'error', error: 'Invalid instance name' });
    return;
  }

  const installKey = `${slug}/${instName}`;
  if (_installingApps.has(installKey)) {
    console.log('[workspace-agent] Skipping duplicate install for ' + installKey);
    return;
  }
  _installingApps.add(installKey);

  if (!slug || !SAFE_SLUG.test(slug)) {
    send({ type: 'install_result', id, slug, name: instName, status: 'error', error: 'Invalid slug' });
    _installingApps.delete(installKey);
    return;
  }

  if (identifier && !SAFE_IDENTIFIER.test(identifier)) {
    send({ type: 'install_result', id, slug, name: instName, status: 'error', error: 'Invalid identifier' });
    _installingApps.delete(installKey);
    return;
  }

  const appDir = path.join(APPS_DIR, identifier || `com.xshopper.${slug}`);

  if (!path.resolve(appDir).startsWith(path.resolve(APPS_DIR))) {
    send({ type: 'install_result', id, slug, name: instName, status: 'error', error: 'Invalid identifier' });
    _installingApps.delete(installKey);
    return;
  }

  console.log(`[workspace-agent] Installing app: ${slug}/${instName} -> ${appDir}`);

  if (artifactUrl && !isUrlTrusted(artifactUrl)) {
    const domain = (() => { try { return new URL(artifactUrl).hostname; } catch { return 'invalid'; } })();
    console.error(`[workspace-agent] Install rejected for ${slug}: untrusted artifact URL domain: ${domain}`);
    send({ type: 'install_result', id, slug, name: instName, status: 'error', error: `Untrusted artifact URL domain: ${domain}` });
    _installingApps.delete(installKey);
    return;
  }
  if (sourceUrl && !isUrlTrusted(sourceUrl)) {
    const domain = (() => { try { return new URL(sourceUrl).hostname; } catch { return 'invalid'; } })();
    console.error(`[workspace-agent] Install rejected for ${slug}: untrusted source URL domain: ${domain}`);
    send({ type: 'install_result', id, slug, name: instName, status: 'error', error: `Untrusted source URL domain: ${domain}` });
    _installingApps.delete(installKey);
    return;
  }

  try {
    // 1. Write env vars to secrets.env
    const addedKeys = [];
    if (env && typeof env === 'object') {
      sendProgress(id, slug, 'configuring', 5, instName);
      let existing = '';
      try { existing = fs.readFileSync(SECRETS_FILE, 'utf8'); } catch {}
      for (const [k, v] of Object.entries(env)) {
        if (!VALID_ENV_KEY.test(k)) {
          console.warn(`[workspace-agent] Skipping invalid env key: ${k}`);
          continue;
        }
        const sanitized = String(v).replace(/[\n\r\0]/g, '');
        if (!new RegExp(`^${k}=`, 'm').test(existing)) {
          fs.appendFileSync(SECRETS_FILE, `${k}=${sanitized}\n`);
          addedKeys.push(k);
        }
        process.env[k] = sanitized;
      }
    }

    // 2. Download artifact
    sendProgress(id, slug, 'downloading', 10, instName);
    fs.mkdirSync(appDir, { recursive: true });

    if (addedKeys.length > 0) {
      fs.writeFileSync(path.join(appDir, '.env-keys'), addedKeys.join('\n'));
    }

    // Sanitize id for safe use in temp file paths (strip non-alphanumeric chars)
    const safeIdSuffix = (id || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 8);

    if (artifactUrl) {
      // SHA-256 is mandatory for any zip artifact install. Without it we would
      // extract and execute `install.sh` / `npm install` on an unverified
      // payload — the artifact host (or any on-path attacker) could swap
      // binaries. Router always includes `sha256` for published releases;
      // reject missing/malformed digests rather than silently trust.
      if (!msg.sha256 || typeof msg.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(msg.sha256)) {
        send({ type: 'install_result', id, slug, name: instName, status: 'error', error: 'Missing or invalid sha256 digest — artifact installs require a 64-char hex sha256 for integrity verification' });
        _installingApps.delete(installKey);
        return;
      }

      const tmpFile = `/tmp/app-${slug}-${safeIdSuffix}.zip`;
      // Use execFileAsync (no shell) to avoid injection via URL path/query
      await execFileAsync('curl', ['-sfL', artifactUrl, '-o', tmpFile], { timeout: 60000 });

      {
        const crypto = require('crypto');
        const fileBuffer = fs.readFileSync(tmpFile);
        const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        if (hash.toLowerCase() !== msg.sha256.toLowerCase()) {
          send({ type: 'install_result', id, slug, name: instName, status: 'error', error: `Artifact integrity check failed (expected ${msg.sha256.slice(0, 8)}..., got ${hash.slice(0, 8)}...)` });
          try { fs.unlinkSync(tmpFile); } catch {}
          _installingApps.delete(installKey);
          return;
        }
        console.log(`[workspace-agent] Artifact integrity verified: ${hash.slice(0, 8)}...`);
      }

      sendProgress(id, slug, 'extracting', 30, instName);
      const tmpDir = `/tmp/app-${slug}-${safeIdSuffix}-extract`;
      await execFileAsync('rm', ['-rf', tmpDir], { timeout: 5000 });
      await execFileAsync('mkdir', ['-p', tmpDir], { timeout: 5000 });
      await execFileAsync('unzip', ['-qo', tmpFile, '-d', tmpDir], { timeout: 30000 });

      const entries = fs.readdirSync(tmpDir);
      let src = entries.length === 1 && fs.statSync(path.join(tmpDir, entries[0])).isDirectory()
        ? path.join(tmpDir, entries[0])
        : tmpDir;

      if (subdir) {
        if (!/^[a-zA-Z0-9._/-]+$/.test(subdir)) throw new Error('Invalid subdir path');
        const sub = path.resolve(src, subdir);
        if (!sub.startsWith(path.resolve(src) + path.sep)) throw new Error('Subdir escapes extract root');
        if (fs.existsSync(sub)) {
          src = sub;
          console.log('[workspace-agent] Using subdir: ' + subdir);
        }
      }

      await execFileAsync('cp', ['-a', src + '/.', appDir + '/'], { timeout: 15000 });
      await execFileAsync('rm', ['-rf', tmpFile, tmpDir], { timeout: 5000 }).catch(() => {});
    } else if (sourceUrl) {
      // NOTE on integrity: unlike artifactUrl installs (which require a
      // mandatory sha256 digest), `sourceUrl` git clones currently verify
      // only the transport (HTTPS + allowlisted host). A remote that we
      // trust today could be tampered with or repo-renamed tomorrow; for
      // strong supply-chain integrity, callers should pin a commit SHA in
      // the URL (e.g. `tree/<sha>/...`). Mutable refs like `HEAD` or a
      // branch name are accepted but logged so operators can audit them.
      const ghMatch = sourceUrl.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/tree\/([^/]+)\/(.+)$/);
      if (ghMatch) {
        const repoUrl = ghMatch[1] + '.git';
        // Percent-decode before validation — GitHub tree URLs commonly
        // encode slashes (`feature%2Fbar`) and plus signs in branch names.
        // `decodeURIComponent` throws on invalid percent-escapes (e.g. a
        // lone `%`), which we want to surface as an input error rather
        // than a git-clone failure.
        let branchOrRef;
        let ghSubdir;
        try {
          branchOrRef = decodeURIComponent(ghMatch[2]);
          ghSubdir = decodeURIComponent(ghMatch[3]);
        } catch {
          throw new Error('Invalid percent-encoding in source URL');
        }
        if (!/^[a-zA-Z0-9._/-]+$/.test(ghSubdir)) {
          throw new Error('Invalid source subdir path');
        }
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branchOrRef)) {
          throw new Error('Invalid source branch/ref');
        }
        if (!/^[a-f0-9]{40}$/i.test(branchOrRef)) {
          console.warn(`[workspace-agent] Source install for ${slug} uses mutable ref "${branchOrRef}" — pin a 40-char commit SHA for integrity`);
        }
        const tmpSparse = `/tmp/sparse-${slug}-${safeIdSuffix}`;
        await execFileAsync('rm', ['-rf', tmpSparse], { timeout: 5000 }).catch(() => {});
        // Pass --branch so we clone the exact ref the caller pinned; without
        // this we silently install whatever the default branch points at,
        // which is a correctness + supply-chain bug.
        await execFileAsync('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', '--branch', branchOrRef, repoUrl, tmpSparse], { timeout: 120000 });
        await execFileAsync('git', ['-C', tmpSparse, 'sparse-checkout', 'set', ghSubdir], { timeout: 30000 });
        await execFileAsync('cp', ['-a', path.join(tmpSparse, ghSubdir) + '/.', appDir + '/'], { timeout: 15000 });
        await execFileAsync('rm', ['-rf', tmpSparse], { timeout: 5000 }).catch(() => {});
      } else {
        // Whole-repo clone fallback. Pin to the optional `?ref=<branch|sha>`
        // query param if present, otherwise fall back to the repo default
        // and log a warning (same rationale as the tree-URL case above).
        let branchRef = null;
        try {
          const u = new URL(sourceUrl);
          branchRef = u.searchParams.get('ref');
          if (branchRef && !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branchRef)) {
            throw new Error('Invalid ?ref= value');
          }
        } catch { /* non-URL sourceUrl already rejected by allowlist */ }
        const cloneArgs = ['clone', '--depth', '1'];
        if (branchRef) {
          cloneArgs.push('--branch', branchRef);
          if (!/^[a-f0-9]{40}$/i.test(branchRef)) {
            console.warn(`[workspace-agent] Source install for ${slug} uses mutable ref "${branchRef}" — pin a 40-char commit SHA for integrity`);
          }
        } else {
          console.warn(`[workspace-agent] Source install for ${slug} did not pin a branch/sha — using repo default (mutable)`);
        }
        // Strip the query string before handing to git (we consumed it above).
        const cloneUrl = sourceUrl.split('?')[0];
        cloneArgs.push(cloneUrl, appDir);
        await execFileAsync('git', cloneArgs, { timeout: 120000 });
      }
    }

    // Reject no-op installs: if neither artifactUrl nor sourceUrl was
    // provided, `appDir` is either empty or contains only the .env-keys we
    // just wrote. Previously this fell through silently — the app appeared
    // to "install" but had no code, and pm2 would fail to spawn it with a
    // useless "cannot find module" error. Fail fast here with a clear
    // message so operators see the real cause.
    const installedEntries = (() => {
      try { return fs.readdirSync(appDir).filter(f => f !== '.env-keys'); }
      catch { return []; }
    })();
    if (!artifactUrl && !sourceUrl && installedEntries.length === 0) {
      send({ type: 'install_result', id, slug, name: instName, status: 'error', error: 'Install source missing: neither artifactUrl nor sourceUrl was provided' });
      _installingApps.delete(installKey);
      return;
    }

    // 3. Run install.sh if present
    sendProgress(id, slug, 'installing', 50, instName);
    const installScript = path.join(appDir, 'scripts', 'install.sh');
    if (fs.existsSync(installScript)) {
      await execFileAsync('bash', [installScript], {
        cwd: appDir,
        env: { ...process.env, APP_DIR: appDir, HOME },
        timeout: 120000,
      });
    }

    // 4. Install deps if package.json exists (--ignore-scripts prevents postinstall RCE)
    const pkgJson = path.join(appDir, 'package.json');
    if (fs.existsSync(pkgJson) && !fs.existsSync(path.join(appDir, 'node_modules'))) {
      await execFileAsync('pnpm', ['install', '--prod', '--ignore-scripts', '--reporter=silent'], { cwd: appDir, timeout: 120000 });
    }

    // 5. Regenerate ecosystem and restart pm2
    sendProgress(id, slug, 'starting', 80, instName);
    const genScript = path.join(appDir, 'scripts', 'generate-ecosystem.sh');
    if (fs.existsSync(genScript)) {
      await execFileAsync('bash', [genScript], {
        cwd: appDir,
        env: { ...process.env, APP_DIR: appDir, HOME },
        timeout: 30000,
      });
    }

    // Determine pm2 process name: slug for default, slug--name for named instances
    const processName = instName === 'default' ? slug : `${slug}--${instName}`;
    // SDK v1 frozen lifecycle env-var set — the router builds the full set
    // in notifyGatewayAppInstall() / ws-gateway reconciliation and delivers
    // it via install_app.env. Local defaults (BRIDGE_DOMAIN, WORKSPACE_INSTANCE_ID)
    // layer underneath so legacy installs without router-provided env still
    // get addressing context, and APP_INSTANCE_NAME/APP_PARAMETERS are
    // explicitly set last so they can never be clobbered by a stale env map.
    // Only whitelisted keys from msg.env are merged (defense-in-depth against
    // arbitrary env injection if the router payload shape ever drifts).
    const SDK_V1_ENV_KEYS = new Set([
      'APP_PORT',
      'APP_INSTANCE_NAME',
      'APP_PARAMETERS',
      'APP_IDENTIFIER',
      'APP_DATA_DIR',
      'APP_BRIDGE_TOKEN',
      'APP_CALLBACK_TOKEN',
      'BRIDGE_URL',
      'WORKER_ID',
      'DOMAIN',
      'USER_ID',
      'OC_SECRET_HOST',
    ]);
    const routerEnv = {};
    if (env && typeof env === 'object') {
      for (const [k, v] of Object.entries(env)) {
        if (SDK_V1_ENV_KEYS.has(k) && v != null) {
          routerEnv[k] = String(v).replace(/[\n\r\0]/g, '');
        }
      }
    }
    // Generate a fresh per-install HMAC token. This is the primary identity
    // boundary for /api/agent-message — the app presents it as
    // X-App-Bridge-Token and the bridge compares via timingSafeEqual.
    // Rotates on every (re)install or upgrade.
    const appBridgeToken = randomBytes(32).toString('hex');
    _appBridgeTokens.set(_appTokenKey(slug, instName), appBridgeToken);

    const instanceEnv = {
      // Router-provided SDK v1 vars (APP_IDENTIFIER, APP_DATA_DIR, BRIDGE_URL,
      // WORKER_ID, DOMAIN, USER_ID, OC_SECRET_HOST, APP_PORT when applicable).
      ...routerEnv,
      // Sprint 2 track C — let mini-apps compose their own full address.
      // DOMAIN is the SDK v1 contract key; fall back to the bridge-derived
      // hostname when the router didn't supply it. BRIDGE_DOMAIN is retained
      // as an internal-only alias for legacy bridge logic.
      DOMAIN: routerEnv.DOMAIN || BRIDGE_DOMAIN,
      BRIDGE_DOMAIN,
      WORKSPACE_INSTANCE_ID: INSTANCE_ID,
      // These must always reflect this specific install/instance, so they
      // override anything from routerEnv.
      APP_INSTANCE_NAME: instName,
      APP_PARAMETERS: JSON.stringify(parameters || {}),
      APP_BRIDGE_TOKEN: appBridgeToken,
      // Batch D #F1 — per-install callback token issued by the router and
      // attached to install_app WS messages as msg.callbackToken. Apps MUST
      // forward it as X-App-Callback-Token when POSTing to
      // /api/app-callback/:slug/installed|progress|failed. Router falls
      // through the env whitelist path too (APP_CALLBACK_TOKEN in routerEnv)
      // but we prefer the top-level field for clarity and so legacy router
      // payloads that only set one or the other still work.
      APP_CALLBACK_TOKEN: callbackToken || routerEnv.APP_CALLBACK_TOKEN || '',
    };

    // Upgrade mode: code already re-downloaded above, restart ALL instances.
    // Each pm2 process (default + named) gets a freshly rotated APP_BRIDGE_TOKEN
    // so the HMAC identity boundary keeps working after upgrade. Without
    // --update-env + merged env, named instances would inherit the stale
    // token from pm2's cached dump and their next /api/agent-message call
    // would 403.
    if (upgrade) {
      // Helper: rotate token, merge into env, restart process with --update-env.
      const restartWithFreshToken = async (processName, upgradeInstName, ecoFile) => {
        const freshToken = randomBytes(32).toString('hex');
        _appBridgeTokens.set(_appTokenKey(slug, upgradeInstName), freshToken);
        const upgradeEnv = {
          ...routerEnv,
          DOMAIN: routerEnv.DOMAIN || BRIDGE_DOMAIN,
          BRIDGE_DOMAIN,
          WORKSPACE_INSTANCE_ID: INSTANCE_ID,
          APP_INSTANCE_NAME: upgradeInstName,
          APP_PARAMETERS: JSON.stringify(parameters || {}),
          APP_BRIDGE_TOKEN: freshToken,
          APP_CALLBACK_TOKEN: callbackToken || routerEnv.APP_CALLBACK_TOKEN || '',
        };
        if (ecoFile && fs.existsSync(ecoFile)) {
          await execFileAsync('pm2', ['start', ecoFile, '--update-env'], {
            timeout: 30000,
            env: { ...process.env, ...upgradeEnv },
          }).catch(() => {});
        }
        await execFileAsync('pm2', ['restart', processName, '--update-env'], {
          timeout: 30000,
          env: { ...process.env, ...upgradeEnv },
        }).catch(() => {});
      };

      // Prefer .cjs (safe under apps with "type":"module") and fall back to
      // .js for legacy installs. Writes always use .cjs from here on.
      const ecoFileCjs = path.join(appDir, 'ecosystem.config.cjs');
      const ecoFileJs = path.join(appDir, 'ecosystem.config.js');
      const ecoFile = fs.existsSync(ecoFileCjs) ? ecoFileCjs : ecoFileJs;
      // Default instance first
      await restartWithFreshToken(slug, 'default', ecoFile);
      // Named instances (slug--*)
      try {
        const jlist = await execFileAsync('pm2', ['jlist'], { timeout: 10000 });
        const pm2List = JSON.parse(jlist.stdout || '[]');
        for (const p of pm2List) {
          if (p.name !== slug && p.name.startsWith(`${slug}--`)) {
            const namedInst = p.name.slice(slug.length + 2); // strip "slug--"
            if (!namedInst || !SAFE_SLUG.test(namedInst)) continue;
            const namedEco = path.join(appDir, `ecosystem.${namedInst}.config.js`);
            await restartWithFreshToken(p.name, namedInst, fs.existsSync(namedEco) ? namedEco : null);
          }
        }
      } catch {}
      sendProgress(id, slug, 'complete', 100, instName);
      send({ type: 'install_result', id, slug, name: instName, status: 'ok' });
      console.log(`[workspace-agent] App upgraded: ${slug} (all instances restarted with rotated tokens)`);
    } else {
      // Normal install — start pm2 process with instance env vars.
      // Prefer .cjs; fall back to shipped .js if the app bundled one.
      const ecoFileCjs = path.join(appDir, 'ecosystem.config.cjs');
      const ecoFileJsCandidate = path.join(appDir, 'ecosystem.config.js');
      const ecoFile = fs.existsSync(ecoFileCjs) ? ecoFileCjs : ecoFileJsCandidate;
      if (instName === 'default' && fs.existsSync(ecoFile)) {
        // Default instance with existing ecosystem file — use as-is, but
        // merge the SDK v1 instanceEnv into the child process env so that
        // pm2's --update-env picks up router-supplied values (DOMAIN,
        // USER_ID, WORKER_ID, APP_DATA_DIR, etc.). Without this merge the
        // ecosystem file's static `env` block wins and router env is lost
        // after bridge reconnect/reconciliation.
        await execFileAsync('pm2', ['start', ecoFile, '--update-env'], {
          timeout: 30000,
          env: { ...process.env, ...instanceEnv },
        });
        // Follow-up restart ensures the running process picks up the merged
        // env if pm2 decided the app was already online.
        await execFileAsync('pm2', ['restart', processName, '--update-env'], {
          timeout: 30000,
          env: { ...process.env, ...instanceEnv },
        }).catch(() => {});
      } else if (manifest?.startup) {
        const startupCmd = String(manifest.startup).trim();
        if (startupCmd.length > MAX_COMMAND_LENGTH || /[;`|><&\n\r]|\$[\({]/.test(startupCmd)) {
          // Previously only warned and silently dropped the install. The
          // router (and therefore the user) then saw install_result=ok for
          // an app that was never started. Surface the reject as an
          // operator-visible install_result=error so ops can spot the
          // misconfigured manifest.
          const reason = `Unsafe manifest.startup — must not contain shell metacharacters (; \` | > < & newline $( ${'${'}) or exceed ${MAX_COMMAND_LENGTH} chars`;
          console.warn(`[workspace-agent] Rejected unsafe manifest.startup for ${slug}: ${startupCmd.slice(0, 60)}`);
          send({ type: 'install_result', id, slug, name: instName, status: 'error', error: reason });
          _installingApps.delete(installKey);
          return;
        } else {
          const startupParts = startupCmd.split(/\s+/);
          // Always write generated ecosystem as .cjs so Node treats it as
          // CommonJS even when the app's package.json has "type":"module"
          // (connect mini-app does). Previously wrote .js → pm2 failed with
          // "module is not defined in ES module scope" on ESM apps.
          const instanceEcoFile = instName === 'default'
            ? path.join(appDir, 'ecosystem.config.cjs')
            : path.join(appDir, `ecosystem.${instName}.config.cjs`);
          const eco = 'module.exports = { apps: [{ name: ' + JSON.stringify(processName) + ', script: ' + JSON.stringify(startupParts[0]) + ', args: ' + JSON.stringify(startupParts.slice(1)) + ', cwd: ' + JSON.stringify(appDir) + ', autorestart: true, env: ' + JSON.stringify(instanceEnv) + ' }] };';
          fs.writeFileSync(instanceEcoFile, eco);
          await execFileAsync('pm2', ['start', instanceEcoFile, '--update-env'], { timeout: 30000 });
          console.log(`[workspace-agent] Started ${processName} from manifest.startup`);
        }
      } else if (fs.existsSync(ecoFile)) {
        await execFileAsync('pm2', ['start', ecoFile, '--update-env'], { timeout: 30000 });
      }

      sendProgress(id, slug, 'complete', 100, instName);
      send({ type: 'install_result', id, slug, name: instName, status: 'ok' });
      console.log(`[workspace-agent] App installed: ${slug}/${instName} (process: ${processName})`);
    }

    // Re-scan gateways and reconnect if port changed or a new gateway appeared
    refreshGatewayConnection();
  } catch (err) {
    console.error(`[workspace-agent] Install failed for ${slug}/${instName}:`, err.message);
    send({ type: 'install_result', id, slug, name: instName, status: 'error', error: err.message });
  } finally {
    _installingApps.delete(installKey);
  }
}

// ── uninstall_app ───────────────────────────────────────────────────────────

function handleUninstallApp(msg) {
  const { id, slug, identifier } = msg;

  if (!slug || !SAFE_SLUG.test(slug)) {
    send({ type: 'uninstall_result', id, slug, status: 'error', error: 'Invalid slug' });
    return;
  }

  if (identifier && !SAFE_IDENTIFIER.test(identifier)) {
    send({ type: 'uninstall_result', id, slug, status: 'error', error: 'Invalid identifier' });
    return;
  }

  const appDir = path.join(APPS_DIR, identifier || `com.xshopper.${slug}`);

  if (!path.resolve(appDir).startsWith(path.resolve(APPS_DIR))) {
    send({ type: 'uninstall_result', id, slug, status: 'error', error: 'Invalid identifier' });
    return;
  }

  try {
    const uninstallScript = path.join(appDir, 'scripts', 'uninstall.sh');
    if (fs.existsSync(uninstallScript)) {
      execFileSync('bash', [uninstallScript], { cwd: appDir, timeout: 30000, stdio: 'inherit' });
    }

    try { execFileSync('pm2', ['delete', `app-${slug}`], { timeout: 10000 }); } catch {}
    try { execFileSync('pm2', ['delete', slug], { timeout: 10000 }); } catch {}
    try { execFileSync('pm2', ['save', '--force'], { timeout: 5000 }); } catch {}

    // Invalidate all per-instance HMAC tokens for this slug (default + named).
    for (const key of _appBridgeTokens.keys()) {
      if (key === _appTokenKey(slug, 'default') || key.startsWith(`${slug}--`)) {
        _appBridgeTokens.delete(key);
      }
    }

    // Clean up env vars
    try {
      const envKeysFile = path.join(appDir, '.env-keys');
      if (fs.existsSync(envKeysFile)) {
        const keysToRemove = fs.readFileSync(envKeysFile, 'utf8').split('\n').filter(Boolean);
        if (keysToRemove.length > 0) {
          let secrets = fs.readFileSync(SECRETS_FILE, 'utf8');
          for (const key of keysToRemove) {
            if (!VALID_ENV_KEY.test(key)) continue; // re-validate — .env-keys is attacker-controlled
            secrets = secrets.replace(new RegExp(`^${key}=.*\\n?`, 'm'), '');
            delete process.env[key];
          }
          fs.writeFileSync(SECRETS_FILE, secrets);
        }
      }
    } catch (e) { console.warn('[workspace-agent] Failed to clean env vars:', e.message); }

    fs.rmSync(appDir, { recursive: true, force: true });

    send({ type: 'uninstall_result', id, slug, status: 'ok' });
    console.log(`[workspace-agent] App uninstalled: ${slug}`);

    // Re-scan gateways and disconnect if removed app had one
    refreshGatewayConnection();
  } catch (err) {
    send({ type: 'uninstall_result', id, slug, status: 'error', error: err.message });
  }
}

// ── uninstall_app_instance — stop a named pm2 process (app files stay) ─────

function handleUninstallAppInstance(msg) {
  const { slug, name } = msg;
  const procName = (!name || name === 'default') ? slug : `${slug}--${name}`;

  if (!SAFE_SLUG.test(slug)) {
    send({ type: 'uninstall_result', slug, name, status: 'error', error: 'Invalid slug' });
    return;
  }
  if (name && !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    send({ type: 'uninstall_result', slug, name, status: 'error', error: 'Invalid instance name' });
    return;
  }

  try {
    execFileSync('pm2', ['stop', procName], { timeout: 10000 });
    execFileSync('pm2', ['delete', procName], { timeout: 10000 });
  } catch {}

  // Invalidate the HMAC token for this specific instance.
  _appBridgeTokens.delete(_appTokenKey(slug, name || 'default'));

  // Remove instance-specific ecosystem file if it exists
  const appDir = path.join(APPS_DIR, `com.xshopper.${slug}`);
  try {
    const ecoFile = path.join(appDir, `ecosystem.${name}.config.js`);
    if (name && name !== 'default' && fs.existsSync(ecoFile)) {
      fs.unlinkSync(ecoFile);
    }
  } catch {}

  send({ type: 'uninstall_result', slug, name: name || 'default', status: 'ok' });
  console.log(`[workspace-agent] Instance stopped: ${procName}`);
}

// ── stop_app_instance / start_app_instance ─────────────────────────────────
//
// Router-initiated pm2 process lifecycle. Backend endpoints
// POST /api/mini-apps/:slug/stop and /start emit these WS messages via
// _gatewayClients.sendToInstance so the pm2 process state tracks the DB
// status column. The frontend relies on the DB column, but the user-facing
// effect (the app actually being stopped) requires pm2 to stop the process.

async function handleStopAppInstance(msg) {
  const { slug, name } = msg;
  if (!slug || !SAFE_SLUG.test(slug)) {
    send({ type: 'stop_app_instance_result', slug, name, status: 'error', error: 'Invalid slug' });
    return;
  }
  if (name && name !== 'default' && !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    send({ type: 'stop_app_instance_result', slug, name, status: 'error', error: 'Invalid instance name' });
    return;
  }
  // Prefer the router-supplied processName (defense-in-depth: router already
  // computes it via the same `${slug}--${name}` convention), fall back to
  // recomputing if absent. Validate to prevent targeting arbitrary pm2 processes.
  const processName = typeof msg.processName === 'string' && msg.processName
    ? msg.processName
    : ((!name || name === 'default') ? slug : `${slug}--${name}`);
  if (!SAFE_PROCESS_NAME.test(processName)) {
    send({ type: 'stop_app_instance_result', slug, name, status: 'error', error: 'Invalid processName' });
    return;
  }

  try {
    await execFileAsync('pm2', ['stop', processName], { timeout: 10000 });
    console.log(`[workspace-agent] pm2 stop ${processName}`);
    send({ type: 'stop_app_instance_result', slug, name: name || 'default', status: 'ok' });
  } catch (err) {
    const errMsg = err?.stderr?.toString?.() || err?.message || 'pm2 stop failed';
    // Treat "process not found" as a soft failure — the DB is the source of
    // truth for "stopped", and a missing pm2 entry is already effectively stopped.
    if (/not found|does not exist|no process/i.test(errMsg)) {
      console.warn(`[workspace-agent] pm2 stop ${processName}: no such process (treating as ok)`);
      send({ type: 'stop_app_instance_result', slug, name: name || 'default', status: 'ok', note: 'process not running' });
    } else {
      console.error(`[workspace-agent] pm2 stop ${processName} failed:`, errMsg);
      send({ type: 'stop_app_instance_result', slug, name: name || 'default', status: 'error', error: errMsg.slice(0, 500) });
    }
  }
}

async function handleStartAppInstance(msg) {
  const { slug, name } = msg;
  if (!slug || !SAFE_SLUG.test(slug)) {
    send({ type: 'start_app_instance_result', slug, name, status: 'error', error: 'Invalid slug' });
    return;
  }
  if (name && name !== 'default' && !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    send({ type: 'start_app_instance_result', slug, name, status: 'error', error: 'Invalid instance name' });
    return;
  }
  const processName = typeof msg.processName === 'string' && msg.processName
    ? msg.processName
    : ((!name || name === 'default') ? slug : `${slug}--${name}`);
  if (!SAFE_PROCESS_NAME.test(processName)) {
    send({ type: 'start_app_instance_result', slug, name, status: 'error', error: 'Invalid processName' });
    return;
  }

  try {
    // pm2 start on an existing stopped process brings it back online.
    await execFileAsync('pm2', ['start', processName], { timeout: 15000 });
    console.log(`[workspace-agent] pm2 start ${processName}`);
    send({ type: 'start_app_instance_result', slug, name: name || 'default', status: 'ok' });
    return;
  } catch (err) {
    const errMsg = err?.stderr?.toString?.() || err?.message || '';
    // If pm2 never had this process (e.g. was deleted), fall through to
    // restart via the ecosystem file, which will re-create it.
    if (!/not found|does not exist|no process|script not found/i.test(errMsg)) {
      console.error(`[workspace-agent] pm2 start ${processName} failed:`, errMsg);
      send({ type: 'start_app_instance_result', slug, name: name || 'default', status: 'error', error: errMsg.slice(0, 500) });
      return;
    }
  }

  // Fallback: try to (re)start via ecosystem file if pm2 start didn't know
  // about the process.
  try {
    const appDir = path.join(APPS_DIR, `com.xshopper.${slug}`);
    const instName = name || 'default';
    // Prefer generated .cjs, fall back to legacy / shipped .js.
    const cjsName = instName === 'default' ? 'ecosystem.config.cjs' : `ecosystem.${instName}.config.cjs`;
    const jsName = instName === 'default' ? 'ecosystem.config.js' : `ecosystem.${instName}.config.js`;
    const ecoFile = fs.existsSync(path.join(appDir, cjsName))
      ? path.join(appDir, cjsName)
      : path.join(appDir, jsName);
    if (fs.existsSync(ecoFile)) {
      await execFileAsync('pm2', ['start', ecoFile, '--update-env'], { timeout: 30000 });
      console.log(`[workspace-agent] pm2 start ${ecoFile} (fallback for ${processName})`);
      send({ type: 'start_app_instance_result', slug, name: instName, status: 'ok', note: 'restarted via ecosystem file' });
      return;
    }
    send({ type: 'start_app_instance_result', slug, name: instName, status: 'error', error: 'process not found and no ecosystem file available' });
  } catch (err) {
    const errMsg = err?.message || 'pm2 start fallback failed';
    console.error(`[workspace-agent] pm2 start fallback for ${processName} failed:`, errMsg);
    send({ type: 'start_app_instance_result', slug, name: name || 'default', status: 'error', error: errMsg.slice(0, 500) });
  }
}

// ── restart_app ─────────────────────────────────────────────────────────────

function handleRestartApp(msg) {
  const { id, slug } = msg;

  if (!slug || !SAFE_SLUG.test(slug)) {
    send({ type: 'restart_result', id, slug, status: 'error', error: 'Invalid slug' });
    return;
  }

  try {
    try {
      execFileSync('pm2', ['restart', slug], { timeout: 10000 });
    } catch {
      execFileSync('pm2', ['restart', `app-${slug}`], { timeout: 10000 });
    }
    send({ type: 'restart_result', id, slug, status: 'ok' });
  } catch (err) {
    send({ type: 'restart_result', id, slug, status: 'error', error: err.message });
  }
}

// ── list_apps ───────────────────────────────────────────────────────────────

function handleListApps(msg) {
  const { id } = msg;
  const apps = [];
  try {
    if (fs.existsSync(APPS_DIR)) {
      for (const entry of fs.readdirSync(APPS_DIR)) {
        const manifestPath = path.join(APPS_DIR, entry, 'manifest.yml');
        if (fs.existsSync(manifestPath)) {
          apps.push({ identifier: entry, installed: true });
        }
      }
    }
  } catch {}
  send({ type: 'list_apps_result', id, apps });
}

// ── exec ────────────────────────────────────────────────────────────────────

const MAX_CONCURRENT_EXEC = 5;
let runningExec = 0;

const EXEC_ALLOWLIST = [
  'node ',
  'pm2 ',
  'bash scripts/',
  'bash ./scripts/',
  'cat ',
  'ls ',
  'echo ',
  'whoami',
  'hostname',
  'uname ',
  'df ',
  'free ',
  'ps ',
  'npm ',
  'npx ',
  'curl ',
  'tail ',
  'head ',
  'grep ',
  'wc ',
];

function isCommandAllowed(command) {
  const trimmed = command.trimStart();
  return EXEC_ALLOWLIST.some(prefix => trimmed.startsWith(prefix) || trimmed === prefix.trim());
}

function handleExec(msg) {
  const { id, command, cwd, user } = msg;
  if (!command || typeof command !== 'string' || command.length > MAX_COMMAND_LENGTH) {
    send({ type: 'exec_result', id, code: -1, stdout: '', stderr: 'Command rejected: invalid or too long' });
    return;
  }

  if (runningExec >= MAX_CONCURRENT_EXEC) {
    console.warn(`[workspace-agent] exec rejected: ${runningExec} already running (max ${MAX_CONCURRENT_EXEC})`);
    send({ type: 'exec_result', id, code: 1, stdout: '', stderr: `Too many concurrent exec requests (max ${MAX_CONCURRENT_EXEC})` });
    return;
  }

  if (!isCommandAllowed(command)) {
    console.warn(`[workspace-agent] exec rejected: not in allowlist: ${command.slice(0, 80)}`);
    send({ type: 'exec_result', id, code: -1, stdout: '', stderr: 'Command rejected: not in allowlist' });
    return;
  }

  if (/[;`|><&\n\r]|\$[\({]/.test(command)) {
    console.warn('[workspace-agent] exec rejected: disallowed shell characters');
    send({ type: 'exec_result', id, code: -1, stdout: '', stderr: 'Command rejected: disallowed characters' });
    return;
  }

  if (user && !/^[a-zA-Z0-9_-]+$/.test(user)) {
    send({ type: 'exec_result', id, code: -1, stdout: '', stderr: 'Command rejected: invalid user' });
    return;
  }

  if (cwd && (cwd.includes('..') || !cwd.startsWith('/'))) {
    send({ type: 'exec_result', id, code: -1, stdout: '', stderr: 'Command rejected: invalid cwd' });
    return;
  }

  runningExec++;

  // Parse command into binary + args — no shell interpretation
  const parts = command.trim().split(/\s+/);
  const binary = parts[0];
  const cmdArgs = parts.slice(1);
  const spawnOpts = { cwd: cwd || '/tmp', env: { ...process.env, HOME: `/home/${user || CLIENT_USER || 'workspace'}` } };

  console.log(`[workspace-agent] exec: ${binary} ${cmdArgs.slice(0, 3).join(' ')}${cmdArgs.length > 3 ? '...' : ''} (${command.length} bytes)`);
  const child = user
    ? spawn('sudo', ['-u', user, binary, ...cmdArgs], spawnOpts)
    : spawn(binary, cmdArgs, spawnOpts);
  let stdout = '', stderr = '';
  let finished = false;

  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });

  child.on('close', code => {
    if (finished) return;
    finished = true;
    runningExec--;
    clearTimeout(execTimeout);
    send({ type: 'exec_result', id, code, stdout: stdout.slice(-8192), stderr: stderr.slice(-8192) });
  });

  child.on('error', (err) => {
    if (finished) return;
    finished = true;
    runningExec--;
    clearTimeout(execTimeout);
    send({ type: 'exec_result', id, code: 1, stdout: '', stderr: err.message });
  });

  const execTimeout = setTimeout(() => {
    if (finished) return;
    finished = true;
    runningExec--;
    try { child.kill('SIGKILL'); } catch {}
    send({ type: 'exec_result', id, code: -1, stdout: stdout.slice(-8192), stderr: stderr.slice(-8192) + '\nTimeout (300s)' });
  }, 300_000);
}

// ── scan ────────────────────────────────────────────────────────────────────

function handleScan() {
  const apps = [];
  const pm2Status = {};
  try {
    const list = execFileSync('pm2', ['jlist', '--no-color'], { encoding: 'utf-8', timeout: 5000 });
    for (const p of JSON.parse(list)) pm2Status[p.name] = p.pm2_env?.status || 'unknown';
  } catch {}
  try {
    if (fs.existsSync(APPS_DIR)) {
      for (const entry of fs.readdirSync(APPS_DIR)) {
        const manifestPath = path.join(APPS_DIR, entry, 'manifest.yml');
        if (fs.existsSync(manifestPath)) {
          try {
            const yaml = fs.readFileSync(manifestPath, 'utf8');
            const slugMatch = yaml.match(/^slug:\s*['"]?([^\s'"]+)/m);
            const slug = slugMatch ? slugMatch[1] : entry;
            const status = pm2Status[slug] || pm2Status[entry] || 'stopped';
            apps.push({ name: entry, slug, status, health: 'unknown' });
          } catch {
            apps.push({ name: entry, status: 'unknown', health: 'unknown' });
          }
        }
      }
    }
  } catch {}
  send({ type: 'scan_result', instances: apps });
}

// ── Health + Inter-App Messaging endpoint ───────────────────────────────────

function readHttpBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > maxBytes) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function httpJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * Deliver a message to a local app pm2 process by reading its port file
 * and POSTing to its HTTP server.
 * Port file convention: /tmp/{slug}-{name}.port (e.g. /tmp/agent-dev-01.port)
 */
async function deliverToLocalApp(slug, name, message) {
  try {
    // Validate slug and name to prevent path traversal in port file lookup
    if (!slug || !SAFE_SLUG.test(slug)) return false;
    if (!name || !SAFE_SLUG.test(name)) return false;
    const portFile = `/tmp/${slug}-${name}.port`;
    if (!fs.existsSync(portFile)) return false;
    const port = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
    if (!port) return false;

    // Fail-closed target apps (e.g. apps/agent /message + /reset) require
    // the per-install APP_BRIDGE_TOKEN on inbound deliveries. We generated
    // that token at install time and stored it in `_appBridgeTokens`; look
    // it up by the same (slug, name) key the pm2 env uses. If the token
    // is missing, drop the delivery (the target would 401 anyway) and log
    // — this is likely a stale port file from a previous bridge process
    // that lost its in-memory map on restart.
    const token = _appBridgeTokens.get(_appTokenKey(slug, name));
    if (!token) {
      console.warn(`[workspace-agent] No APP_BRIDGE_TOKEN for ${slug}/${name} — dropping delivery (stale port file?)`);
      return false;
    }
    const res = await fetch(`http://127.0.0.1:${port}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-App-Bridge-Token': token,
      },
      body: JSON.stringify(message),
    });
    return res.ok;
  } catch (err) {
    console.warn(`[workspace-agent] Failed to deliver to ${slug}/${name}:`, err.message);
    return false;
  }
}

const healthServer = http.createServer(async (req, res) => {
  const url = req.url?.split('?')[0];

  // GET /health (existing)
  if (req.method === 'GET' && (url === '/' || url === '/health')) {
    httpJson(res, 200, {
      ok: true,
      agentVersion: AGENT_VERSION,
      authenticated: routerAuthenticated,
      gateway: gatewayWs?.readyState === WebSocket.OPEN && gatewayAuthenticated ? 'connected' : 'disconnected',
      gateways: gateways.map(g => ({ slug: g.slug, port: g.port })),
      instanceId: INSTANCE_ID,
      uptime: process.uptime(),
    });
    return;
  }

  // POST /api/app-message — inter-app messaging (called by pm2 processes via curl)
  // Body: { from: { slug, name }, to: { slug, name }, message: "..." }
  // Shorthand: { from: "dev-01", to: "pm-01", message: "..." } (defaults slug to "agent")
  if (req.method === 'POST' && url === '/api/app-message') {
    const body = await readHttpBody(req);
    const { message } = body;
    const from = typeof body.from === 'string' ? { slug: 'agent', name: body.from } : body.from;
    const to = typeof body.to === 'string' ? { slug: 'agent', name: body.to } : body.to;

    if (!from?.name || !to?.name || !message) {
      httpJson(res, 400, { ok: false, error: 'from, to, and message are required' });
      return;
    }

    // HMAC token check — mirrors /api/agent-message. Same-worker only but
    // consistency matters: any loopback caller would otherwise impersonate
    // another pm2 process on the same bridge.
    try {
      const fromSlug = from.slug || 'agent';
      if (!SAFE_SLUG.test(fromSlug) || !SAFE_SLUG.test(from.name)) {
        httpJson(res, 400, { ok: false, error: 'invalid from components' });
        return;
      }
      const presentedToken = req.headers['x-app-bridge-token'];
      const expectedToken = _appBridgeTokens.get(_appTokenKey(fromSlug, from.name));
      if (typeof presentedToken !== 'string' || !expectedToken) {
        httpJson(res, 403, { ok: false, error: 'missing or unknown bridge token' });
        return;
      }
      const a = Buffer.from(presentedToken, 'utf8');
      const b = Buffer.from(expectedToken, 'utf8');
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        httpJson(res, 403, { ok: false, error: 'bridge token mismatch' });
        return;
      }
    } catch {
      httpJson(res, 403, { ok: false, error: 'from validation failed' });
      return;
    }

    const msg = {
      type: 'app_message',
      from,
      to,
      payload: { message },
    };

    // Try local delivery first (same bridge, skip router round-trip)
    const delivered = await deliverToLocalApp(to.slug, to.name, msg);
    if (!delivered) {
      // Not local — forward via router WS
      send(msg);
    }

    httpJson(res, 200, { ok: true });
    return;
  }

  // POST /api/agent-message — Sprint 2 track C inter-worker agent messaging
  // Body: { to: "domain/worker_id/com.xaiworkspace.agent/name", message, from? }
  //
  // Identity model: the caller is a loopback pm2 process. We DO NOT trust
  // a caller-supplied `from` for impersonation: the workerId in `from` is
  // always rewritten to this bridge's own INSTANCE_ID before forwarding.
  // The instance_name component must match a port file the bridge manages
  // (defence in depth — confirms an app actually owns the name it claims).
  if (req.method === 'POST' && url === '/api/agent-message') {
    const body = await readHttpBody(req);
    const to = body?.to;
    const text = body?.message;
    const from = body?.from; // required — agent must pass its own full address
    if (!to || !text || !from) {
      httpJson(res, 400, { ok: false, error: 'to, from, and message are required' });
      return;
    }
    const fromParsed = parseAgentAddress(from);
    const toParsed = parseAgentAddress(to);
    if (!fromParsed || !toParsed) {
      httpJson(res, 400, { ok: false, error: 'invalid address format' });
      return;
    }

    // Authoritative `from` rewrite: bind workerId to this bridge's identity.
    // Private addresses with a mismatched workerId are rejected outright.
    if (fromParsed.kind === 'private' && fromParsed.workerId && fromParsed.workerId !== INSTANCE_ID) {
      httpJson(res, 403, { ok: false, error: 'from.workerId does not match this bridge' });
      return;
    }

    // Primary identity boundary: per-app HMAC token injected at pm2 start as
    // APP_BRIDGE_TOKEN. The caller must present it as X-App-Bridge-Token; we
    // compare via timingSafeEqual against the token we generated for the
    // claimed `from` instance. Port-file existence remains as
    // defense-in-depth.
    try {
      const slug = slugFromIdentifier(fromParsed.appIdentifier);
      if (!slug || !SAFE_SLUG.test(slug) || !fromParsed.instanceName || !SAFE_SLUG.test(fromParsed.instanceName)) {
        httpJson(res, 400, { ok: false, error: 'invalid from address components' });
        return;
      }

      // HMAC token check (primary).
      const presentedToken = req.headers['x-app-bridge-token'];
      const expectedToken = _appBridgeTokens.get(_appTokenKey(slug, fromParsed.instanceName));
      if (typeof presentedToken !== 'string' || !expectedToken) {
        httpJson(res, 403, { ok: false, error: 'missing or unknown bridge token' });
        return;
      }
      const a = Buffer.from(presentedToken, 'utf8');
      const b = Buffer.from(expectedToken, 'utf8');
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        httpJson(res, 403, { ok: false, error: 'bridge token mismatch' });
        return;
      }

      // Port-file cross-check (defense in depth).
      const portFile = `/tmp/${slug}-${fromParsed.instanceName}.port`;
      if (!fs.existsSync(portFile)) {
        httpJson(res, 403, { ok: false, error: 'from.instanceName not running on this bridge' });
        return;
      }
    } catch {
      httpJson(res, 403, { ok: false, error: 'from validation failed' });
      return;
    }

    // Rebuild canonical from string from the (now-trusted) parts. For private
    // addresses we hard-bind workerId; for public we leave as-is.
    const trustedFrom = fromParsed.kind === 'private'
      ? `${fromParsed.domain || BRIDGE_DOMAIN}/${INSTANCE_ID}/${fromParsed.appIdentifier}/${fromParsed.instanceName}`
      : `${fromParsed.domain || BRIDGE_DOMAIN}/${fromParsed.appIdentifier}/${fromParsed.instanceName}`;

    const envelope = {
      from: trustedFrom,
      to,
      ts: Date.now(),
      msg_id: randomUUID(),
    };

    // All agent messages route via the router — even when sender and
    // receiver live on the same worker. This keeps `handleAgentMessage`'s
    // audit row (oc_agent_messages) and rate-limit enforcement uniformly
    // applied. The previous same-worker loopback shortcut bypassed both.
    send({ type: 'agent_message', envelope, payload: { message: text } });
    httpJson(res, 200, { ok: true, route: 'router' });
    return;
  }

  // POST /api/agent-response — agent sends result back to user (forwarded to router → frontend)
  // Body: { from: "domain/worker_id/com.xaiworkspace.agent/name", agentName, result }
  //
  // Same HMAC token check as /api/agent-message — any loopback caller otherwise
  // could POST here and impersonate an arbitrary agentName upstream.
  if (req.method === 'POST' && url === '/api/agent-response') {
    const body = await readHttpBody(req);
    const from = body?.from; // required — mirrors /api/agent-message shape
    if (!from) {
      httpJson(res, 400, { ok: false, error: 'from is required' });
      return;
    }
    const fromParsed = parseAgentAddress(from);
    if (!fromParsed) {
      httpJson(res, 400, { ok: false, error: 'invalid from address format' });
      return;
    }
    if (fromParsed.kind === 'private' && fromParsed.workerId && fromParsed.workerId !== INSTANCE_ID) {
      httpJson(res, 403, { ok: false, error: 'from.workerId does not match this bridge' });
      return;
    }
    try {
      const slug = slugFromIdentifier(fromParsed.appIdentifier);
      if (!slug || !SAFE_SLUG.test(slug) || !fromParsed.instanceName || !SAFE_SLUG.test(fromParsed.instanceName)) {
        httpJson(res, 400, { ok: false, error: 'invalid from address components' });
        return;
      }
      const presentedToken = req.headers['x-app-bridge-token'];
      const expectedToken = _appBridgeTokens.get(_appTokenKey(slug, fromParsed.instanceName));
      if (typeof presentedToken !== 'string' || !expectedToken) {
        httpJson(res, 403, { ok: false, error: 'missing or unknown bridge token' });
        return;
      }
      const a = Buffer.from(presentedToken, 'utf8');
      const b = Buffer.from(expectedToken, 'utf8');
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        httpJson(res, 403, { ok: false, error: 'bridge token mismatch' });
        return;
      }
      const portFile = `/tmp/${slug}-${fromParsed.instanceName}.port`;
      if (!fs.existsSync(portFile)) {
        httpJson(res, 403, { ok: false, error: 'from.instanceName not running on this bridge' });
        return;
      }
    } catch {
      httpJson(res, 403, { ok: false, error: 'from validation failed' });
      return;
    }

    send({
      type: 'agent_response',
      agentName: body.agentName,
      result: body.result,
    });
    httpJson(res, 200, { ok: true });
    return;
  }

  res.writeHead(404);
  res.end();
});

healthServer.listen(HEALTH_PORT, '127.0.0.1', () => {
  console.log(`[workspace-agent] Health on :${HEALTH_PORT}`);
});

// ── Startup ─────────────────────────────────────────────────────────────────

console.log(`[workspace-agent] v${AGENT_VERSION} starting — instance=${INSTANCE_ID} router=${ROUTER_URL}`);

// Discover gateways before connecting (so auth message includes port)
loadGateways();

// Connect to router first; gateway connection initiated after router auth
connectRouter();

// ── Graceful shutdown ───────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`[workspace-agent] ${signal} — shutting down`);
  shuttingDown = true;
  if (routerReconnectTimer) clearTimeout(routerReconnectTimer);
  if (gatewayReconnectTimer) clearTimeout(gatewayReconnectTimer);
  try { routerWs?.close(1000, 'Agent shutdown'); } catch {}
  try { gatewayWs?.close(1000, 'Agent shutdown'); } catch {}
  try { healthServer.close(); } catch {}
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (process.send) process.send('ready');
