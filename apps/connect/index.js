/**
 * @connect mini-app — OAuth connection manager
 *
 * Exposes an MCP server (JSON-RPC over HTTP) so other mini-apps and agents can
 * read and manage the user's third-party OAuth connections. All token material
 * stays router-side; this process is a thin proxy that forwards every call to
 * the router's `/api/oauth/connections*` endpoints over HTTPS.
 *
 * MCP tools:
 *   - get_token({ provider })       → { access_token, expires_at }
 *   - list_connections()            → { connections: [...] }
 *   - is_connected({ provider })    → { connected: boolean }
 *   - disconnect({ provider })      → { ok: true }
 *
 * Auth model:
 *   The mini-app authenticates to the router using the standard mini-app
 *   credentials provided by the bridge in its environment:
 *     - ANTHROPIC_API_KEY  — LiteLLM virtual key (Bearer)
 *     - ROUTER_URL         — router base URL (https)
 *
 * After startup the process registers itself with the router as an MCP server
 * so LiteLLM can route MCP JSON-RPC traffic back into us:
 *     POST {ROUTER_URL}/api/mcp/register   { appSlug, port }
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// ─── Configuration ──────────────────────────────────────────────────────────

const APP_SLUG = 'connect';
const PORT = parseInt(process.env.APP_PORT || '3470', 10);
const ROUTER_URL = (process.env.ROUTER_URL || 'https://router.xaiworkspace.com').replace(/\/$/, '');
const API_KEY = process.env.ANTHROPIC_API_KEY || '';

if (!API_KEY) {
  console.error('[connect] ANTHROPIC_API_KEY is required (mini-app credentials missing)');
  process.exit(1);
}

const FETCH_TIMEOUT_MS = 10_000;

// ─── MCP inbound auth (shared secret) ───────────────────────────────────────
//
// The MCP HTTP server binds 127.0.0.1 but any local process on the same host
// could otherwise call `get_token` and exfiltrate OAuth tokens. Require an
// `X-MCP-Secret` header on every inbound request. The secret is either
// provided via the `MCP_CONNECT_SECRET` env var (so the bridge/router can
// share it out-of-band) or generated at startup and written to a 0600 file
// that only the owning pm2 process (same uid) can read.
const MCP_SECRET = process.env.MCP_CONNECT_SECRET || crypto.randomBytes(32).toString('hex');
const MCP_SECRET_BUF = Buffer.from(MCP_SECRET, 'utf8');
const MCP_SECRET_FILE = join(tmpdir(), `connect-mcp-${process.pid}.secret`);

try {
  writeFileSync(MCP_SECRET_FILE, MCP_SECRET, { mode: 0o600 });
} catch (err) {
  console.error(`[connect] failed to write MCP secret file ${MCP_SECRET_FILE}: ${err.message}`);
  process.exit(1);
}

function cleanupSecretFile() {
  try { unlinkSync(MCP_SECRET_FILE); } catch { /* already gone */ }
}

function checkMcpAuth(req) {
  const header = req.headers['x-mcp-secret'];
  if (!header || typeof header !== 'string') return false;
  const provided = Buffer.from(header, 'utf8');
  if (provided.length !== MCP_SECRET_BUF.length) return false;
  try {
    return crypto.timingSafeEqual(provided, MCP_SECRET_BUF);
  } catch {
    return false;
  }
}

// ─── Router HTTP client ─────────────────────────────────────────────────────

async function routerFetch(method, path, body) {
  const url = `${ROUTER_URL}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error(data?.error || `Router HTTP ${res.status}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ─── MCP tool implementations ───────────────────────────────────────────────

async function tool_listConnections() {
  const data = await routerFetch('GET', '/api/oauth/connections');
  return { connections: data?.connections || [] };
}

async function tool_isConnected(args) {
  const provider = sanitizeProvider(args?.provider);
  const data = await routerFetch('GET', '/api/oauth/connections');
  const found = (data?.connections || []).some(c => c.provider === provider);
  return { connected: found };
}

async function tool_getToken(args) {
  const provider = sanitizeProvider(args?.provider);
  const data = await routerFetch('GET', `/api/oauth/connections/${encodeURIComponent(provider)}/token`);
  return {
    access_token: data?.access_token || null,
    expires_at: data?.expires_at || null,
  };
}

async function tool_disconnect(args) {
  const provider = sanitizeProvider(args?.provider);
  await routerFetch('DELETE', `/api/oauth/connections/${encodeURIComponent(provider)}`);
  return { ok: true };
}

function sanitizeProvider(p) {
  if (!p || typeof p !== 'string') throw new Error('provider is required');
  if (!/^[a-z0-9][a-z0-9_-]{0,49}$/.test(p)) throw new Error('invalid provider name');
  return p;
}

// ─── MCP JSON-RPC dispatcher ────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_connections',
    description: "List all of the user's OAuth connections (provider, account, expiry).",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: tool_listConnections,
  },
  {
    name: 'is_connected',
    description: 'Check whether the user has an active connection for a given provider.',
    inputSchema: {
      type: 'object',
      properties: { provider: { type: 'string', description: 'Provider slug, e.g. "google"' } },
      required: ['provider'],
      additionalProperties: false,
    },
    handler: tool_isConnected,
  },
  {
    name: 'get_token',
    description: "Get the user's current access token for a provider. Refreshes server-side if needed.",
    inputSchema: {
      type: 'object',
      properties: { provider: { type: 'string' } },
      required: ['provider'],
      additionalProperties: false,
    },
    handler: tool_getToken,
  },
  {
    name: 'disconnect',
    description: "Remove the user's OAuth connection for a given provider.",
    inputSchema: {
      type: 'object',
      properties: { provider: { type: 'string' } },
      required: ['provider'],
      additionalProperties: false,
    },
    handler: tool_disconnect,
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map(t => [t.name, t]));

