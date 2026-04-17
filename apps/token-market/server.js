/**
 * Token Market — HTTP server (port 3460)
 *
 * Marketplace for sharing AI model API access via LiteLLM virtual keys.
 * Talks to:
 *   - CLIProxyAPI (localhost:4001) — discover user's registered models/keys
 *   - Router API (ROUTER_URL)     — master cliproxy, listings DB, revenue log
 *   - LiteLLM (LITELLM_URL)      — virtual key management
 */

import http from 'node:http';
import { URL } from 'node:url';
import crypto from 'node:crypto';
import { PricingEngine } from './lib/pricing-engine.js';
import { HealthMonitor } from './lib/health-monitor.js';
import { RevenueLogger, REVENUE_LOGGING_ENABLED, REVENUE_LOGGING_DISABLED_REASON } from './lib/revenue-logger.js';
import { LitellmClient } from './lib/litellm-client.js';

const PORT = parseInt(process.env.APP_PORT ?? '3460', 10);
const ROUTER_URL = process.env.ROUTER_URL ?? process.env.ANTHROPIC_BASE_URL?.replace(/\/v1$/, '') ?? '';
const LITELLM_URL = process.env.LITELLM_URL ?? 'http://localhost:4000';
const CLIPROXY_URL = 'http://localhost:4001';
const PLATFORM_KEY = process.env.ANTHROPIC_API_KEY ?? 'local-only';
const BRIDGE_TOKEN = process.env.APP_BRIDGE_TOKEN ?? '';
// Webhook secret for LiteLLM → /hooks/completion. Must be a dedicated secret
// provisioned separately from APP_BRIDGE_TOKEN (which is the per-app
// router↔bridge credential). Sharing the two would mean anyone with
// BRIDGE_TOKEN (or any LiteLLM admin) could authenticate either surface
// against the other. We refuse to fall back; if LITELLM_WEBHOOK_SECRET is
// unset the webhook endpoint rejects all requests until the operator sets
// it explicitly.
const WEBHOOK_SECRET = process.env.LITELLM_WEBHOOK_SECRET ?? '';
if (!WEBHOOK_SECRET) {
  console.warn('[token-market] WARNING: LITELLM_WEBHOOK_SECRET is not set — /hooks/completion will reject ALL requests (401). Set LITELLM_WEBHOOK_SECRET to the shared secret configured on the LiteLLM callback.');
}
const WEBHOOK_SECRET_BUF = WEBHOOK_SECRET ? Buffer.from(WEBHOOK_SECRET, 'utf8') : null;

// ── Subsystems ───────────────────────────────────────────────────────────

const pricingEngine = new PricingEngine();
const healthMonitor = new HealthMonitor(ROUTER_URL, PLATFORM_KEY);
const revenueLogger = new RevenueLogger(ROUTER_URL, PLATFORM_KEY);
const litellm = new LitellmClient(LITELLM_URL, PLATFORM_KEY);

// ── Helpers ──────────────────────────────────────────────────────────────

// Cap HTTP body size at 1 MB. The completion hook is by far the largest
// request body (LiteLLM forwards the full request/response envelope) and
// all other handlers deal with small JSON, so 1 MB is plenty while still
// protecting us from memory-exhaustion DoS via unbounded bodies.
const MAX_BODY = 1024 * 1024;

/** Read full request body as string. Rejects if body exceeds MAX_BODY. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_BODY) {
        req.destroy();
        reject(new Error(`Body too large (max ${MAX_BODY} bytes)`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

/** Parse JSON body, return null on failure. */
async function jsonBody(req) {
  try {
    return JSON.parse(await readBody(req));
  } catch {
    return null;
  }
}

/** Send JSON response. */
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/** Extract auth token from Authorization header. */
function authToken(req) {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : h;
}

/** Proxy a request to the router API. */
async function routerFetch(method, path, token, body) {
  const url = `${ROUTER_URL}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Router ${method} ${path} → ${resp.status}: ${text}`);
  }
  return resp.json();
}

