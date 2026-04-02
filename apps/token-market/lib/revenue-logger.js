/**
 * Revenue Logger — logs per-call billing records for marketplace transactions.
 *
 * Buffers records and flushes to router in batches for efficiency.
 * Each record tracks: buyer expense, seller cost, revenue margin, platform fee.
 */

const FLUSH_INTERVAL_MS = 1000;
const MAX_BUFFER_SIZE = 100;
const PLATFORM_FEE_PERCENT = 5; // 5% platform cut on marketplace transactions

export class RevenueLogger {
  /** @param {string} routerUrl  @param {string} apiKey */
  constructor(routerUrl, apiKey) {
    this.routerUrl = routerUrl;
    this.apiKey = apiKey;
    this.buffer = [];
    this.flushTimer = null;

    // Start flush timer
    this.flushTimer = setInterval(() => this._flush(), FLUSH_INTERVAL_MS);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  /**
   * Log a marketplace completion event.
   * @param {{
   *   buyerId: string,
   *   sellerId: string,
   *   listingId: string,
   *   subscriptionId: string,
   *   model: string,
   *   inputTokens: number,
   *   outputTokens: number,
   *   costToSeller: number,
   *   requestId?: string,
   *   pricingStrategyId?: string,
   *   pricingSnapshot?: object,
   *   latencyMs?: number,
   * }} entry
   */
  async log(entry) {
    // Compute marketplace pricing
    const priceToBuyer = entry.priceToBuyer ?? entry.costToSeller * 1.2; // default: 20% markup
    const platformFee = priceToBuyer * (PLATFORM_FEE_PERCENT / 100);
    const sellerRevenue = priceToBuyer - platformFee;

    const record = {
      buyer_id: entry.buyerId,
      seller_id: entry.sellerId,
      listing_id: entry.listingId,
      subscription_id: entry.subscriptionId,
      model_id: entry.model,
      input_tokens: entry.inputTokens,
      output_tokens: entry.outputTokens,
      cost_to_seller_cents: entry.costToSeller * 100, // dollars → cents
      price_to_buyer_cents: priceToBuyer * 100,
      revenue_cents: sellerRevenue * 100,
      platform_fee_cents: platformFee * 100,
      pricing_strategy_id: entry.pricingStrategyId ?? null,
      pricing_snapshot: entry.pricingSnapshot ?? null,
      request_id: entry.requestId ?? null,
      latency_ms: entry.latencyMs ?? null,
      created_at: new Date().toISOString(),
    };

    this.buffer.push(record);

    if (this.buffer.length >= MAX_BUFFER_SIZE) {
      await this._flush();
    }
  }

  /** Get local (in-memory) totals for quick display. */
  getBufferedCount() {
    return this.buffer.length;
  }

  /** Force flush any buffered records. */
  async flush() {
    return this._flush();
  }

  /** Stop the flush timer. */
  dispose() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Final flush
    this._flush().catch(() => {});
  }

  // ── Internal ───────────────────────────────────────────────────────────

  async _flush() {
    if (this.buffer.length === 0 || !this.routerUrl) return;

    const batch = this.buffer.splice(0, MAX_BUFFER_SIZE);
    try {
      const resp = await fetch(`${this.routerUrl}/api/market/revenue/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ records: batch }),
      });

      if (!resp.ok) {
        // Put records back on failure so they're not lost
        console.error(`[revenue] Flush failed (${resp.status}), re-queuing ${batch.length} records`);
        this.buffer.unshift(...batch);
      }
    } catch (err) {
      console.error('[revenue] Flush error:', err.message);
      this.buffer.unshift(...batch);
    }
  }
}