async function handleJsonRpc(payload) {
  const { id = null, method, params = {} } = payload || {};

  try {
    if (method === 'initialize') {
      return rpcResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: '@connect', version: PKG_VERSION },
      });
    }

    if (method === 'tools/list') {
      return rpcResult(id, {
        tools: TOOLS.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      const tool = TOOLS_BY_NAME.get(name);
      if (!tool) return rpcError(id, -32601, `Unknown tool: ${name}`);
      const result = await tool.handler(args || {});
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      });
    }

    return rpcError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    console.error(`[connect] tool error (${method}):`, err.message);
    return rpcError(id, -32000, err.message || 'Internal error');
  }
}

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

// ─── HTTP server (MCP transport) ────────────────────────────────────────────

const MAX_BODY = 256 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > MAX_BODY) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true, app: APP_SLUG, tools: TOOLS.map(t => t.name) });
  }

  // MCP transport — POST / accepts JSON-RPC
  if (req.method === 'POST' && (req.url === '/' || req.url === '/mcp')) {
    if (!checkMcpAuth(req)) {
      return sendJson(res, 401, rpcError(null, -32001, 'Unauthorized: missing or invalid X-MCP-Secret header'));
    }
    try {
      const body = await readBody(req);
      const response = await handleJsonRpc(body);
      return sendJson(res, 200, response);
    } catch (err) {
      return sendJson(res, 400, rpcError(null, -32700, `Parse error: ${err.message}`));
    }
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`[connect] MCP server listening on http://127.0.0.1:${PORT}`);
  console.log(`[connect] MCP auth: callers must send header 'X-MCP-Secret: <secret>'`);
  console.log(`[connect] MCP secret file (0600, pid-scoped): ${MCP_SECRET_FILE}`);
  await registerWithRouter().catch(err => {
    console.error('[connect] MCP registration failed (will retry on next startup):', err.message);
  });
});

server.on('error', err => {
  console.error('[connect] server error:', err.message);
  process.exit(1);
});

// ─── MCP self-registration ──────────────────────────────────────────────────

async function registerWithRouter() {
  // Retry with exponential backoff — the router may not be ready yet on
  // a cold bridge boot. After exhausting retries we log and continue running:
  // direct calls to /mcp still work, just registry-mediated discovery won't.
  const delaysMs = [1000, 3000, 9000];
  let lastErr = null;
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      const data = await routerFetch('POST', '/api/mcp/register', {
        appSlug: APP_SLUG,
        port: PORT,
      });
      console.log(`[connect] Registered with router as MCP server ${data?.server?.appSlug || APP_SLUG} (attempt ${attempt + 1})`);
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`[connect] MCP register attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt < delaysMs.length) {
        await new Promise(r => setTimeout(r, delaysMs[attempt]));
      }
    }
  }
  console.error(`[connect] MCP registration failed after ${delaysMs.length + 1} attempts: ${lastErr?.message}. Continuing without registry — direct /mcp calls still work.`);
}

// ─── Graceful shutdown ──────────────────────────────────────────────────────

async function shutdown(signal) {
  console.log(`[connect] ${signal} — shutting down`);
  try {
    // Force-drain slow connections so server.close() resolves promptly,
    // then await close so in-flight requests complete cleanly.
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise(resolve => server.close(() => resolve()));
  } catch (err) {
    console.warn(`[connect] shutdown error: ${err.message}`);
  }
  cleanupSecretFile();
  process.exit(0);
}

process.on('exit', cleanupSecretFile);

process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