/** Fetch models from local CLIProxyAPI. */
async function getLocalModels() {
  try {
    const resp = await fetch(`${CLIPROXY_URL}/v1/models`, {
      headers: { Authorization: 'Bearer local-only' },
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.data ?? [];
  } catch {
    return [];
  }
}

// ── Route handlers ───────────────────────────────────────────────────────

const routes = new Map();

/** GET /health — server health check */
routes.set('GET /health', (_req, res) => {
  json(res, 200, {
    ok: true,
    version: '0.1.0',
    port: PORT,
    // Revenue logging is currently disabled (dropped records logged in warn).
    // Surfacing this here so operators can tell at a glance that no billing
    // data is being collected — critical signal for a marketplace app.
    revenueLogging: REVENUE_LOGGING_ENABLED,
    revenueLoggingDisabledReason: REVENUE_LOGGING_ENABLED ? undefined : REVENUE_LOGGING_DISABLED_REASON,
  });
});

// ── Models (local inventory) ─────────────────────────────────────────────

/** GET /models — list models from local cliproxy that can be listed on the market */
routes.set('GET /models', async (_req, res) => {
  const models = await getLocalModels();
  json(res, 200, { models });
});

// ── Listings ─────────────────────────────────────────────────────────────

/** GET /listings — browse marketplace (proxy to router) */
routes.set('GET /listings', async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const allowed = new URLSearchParams();
  for (const key of ['provider', 'model', 'page', 'limit']) {
    if (url.searchParams.has(key)) allowed.set(key, url.searchParams.get(key));
  }
  const qs = allowed.toString();
  const data = await routerFetch('GET', `/api/market/listings${qs ? `?${qs}` : ''}`, authToken(req));
  json(res, 200, data);
});

/** GET /listings/mine — current user's listings */
routes.set('GET /listings/mine', async (req, res) => {
  const data = await routerFetch('GET', '/api/market/my-listings', authToken(req));
  json(res, 200, data);
});

/** POST /listings — create a new listing */
routes.set('POST /listings', async (req, res) => {
  const body = await jsonBody(req);
  if (!body) return json(res, 400, { error: 'Invalid JSON' });
  const data = await routerFetch('POST', '/api/market/listings', authToken(req), body);
  json(res, 201, data);
});

/** PUT /listings/:id — update a listing */
routes.set('PUT /listings/:id', async (req, res, params) => {
  const body = await jsonBody(req);
  if (!body) return json(res, 400, { error: 'Invalid JSON' });
  const data = await routerFetch('PUT', `/api/market/listings/${params.id}`, authToken(req), body);
  json(res, 200, data);
});

/** DELETE /listings/:id — remove a listing */
routes.set('DELETE /listings/:id', async (req, res, params) => {
  const data = await routerFetch('DELETE', `/api/market/listings/${params.id}`, authToken(req));
  json(res, 200, data);
});

// ── Subscriptions ────────────────────────────────────────────────────────

/** GET /subscriptions — current user's subscriptions */
routes.set('GET /subscriptions', async (req, res) => {
  const data = await routerFetch('GET', '/api/market/subscriptions', authToken(req));
  json(res, 200, data);
});

/** POST /subscriptions/:listingId — subscribe to a listing */
routes.set('POST /subscriptions/:listingId', async (req, res, params) => {
  const token = authToken(req);
  // Refuse new subscriptions to listings whose circuit breaker is open —
  // otherwise we'd create buyer-visible subscriptions + virtual keys that
  // are guaranteed to fail until the seller's key recovers.
  if (!healthMonitor.isHealthy(params.listingId)) {
    return json(res, 503, {
      error: 'Listing is temporarily unavailable (circuit breaker open). Try again later.',
      listingId: params.listingId,
    });
  }
  // 1. Ask router to create subscription record
  const sub = await routerFetch('POST', `/api/market/subscribe/${params.listingId}`, token);
  // 2. Generate LiteLLM virtual key scoped to the listing's model
  if (sub.listing) {
    try {
      const vkey = await litellm.createVirtualKey({
        models: [sub.listing.model_id],
        metadata: {
          subscription_id: sub.id,
          buyer_id: sub.buyer_id,
          seller_id: sub.listing.seller_id,
        },
      });
      // 3. Store virtual key reference back to router
      await routerFetch('PUT', `/api/market/subscriptions/${sub.id}`, token, {
        virtual_key: vkey.key,
        litellm_key_id: vkey.key_name,
      });
      sub.virtual_key = vkey.key;
    } catch (err) {
      console.error('LiteLLM virtual key creation failed:', err.message);
      // Subscription created but no virtual key — buyer can retry
    }
  }
  json(res, 201, sub);
});

/** DELETE /subscriptions/:id — unsubscribe */
routes.set('DELETE /subscriptions/:id', async (req, res, params) => {
  const token = authToken(req);
  // 1. Get subscription to find virtual key
  const sub = await routerFetch('GET', `/api/market/subscriptions/${params.id}`, token).catch(() => null);
  // 2. Revoke LiteLLM virtual key
  if (sub?.litellm_key_id) {
    await litellm.deleteVirtualKey(sub.litellm_key_id).catch((err) =>
      console.error('LiteLLM key revocation failed:', err.message),
    );
  }
  // 3. Delete subscription in router
  const data = await routerFetch('DELETE', `/api/market/subscribe/${params.id}`, token);
  json(res, 200, data);
});

// ── Pricing strategies ───────────────────────────────────────────────────

/** GET /pricing — list user's pricing strategies */
routes.set('GET /pricing', async (req, res) => {
  const data = await routerFetch('GET', '/api/market/pricing-strategies', authToken(req));
  json(res, 200, data);
});

/** POST /pricing — create pricing strategy */
routes.set('POST /pricing', async (req, res) => {
  const body = await jsonBody(req);
  if (!body) return json(res, 400, { error: 'Invalid JSON' });

  // Validate JS code in sandbox before saving
  const validation = await pricingEngine.validate(body.code ?? '');
  if (!validation.valid) {
    return json(res, 422, { error: 'Invalid pricing strategy', details: validation.error });
  }

  const data = await routerFetch('POST', '/api/market/pricing-strategies', authToken(req), {
    ...body,
    is_valid: true,
  });
  json(res, 201, data);
});

/** PUT /pricing/:id — update pricing strategy */
routes.set('PUT /pricing/:id', async (req, res, params) => {
  const body = await jsonBody(req);
  if (!body) return json(res, 400, { error: 'Invalid JSON' });

  if (body.code) {
    const validation = await pricingEngine.validate(body.code);
    if (!validation.valid) {
      return json(res, 422, { error: 'Invalid pricing strategy', details: validation.error });
    }
    body.is_valid = true;
  }

  const data = await routerFetch('PUT', `/api/market/pricing-strategies/${params.id}`, authToken(req), body);
  json(res, 200, data);
});

/** DELETE /pricing/:id — delete pricing strategy */
routes.set('DELETE /pricing/:id', async (req, res, params) => {
  const data = await routerFetch('DELETE', `/api/market/pricing-strategies/${params.id}`, authToken(req));
  json(res, 200, data);
});

/** POST /pricing/:id/test — dry-run a pricing strategy */
routes.set('POST /pricing/:id/test', async (req, res, params) => {
  const body = await jsonBody(req);
  if (!body) return json(res, 400, { error: 'Invalid JSON' });

  // Fetch the strategy code from router
  const strategy = await routerFetch('GET', `/api/market/pricing-strategies/${params.id}`, authToken(req));
  if (!strategy?.code) return json(res, 404, { error: 'Strategy not found' });

  const result = await pricingEngine.execute(strategy.code, {
    inputTokens: body.inputTokens ?? 1000,
    outputTokens: body.outputTokens ?? 500,
    model: body.model ?? 'test-model',
    time: new Date().toISOString(),
    feedData: body.feedData ?? null,
  });
  json(res, 200, result);
});

// ── Health monitoring ────────────────────────────────────────────────────

/** GET /health/keys — health status of all keys in user's listings */
routes.set('GET /health/keys', async (req, res) => {
  const data = await routerFetch('GET', '/api/market/health', authToken(req));
  json(res, 200, data);
});

/** POST /health/:listingId/reset — manually reset circuit breaker */
routes.set('POST /health/:listingId/reset', async (req, res, params) => {
  const data = await routerFetch('POST', `/api/market/health/${params.listingId}/reset`, authToken(req));
  json(res, 200, data);
});

// ── Revenue & expenses ───────────────────────────────────────────────────

/** GET /revenue — seller revenue log */
routes.set('GET /revenue', async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const allowed = new URLSearchParams();
  for (const key of ['seller_id', 'period', 'page', 'limit']) {
    if (url.searchParams.has(key)) allowed.set(key, url.searchParams.get(key));
  }
  const qs = allowed.toString();
  const data = await routerFetch('GET', `/api/market/revenue${qs ? `?${qs}` : ''}`, authToken(req));
  json(res, 200, data);
});

