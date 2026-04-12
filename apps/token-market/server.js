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
import { PricingEngine } from './lib/pricing-engine.js';
import { HealthMonitor } from './lib/health-monitor.js';
import { RevenueLogger } from './lib/revenue-logger.js';
import { LitellmClient } from './lib/litellm-client.js';

const PORT = parseInt(process.env.APP_PORT ?? '3460', 10);
const ROUTER_URL = process.env.ROUTER_URL ?? process.env.ANTHROPIC_BASE_URL?.replace(/\/v1$/, '') ?? '';
const LITELLM_URL = process.env.LITELLM_URL ?? 'http://localhost:4000';
const CLIPROXY_URL = 'http://localhost:4001';
const PLATFORM_KEY = process.env.ANTHROPIC_API_KEY ?? 'local-only';

// ── Subsystems ───────────────────────────────────────────────────────────

const pricingEngine = new PricingEngine();
const healthMonitor = new HealthMonitor(ROUTER_URL, PLATFORM_KEY);
const revenueLogger = new RevenueLogger(ROUTER_URL, PLATFORM_KEY);
const litellm = new LitellmClient(LITELLM_URL, PLATFORM_KEY);

// ── Helpers ──────────────────────────────────────────────────────────────

/** Read full request body as string. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
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
  json(res, 200, { ok: true, version: '0.1.0', port: PORT });
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
  const params = url.searchParams.toString();
  const data = await routerFetch('GET', `/api/market/listings?${params}`, authToken(req));
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
  const params = url.searchParams.toString();
  const data = await routerFetch('GET', `/api/market/revenue?${params}`, authToken(req));
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
  const params = url.searchParams.toString();
  const data = await routerFetch('GET', `/api/market/expenses?${params}`, authToken(req));
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

/** GET /sync/status — check sync status */
routes.set('GET /sync/status', async (req, res) => {
  const data = await routerFetch('GET', '/api/market/sync/status', authToken(req));
  json(res, 200, data);
});

// ── Price feed ───────────────────────────────────────────────────────────

/** GET /price-feed — latest price feed data */
routes.set('GET /price-feed', async (req, res) => {
  const data = await routerFetch('GET', '/api/market/price-feed', authToken(req));
  json(res, 200, data);
});

// ── LiteLLM callback hook (called by LiteLLM on each completion) ─────────

/** POST /hooks/completion — LiteLLM completion callback for billing + health tracking */
routes.set('POST /hooks/completion', async (req, res) => {
  const body = await jsonBody(req);
  if (!body) return json(res, 400, { error: 'Invalid JSON' });

  const { model, usage, metadata, response_cost, status_code, request_id } = body;

  // Only process marketplace-routed requests
  if (!metadata?.subscription_id) return json(res, 200, { ok: true, marketplace: false });

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

const server = http.createServer(async (req, res) => {
  // CORS for panel iframe
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
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

  // Auto-sync local keys to master on startup
  if (ROUTER_URL) {
    setTimeout(async () => {
      try {
        const models = await getLocalModels();
        if (models.length > 0) {
          await routerFetch('POST', '/api/market/sync/keys', PLATFORM_KEY, { models });
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
