#!/usr/bin/env node
// ── Workspace Agent v1.1.0 ──────────────────────────────────────────────────
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
// Environment (from /etc/openclaw/secrets.env):
//   ROUTER_URL, INSTANCE_ID, INSTANCE_TOKEN, CHAT_ID, PORT, GW_PASSWORD
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const AGENT_VERSION = '1.1.0';

const http = require('http');
const { execSync, execFileSync } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(require('child_process').exec);
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// ── Load secrets from env file ──────────────────────────────────────────────

const SECRETS_FILE = '/etc/openclaw/secrets.env';
if (fs.existsSync(SECRETS_FILE)) {
  for (const line of fs.readFileSync(SECRETS_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const ROUTER_URL     = process.env.ROUTER_URL || 'https://router.xaiworkspace.com';
const INSTANCE_ID    = process.env.INSTANCE_ID || '';
const INSTANCE_TOKEN = process.env.INSTANCE_TOKEN || '';
const CHAT_ID        = process.env.CHAT_ID || '';
const GW_PASSWORD    = process.env.GW_PASSWORD || '';
const CLIENT_USER    = process.env.CLIENT_USER || '';
const HOME           = process.env.HOME || `/home/${CLIENT_USER || 'workspace'}`;
const HEALTH_PORT    = parseInt(process.env.BRIDGE_HEALTH_PORT || '19099', 10);
const APPS_DIR       = path.join(HOME, 'apps');

const OC_CONFIG_PATH = path.join(HOME, '.openclaw', 'openclaw.json');

// ── Input validation patterns ───────────────────────────────────────────────

const SAFE_SLUG       = /^[a-z0-9][a-z0-9._-]*$/;
const SAFE_IDENTIFIER = /^[a-zA-Z0-9._-]+$/;
const SAFE_GH_SUBDIR  = /^[a-zA-Z0-9._/-]+$/;
const VALID_ENV_KEY   = /^[A-Z_][A-Z0-9_]*$/;

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

function loadGateways() {
  const found = [];
  try {
    if (!fs.existsSync(APPS_DIR)) return found;
    for (const entry of fs.readdirSync(APPS_DIR)) {
      const manifestPath = path.join(APPS_DIR, entry, 'manifest.yml');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const raw = fs.readFileSync(manifestPath, 'utf8');
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
      } catch {}
    }
  } catch {}
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
    console.log('[workspace-agent] Connected, authenticating...');
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
      case 'restart_app':   handleRestartApp(msg); return;
      case 'list_apps':     handleListApps(msg); return;
      case 'exec':          handleExec(msg); return;
      case 'scan':          handleScan(); return;
      case 'config_update': handleConfigUpdate(msg); return;
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
    if (gatewayWs === ws) gatewayWs = null;
    scheduleGatewayReconnect();
  });
}

function scheduleGatewayReconnect() {
  if (gatewayReconnectTimer || shuttingDown) return;
  const delay = backoff(gatewayReconnectAttempt++);
  gatewayReconnectTimer = setTimeout(connectGateway, delay);
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

function sendProgress(id, slug, stage, percent) {
  send({ type: 'install_progress', id, slug, stage, percent });
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
      try { execSync('pm2 restart openclaw --no-color', { timeout: 10000 }); } catch {}
    }
  } catch (err) {
    console.error(`[workspace-agent] Config update failed: ${err.message}`);
  } finally {
    try { fs.unlinkSync(pullFlag); } catch {}
  }
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

