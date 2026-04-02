import type {
  LocalModel,
  MarketListing,
  MarketSubscription,
  PricingStrategy,
  PricingResult,
  KeyHealth,
  RevenueSummary,
  RevenueEntry,
} from './types';

const BASE = 'http://localhost:3460';

// ── Models (local cliproxy) ──────────────────────────────────────────────

/** Fetch models from local CLIProxyAPI. */
export async function getLocalModels(): Promise<{ models: LocalModel[] }> {
  const res = await xai.http<{ models: LocalModel[] }>(`${BASE}/models`);
  return res.data;
}

// ── Listings ─────────────────────────────────────────────────────────────

/** Browse marketplace listings. */
export async function browseListings(provider?: string): Promise<{ listings: MarketListing[] }> {
  const q = provider ? `?provider=${encodeURIComponent(provider)}` : '';
  const res = await xai.http<{ listings: MarketListing[] }>(`${BASE}/listings${q}`);
  return res.data;
}

/** Get current user's listings. */
export async function getMyListings(): Promise<{ listings: MarketListing[] }> {
  const res = await xai.http<{ listings: MarketListing[] }>(`${BASE}/listings/mine`);
  return res.data;
}

/** Create a new listing. */
export async function createListing(data: Partial<MarketListing>): Promise<MarketListing> {
  const res = await xai.http<MarketListing>(`${BASE}/listings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.data;
}

/** Update a listing. */
export async function updateListing(id: string, data: Partial<MarketListing>): Promise<MarketListing> {
  const res = await xai.http<MarketListing>(`${BASE}/listings/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.data;
}

/** Delete a listing. */
export async function deleteListing(id: string): Promise<void> {
  await xai.http(`${BASE}/listings/${id}`, { method: 'DELETE' });
}

// ── Subscriptions ────────────────────────────────────────────────────────

/** Get current user's subscriptions. */
export async function getSubscriptions(): Promise<{ subscriptions: MarketSubscription[] }> {
  const res = await xai.http<{ subscriptions: MarketSubscription[] }>(`${BASE}/subscriptions`);
  return res.data;
}

/** Subscribe to a listing. */
export async function subscribe(listingId: string): Promise<MarketSubscription> {
  const res = await xai.http<MarketSubscription>(`${BASE}/subscriptions/${listingId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return res.data;
}

/** Unsubscribe from a listing. */
export async function unsubscribe(subscriptionId: string): Promise<void> {
  await xai.http(`${BASE}/subscriptions/${subscriptionId}`, { method: 'DELETE' });
}

// ── Pricing strategies ───────────────────────────────────────────────────

/** Get user's pricing strategies. */
export async function getStrategies(): Promise<{ strategies: PricingStrategy[] }> {
  const res = await xai.http<{ strategies: PricingStrategy[] }>(`${BASE}/pricing`);
  return res.data;
}

/** Create a pricing strategy. */
export async function createStrategy(data: { name: string; code: string }): Promise<PricingStrategy> {
  const res = await xai.http<PricingStrategy>(`${BASE}/pricing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.data;
}

/** Update a pricing strategy. */
export async function updateStrategy(id: string, data: Partial<PricingStrategy>): Promise<PricingStrategy> {
  const res = await xai.http<PricingStrategy>(`${BASE}/pricing/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.data;
}

/** Delete a pricing strategy. */
export async function deleteStrategy(id: string): Promise<void> {
  await xai.http(`${BASE}/pricing/${id}`, { method: 'DELETE' });
}

/** Test a pricing strategy with sample inputs. */
export async function testStrategy(
  id: string,
  inputs: { inputTokens: number; outputTokens: number; model?: string },
): Promise<PricingResult> {
  const res = await xai.http<PricingResult>(`${BASE}/pricing/${id}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(inputs),
  });
  return res.data;
}

// ── Health ────────────────────────────────────────────────────────────────

/** Get key health status. */
export async function getHealthStatus(): Promise<Record<string, KeyHealth>> {
  const res = await xai.http<Record<string, KeyHealth>>(`${BASE}/health/keys`);
  return res.data;
}

/** Reset a circuit breaker. */
export async function resetCircuitBreaker(listingId: string): Promise<void> {
  await xai.http(`${BASE}/health/${listingId}/reset`, { method: 'POST' });
}

// ── Revenue ──────────────────────────────────────────────────────────────

/** Get revenue summary. */
export async function getRevenueSummary(): Promise<RevenueSummary> {
  const res = await xai.http<RevenueSummary>(`${BASE}/revenue/summary`);
  return res.data;
}

/** Get revenue log entries. */
export async function getRevenueLog(limit = 50, offset = 0): Promise<{ entries: RevenueEntry[] }> {
  const res = await xai.http<{ entries: RevenueEntry[] }>(
    `${BASE}/revenue?limit=${limit}&offset=${offset}`,
  );
  return res.data;
}

// ── Sync ─────────────────────────────────────────────────────────────────

/** Trigger sync of local keys to master cliproxy. */
export async function syncKeys(): Promise<{ synced: number; message?: string }> {
  const res = await xai.http<{ synced: number; message?: string }>(`${BASE}/sync`, {
    method: 'POST',
  });
  return res.data;
}

// ── Server health ────────────────────────────────────────────────────────

/** Check if the token market server is running. */
export async function checkServer(): Promise<boolean> {
  try {
    const res = await xai.http(`${BASE}/health`);
    return res.status === 200;
  } catch {
    return false;
  }
}
