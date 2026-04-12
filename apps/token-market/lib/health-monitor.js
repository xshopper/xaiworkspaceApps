/**
 * Health Monitor — circuit breaker for marketplace API keys.
 *
 * States:
 *   closed    → key is healthy, requests flow normally
 *   open      → key is disabled, no requests routed to it
 *   half_open → testing one request to see if key recovered
 *
 * Thresholds are per-listing. Failure window: rolling 5 minutes.
 */

const FAILURE_THRESHOLD = 5;          // failures in window to open breaker
const WINDOW_MS = 5 * 60 * 1000;     // 5 min rolling window
const DEFAULT_COOLDOWN_S = 300;       // 5 min cooldown when open
const POLL_INTERVAL_MS = 60_000;      // check health every 60s
const HALF_OPEN_TEST_AFTER_MS = 60_000; // try one request after 60s open

export class HealthMonitor {
  /** @param {string} routerUrl  @param {string} apiKey */
  constructor(routerUrl, apiKey) {
    this.routerUrl = routerUrl;
    this.apiKey = apiKey;
    this.pollTimer = null;

    // Local in-memory state (authoritative state is in router PG)
    // Map<listingId, { failures: { ts, reason }[], state, disabledUntil, successCount }>
    this.breakers = new Map();
  }

  /** Record a successful API call. */
  async recordSuccess(listingId) {
    const b = this._getBreaker(listingId);
    b.successCount++;
    b.lastSuccessAt = Date.now();

    if (b.state === 'half_open') {
      // Recovery confirmed — close the breaker
      b.state = 'closed';
      b.failures = [];
      await this._syncToRouter(listingId, b);
    }
  }

  /** Record a failed API call. */
  async recordFailure(listingId, { statusCode, model, reason }) {
    const b = this._getBreaker(listingId);
    const now = Date.now();

    // Add failure to rolling window
    b.failures.push({ ts: now, reason: reason ?? `HTTP ${statusCode}` });

    // Prune old failures outside window
    b.failures = b.failures.filter((f) => now - f.ts < WINDOW_MS);

    if (b.state === 'half_open') {
      // Test request failed — reopen
      b.state = 'open';
      b.disabledUntil = now + (b.cooldownSeconds ?? DEFAULT_COOLDOWN_S) * 1000;
      await this._syncToRouter(listingId, b);
      return;
    }

    if (b.state === 'closed' && b.failures.length >= FAILURE_THRESHOLD) {
      // Threshold breached — open the breaker
      b.state = 'open';
      b.disabledUntil = now + (b.cooldownSeconds ?? DEFAULT_COOLDOWN_S) * 1000;
      b.lastFailureReason = reason;
      console.warn(`[health] Circuit OPEN for listing ${listingId}: ${reason} (${b.failures.length} failures in window)`);
      await this._syncToRouter(listingId, b);
    }
  }

  /** Check if a listing is healthy (can accept requests). */
  isHealthy(listingId) {
    const b = this.breakers.get(listingId);
    if (!b) return true; // no data = assume healthy
    if (b.state === 'closed') return true;
    if (b.state === 'open') {
      // Check if cooldown expired → transition to half_open
      if (Date.now() >= (b.disabledUntil ?? 0)) {
        b.state = 'half_open';
        return true; // allow one test request
      }
      return false;
    }
    // half_open → allow one test request
    return true;
  }

  /** Start periodic health check polling. */
  startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this._poll(), POLL_INTERVAL_MS);
    // Don't block process exit
    if (this.pollTimer.unref) this.pollTimer.unref();
  }

  // ── Internal ───────────────────────────────────────────────────────────

  _getBreaker(listingId) {
    if (!this.breakers.has(listingId)) {
      this.breakers.set(listingId, {
        state: 'closed',
        failures: [],
        disabledUntil: null,
        lastFailureReason: null,
        cooldownSeconds: DEFAULT_COOLDOWN_S,
        successCount: 0,
        lastSuccessAt: null,
      });
    }
    return this.breakers.get(listingId);
  }

  /** Sync breaker state to router for persistence. */
  async _syncToRouter(listingId, breaker) {
    if (!this.routerUrl) return;
    try {
      await fetch(`${this.routerUrl}/api/market/health/${listingId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          state: breaker.state,
          failure_count: breaker.failures.length,
          last_failure_reason: breaker.lastFailureReason,
          disabled_until: breaker.disabledUntil ? new Date(breaker.disabledUntil).toISOString() : null,
          cooldown_seconds: breaker.cooldownSeconds,
        }),
      });
    } catch (err) {
      console.error(`[health] Failed to sync breaker state for ${listingId}:`, err.message);
    }
  }

  /** Periodic poll: check open breakers for cooldown expiry. */
  async _poll() {
    const now = Date.now();
    for (const [id, b] of this.breakers) {
      if (b.state === 'open' && now >= (b.disabledUntil ?? 0)) {
        b.state = 'half_open';
        console.log(`[health] Circuit HALF_OPEN for listing ${id} — will test next request`);
        await this._syncToRouter(id, b);
      }
    }
  }
}