function reportInstalledApps() {
  try {
    const list = execSync('pm2 jlist --no-color', { encoding: 'utf-8', timeout: 5000 });
    const procs = JSON.parse(list);
    const systemProcs = new Set(['workspace-agent', 'bootstrap-bridge', 'bridge', 'updater']);
    const apps = procs
      .filter(p => !systemProcs.has(p.name))
      .map(p => ({
        slug: p.name,
        status: p.pm2_env?.status || 'unknown',
        version: readManifestVersion(p.name),
        restarts: p.pm2_env?.restart_time || 0,
        memory: p.monit?.memory || 0,
        cpu: p.monit?.cpu || 0,
      }));
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

const TRUSTED_DOMAINS = new Set([
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'raw.githubusercontent.com',
  'registry.npmjs.org',
  'xaiworkspace.com',
  'router.xaiworkspace.com',
]);

function isUrlTrusted(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return TRUSTED_DOMAINS.has(parsed.hostname)
      || [...TRUSTED_DOMAINS].some(d => parsed.hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

// ── install_app ─────────────────────────────────────────────────────────────

const _installingApps = new Set();

async function handleInstallApp(msg) {
  const { id, slug, identifier, artifactUrl, sourceUrl, subdir, env, manifest } = msg;

  if (_installingApps.has(slug)) {
    console.log('[workspace-agent] Skipping duplicate install for ' + slug);
    return;
  }
  _installingApps.add(slug);

  if (!slug || !SAFE_SLUG.test(slug)) {
    send({ type: 'install_result', id, slug, status: 'error', error: 'Invalid slug' });
    _installingApps.delete(slug);
    return;
  }

  if (identifier && !SAFE_IDENTIFIER.test(identifier)) {
    send({ type: 'install_result', id, slug, status: 'error', error: 'Invalid identifier' });
    _installingApps.delete(slug);
    return;
  }

  const appDir = path.join(APPS_DIR, identifier || `com.xshopper.${slug}`);

  if (!path.resolve(appDir).startsWith(path.resolve(APPS_DIR))) {
    send({ type: 'install_result', id, slug, status: 'error', error: 'Invalid identifier' });
    _installingApps.delete(slug);
    return;
  }

  console.log(`[workspace-agent] Installing app: ${slug} -> ${appDir}`);

  if (artifactUrl && !isUrlTrusted(artifactUrl)) {
    const domain = (() => { try { return new URL(artifactUrl).hostname; } catch { return 'invalid'; } })();
    console.error(`[workspace-agent] Install rejected for ${slug}: untrusted artifact URL domain: ${domain}`);
    send({ type: 'install_result', id, slug, status: 'error', error: `Untrusted artifact URL domain: ${domain}` });
    _installingApps.delete(slug);
    return;
  }
  if (sourceUrl && !isUrlTrusted(sourceUrl)) {
    const domain = (() => { try { return new URL(sourceUrl).hostname; } catch { return 'invalid'; } })();
    console.error(`[workspace-agent] Install rejected for ${slug}: untrusted source URL domain: ${domain}`);
    send({ type: 'install_result', id, slug, status: 'error', error: `Untrusted source URL domain: ${domain}` });
    _installingApps.delete(slug);
    return;
  }

  try {
    // 1. Write env vars to secrets.env
    const addedKeys = [];
    if (env && typeof env === 'object') {
      sendProgress(id, slug, 'configuring', 5);
      let existing = '';
      try { existing = fs.readFileSync(SECRETS_FILE, 'utf8'); } catch {}
      for (const [k, v] of Object.entries(env)) {
        if (!VALID_ENV_KEY.test(k)) {
          console.warn(`[workspace-agent] Skipping invalid env key: ${k}`);
          continue;
        }
        const sanitized = String(v).replace(/[\n\r`$\\;|&"']/g, '');
        if (!existing.includes(`${k}=`)) {
          fs.appendFileSync(SECRETS_FILE, `${k}=${sanitized}\n`);
          addedKeys.push(k);
        }
        process.env[k] = sanitized;
      }
    }

    // 2. Download artifact
    sendProgress(id, slug, 'downloading', 10);
    fs.mkdirSync(appDir, { recursive: true });

    if (addedKeys.length > 0) {
      fs.writeFileSync(path.join(appDir, '.env-keys'), addedKeys.join('\n'));
    }

    if (artifactUrl) {
      const tmpFile = `/tmp/app-${slug}-${(id || '').slice(0,8)}.zip`;
      await execAsync(`curl -sfL "${artifactUrl}" -o "${tmpFile}"`, { timeout: 60000 });

      if (msg.sha256) {
        const crypto = require('crypto');
        const fileBuffer = fs.readFileSync(tmpFile);
        const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        if (hash !== msg.sha256) {
          send({ type: 'install_result', id, slug, status: 'error', error: `Artifact integrity check failed (expected ${msg.sha256.slice(0, 8)}..., got ${hash.slice(0, 8)}...)` });
          try { fs.unlinkSync(tmpFile); } catch {}
          return;
        }
        console.log(`[workspace-agent] Artifact integrity verified: ${hash.slice(0, 8)}...`);
      }

      sendProgress(id, slug, 'extracting', 30);
      const tmpDir = `/tmp/app-${slug}-${(id || '').slice(0,8)}-extract`;
      await execAsync(`rm -rf "${tmpDir}" && mkdir -p "${tmpDir}" && unzip -qo "${tmpFile}" -d "${tmpDir}"`, { timeout: 30000 });

      const entries = fs.readdirSync(tmpDir);
      let src = entries.length === 1 && fs.statSync(path.join(tmpDir, entries[0])).isDirectory()
        ? path.join(tmpDir, entries[0])
        : tmpDir;

      if (subdir) {
        const sub = path.join(src, subdir);
        if (fs.existsSync(sub)) {
          src = sub;
          console.log('[workspace-agent] Using subdir: ' + subdir);
        }
      }

      await execAsync(`cp -a "${src}/." "${appDir}/"`, { timeout: 15000 });
      await execAsync(`rm -rf "${tmpFile}" "${tmpDir}"`);
    } else if (sourceUrl) {
      const ghMatch = sourceUrl.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/tree\/([^/]+)\/(.+)$/);
      if (ghMatch) {
        const repoUrl = ghMatch[1] + '.git';
        const ghSubdir = ghMatch[3];
        if (!SAFE_GH_SUBDIR.test(ghSubdir) || ghSubdir.includes('..')) {
          throw new Error('Invalid GitHub subdirectory path: ' + ghSubdir);
        }
        const tmpSparse = '/tmp/sparse-' + slug;
        await execAsync('rm -rf ' + tmpSparse, { timeout: 5000 }).catch(() => {});
        await execAsync('git clone --depth 1 --filter=blob:none --sparse "' + repoUrl + '" ' + tmpSparse, { timeout: 120000 });
        await execAsync('cd ' + tmpSparse + ' && git sparse-checkout set "' + ghSubdir + '"', { timeout: 30000 });
        await execAsync('cp -a "' + tmpSparse + '/' + ghSubdir + '/." "' + appDir + '/"', { timeout: 15000 });
        await execAsync('rm -rf ' + tmpSparse, { timeout: 5000 }).catch(() => {});
      } else {
        await execAsync(`git clone --depth 1 "${sourceUrl}" "${appDir}" 2>/dev/null || (cd "${appDir}" && git pull)`, { timeout: 120000 });
      }
    }

    // 3. Run install.sh if present
    sendProgress(id, slug, 'installing', 50);
    const installScript = path.join(appDir, 'scripts', 'install.sh');
    if (fs.existsSync(installScript)) {
      await execAsync(`bash "${installScript}"`, {
        cwd: appDir,
        env: { ...process.env, APP_DIR: appDir, HOME },
        timeout: 120000,
      });
    }

    // 4. Install deps if package.json exists
    const pkgJson = path.join(appDir, 'package.json');
    if (fs.existsSync(pkgJson) && !fs.existsSync(path.join(appDir, 'node_modules'))) {
      await execAsync('pnpm install --prod --reporter=silent', { cwd: appDir, timeout: 120000 });
    }

    // 5. Regenerate ecosystem and restart pm2
    sendProgress(id, slug, 'starting', 80);
    const genScript = path.join(appDir, 'scripts', 'generate-ecosystem.sh');
    if (fs.existsSync(genScript)) {
      await execAsync(`bash "${genScript}"`, {
        cwd: appDir,
        env: { ...process.env, APP_DIR: appDir, HOME },
        timeout: 30000,
      });
    }

    const ecoFile = path.join(appDir, 'ecosystem.config.js');
    if (fs.existsSync(ecoFile)) {
      await execAsync(`pm2 start "${ecoFile}" --update-env`, { timeout: 30000 });
    } else if (manifest?.startup) {
      const startupCmd = manifest.startup;
      const eco = 'module.exports = { apps: [{ name: ' + JSON.stringify(slug) + ', script: "/bin/bash", args: ["-c", ' + JSON.stringify(startupCmd) + '], cwd: ' + JSON.stringify(appDir) + ', autorestart: true }] };';
      fs.writeFileSync(ecoFile, eco);
      await execAsync(`pm2 start "${ecoFile}" --update-env`, { timeout: 30000 });
    }

    sendProgress(id, slug, 'complete', 100);
    send({ type: 'install_result', id, slug, status: 'ok' });
    console.log(`[workspace-agent] App installed: ${slug}`);

    // Re-scan gateways — the new app might declare one
    const oldGateways = gateways.length;
    loadGateways();
    if (gateways.length > oldGateways && (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN)) {
      connectGateway();
    }
  } catch (err) {
    console.error(`[workspace-agent] Install failed for ${slug}:`, err.message);
    send({ type: 'install_result', id, slug, status: 'error', error: err.message });
  } finally {
    _installingApps.delete(slug);
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
      execSync(`bash "${uninstallScript}"`, { cwd: appDir, timeout: 30000, stdio: 'inherit' });
    }

    try { execFileSync('pm2', ['delete', `app-${slug}`], { timeout: 10000 }); } catch {}
    try { execFileSync('pm2', ['delete', slug], { timeout: 10000 }); } catch {}

    // Clean up env vars
    try {
      const envKeysFile = path.join(appDir, '.env-keys');
      if (fs.existsSync(envKeysFile)) {
        const keysToRemove = fs.readFileSync(envKeysFile, 'utf8').split('\n').filter(Boolean);
        if (keysToRemove.length > 0) {
          let secrets = fs.readFileSync(SECRETS_FILE, 'utf8');
          for (const key of keysToRemove) {
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

    // Re-scan gateways — the removed app might have had one
    loadGateways();
  } catch (err) {
    send({ type: 'uninstall_result', id, slug, status: 'error', error: err.message });
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

  if (/[;`]/.test(command)) {
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

  const args = user
    ? ['sudo', ['-u', user, 'bash', '-c', command], { cwd: cwd || '/tmp' }]
    : ['bash', ['-c', command], { cwd: cwd || '/tmp' }];

  console.log(`[workspace-agent] exec: ${command.slice(0, 60)}... (${command.length} bytes)`);
  const child = spawn(args[0], args[1], { ...args[2], detached: true, env: { ...process.env, HOME: `/home/${user || CLIENT_USER || 'workspace'}` } });
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
    if (child.pid > 0) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    } else {
      try { child.kill('SIGKILL'); } catch {}
    }
    send({ type: 'exec_result', id, code: -1, stdout: stdout.slice(-8192), stderr: stderr.slice(-8192) + '\nTimeout (300s)' });
  }, 300_000);
}

// ── scan ────────────────────────────────────────────────────────────────────

function handleScan() {
  const apps = [];
  try {
    if (fs.existsSync(APPS_DIR)) {
      for (const entry of fs.readdirSync(APPS_DIR)) {
        const manifestPath = path.join(APPS_DIR, entry, 'manifest.yml');
        if (fs.existsSync(manifestPath)) {
          apps.push({ name: entry, status: 'running', health: 'unknown' });
        }
      }
    }
  } catch {}
  send({ type: 'scan_result', instances: apps });
}

// ── Health endpoint ─────────────────────────────────────────────────────────

const healthServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    agentVersion: AGENT_VERSION,
    authenticated: routerAuthenticated,
    gateway: gatewayWs?.readyState === WebSocket.OPEN && gatewayAuthenticated ? 'connected' : 'disconnected',
    gateways: gateways.map(g => ({ slug: g.slug, port: g.port })),
    instanceId: INSTANCE_ID,
    uptime: process.uptime(),
  }));
});

healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
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