/** GET /revenue/summary — aggregated revenue summary */
routes.set('GET /revenue/summary', async (req, res) => {
  const data = await routerFetch('GET', '/api/market/revenue/summary', authToken(req));
  json(res, 200, data);
});

/** GET /expenses — buyer expense log */
routes.set('GET /expenses', async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const allowed = new URLSearchParams();
  for (const key of ['buyer_id', 'period', 'page', 'limit']) {
    if (url.searchParams.has(key)) allowed.set(key, url.searchParams.get(key));
  }
  const qs = allowed.toString();
  const data = await routerFetch('GET', `/api/market/expenses${qs ? `?${qs}` : ''}`, authToken(req));
  json(res, 200, data);
});

// ── Sync (bridge → master cliproxy) ──────────────────────────────────────

/** POST /sync — push local cliproxy keys to master */
routes.set('POST /sync', async (req, res) => {
  const token = authToken(req);
  const models = await getLocalModels();
  if (models.length === 0) {
    return json(res, 200, { synced: 0, message: 'No local models to sync' });
  }
  const data = await routerFetch('POST', '/api/market/sync/keys', token, { models });
  json(res, 200, data);
});

// ── LiteLLM callback hook (called by LiteLLM on each completion) ─────────

/** POST /hooks/completion — LiteLLM completion callback for billing + health tracking */
routes.set('POST /hooks/completion', async (req, res) => {
  // Authenticate webhook: check x-webhook-secret header or Authorization bearer.
  // Timing-safe comparison: a naive `secret !== WEBHOOK_SECRET` leaks the
  // secret one byte at a time under a remote attacker. We compare against
  // a pre-computed Buffer of the configured secret with
  // `crypto.timingSafeEqual`, length-gated so the comparison itself can't
  // throw on mismatched lengths.
  if (!WEBHOOK_SECRET_BUF) {
    return json(res, 401, { error: 'Unauthorized: webhook secret not configured on this server' });
  }
  const secretHeader = req.headers['x-webhook-secret'] ?? authToken(req) ?? '';
  const secretBuf = Buffer.from(String(secretHeader), 'utf8');
  if (secretBuf.length !== WEBHOOK_SECRET_BUF.length || !crypto.timingSafeEqual(secretBuf, WEBHOOK_SECRET_BUF)) {
    return json(res, 401, { error: 'Unauthorized: invalid or missing webhook secret' });
  }

  const body = await jsonBody(req);
  if (!body) return json(res, 400, { error: 'Invalid JSON' });

  const { model, usage, metadata, response_cost, status_code, request_id } = body;

  // Only process marketplace-routed requests
  if (!metadata?.subscription_id) return json(res, 200, { ok: true, marketplace: false });

  // If the listing's circuit breaker is open, refuse to route/log this
  // completion. LiteLLM should not be sending successful completions for
  // a listing that is supposed to be disabled — reject the callback so the
  // operator sees it and the buyer is not silently billed for a call that
  // should have been blocked upstream.
  const listingIdForHealth = metadata.listing_id ?? metadata.subscription_id;
  if (!healthMonitor.isHealthy(listingIdForHealth)) {
    return json(res, 503, {
      error: 'Listing circuit breaker open — completion rejected',
      listingId: listingIdForHealth,
    });
  }

  // Health tracking
  if (status_code >= 400) {
    await healthMonitor.recordFailure(metadata.listing_id ?? metadata.subscription_id, {
      statusCode: status_code,
      model,
      reason: body.error ?? `HTTP ${status_code}`,
    });
  } else {
    await healthMonitor.recordSuccess(metadata.listing_id ?? metadata.subscription_id);
  }

  // Revenue logging
  if (usage && metadata.seller_id && metadata.buyer_id) {
    await revenueLogger.log({
      buyerId: metadata.buyer_id,
      sellerId: metadata.seller_id,
      listingId: metadata.listing_id,
      subscriptionId: metadata.subscription_id,
      model,
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      costToSeller: response_cost ?? 0,
      requestId: request_id,
      pricingStrategyId: metadata.pricing_strategy_id,
    });
  }

  json(res, 200, { ok: true, marketplace: true });
});

// ── Router ───────────────────────────────────────────────────────────────

/** Match a route pattern like "GET /listings/:id" against a request. */
function matchRoute(method, pathname) {
  // Try exact match first
  const exact = `${method} ${pathname}`;
  if (routes.has(exact)) return { handler: routes.get(exact), params: {} };

  // Try parameterized routes
  for (const [pattern, handler] of routes) {
    const [pMethod, pPath] = pattern.split(' ', 2);
    if (pMethod !== method) continue;
    if (!pPath.includes(':')) continue;

    const patternParts = pPath.split('/');
    const pathParts = pathname.split('/');
    if (patternParts.length !== pathParts.length) continue;

    const params = {};
    let match = true;
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i].startsWith(':')) {
        params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
      } else if (patternParts[i] !== pathParts[i]) {
        match = false;
        break;
      }
    }
    if (match) return { handler, params };
  }
  return null;
}

// ── HTTP server ──────────────────────────────────────────────────────────

// Origins that are allowed to call this server via browser fetch. The
// token-market panel is loaded inside a sandbox iframe served from the
// bridge / router, so we reflect the request Origin only if it matches
// one of these patterns. LiteLLM (which posts to /hooks/completion) calls
// us server-to-server without a browser Origin header — those requests
// are unaffected by CORS.
const ALLOWED_ORIGINS = [
  /^https:\/\/([a-z0-9-]+\.)?xaiworkspace\.com$/i,
  /^https:\/\/([a-z0-9-]+\.)?xshopper\.com$/i,
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

function pickAllowedOrigin(origin) {
  if (!origin) return null;
  return ALLOWED_ORIGINS.some((re) => re.test(origin)) ? origin : null;
}

const server = http.createServer(async (req, res) => {
  // Restrict CORS to known bridge/iframe origins rather than '*'. Server
  // endpoints that require `Authorization` headers also require credentials,
  // and wildcard origins with credentials is disallowed by browsers anyway.
  const origin = req.headers.origin;
  const allowedOrigin = pickAllowedOrigin(origin);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(allowedOrigin ? 204 : 403);
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const route = matchRoute(req.method, pathname);

  if (!route) {
    return json(res, 404, { error: 'Not found', path: pathname });
  }

  try {
    await route.handler(req, res, route.params);
  } catch (err) {
    console.error(`${req.method} ${pathname} error:`, err.message);
    json(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Token Market server listening on port ${PORT}`);

  // Auto-sync local keys to master on startup (bridge→router uses APP_BRIDGE_TOKEN)
  if (ROUTER_URL && BRIDGE_TOKEN) {
    setTimeout(async () => {
      try {
        const models = await getLocalModels();
        if (models.length > 0) {
          const url = `${ROUTER_URL}/api/market/sync/keys`;
          const resp = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-App-Bridge-Token': BRIDGE_TOKEN,
            },
            body: JSON.stringify({ models }),
          });
          if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(`Router POST /api/market/sync/keys → ${resp.status}: ${text}`);
          }
          console.log(`Synced ${models.length} local model(s) to master cliproxy`);
        }
      } catch (err) {
        console.error('Auto-sync failed:', err.message);
      }
    }, 3000);
  }

  // Start health monitor polling
  healthMonitor.startPolling();
});

// ── Graceful shutdown ───────────────────────────────────────────────────
//
// On SIGTERM / SIGINT: stop the HealthMonitor's polling timer, let the
// RevenueLogger do a final flush of buffered records (via dispose()),
// then close the HTTP server. Without this, pm2's SIGKILL after the
// 5s shutdown window would kill us mid-flush and drop revenue rows.
let _shuttingDown = false;
async function shutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[token-market] ${signal} — shutting down`);
  try { healthMonitor.stopPolling(); } catch (err) { console.warn('[token-market] stopPolling error:', err.message); }
  try {
    // dispose() kicks a final _flush() asynchronously; await a short grace
    // window so the in-flight POST to the router has a chance to complete.
    revenueLogger.dispose();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch (err) {
    console.warn('[token-market] revenueLogger.dispose error:', err.message);
  }
  try {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  } catch { /* ignore */ }
  server.close(() => process.exit(0));
  // Hard-exit backstop in case close() hangs on a slow keep-alive.
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
