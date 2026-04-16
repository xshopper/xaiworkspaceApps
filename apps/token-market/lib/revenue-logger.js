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

    // Flush remaining records on process shutdown
    const onExit = () => this.dispose();
    process.once('SIGINT', onExit);
    process.once('SIGTERM', onExit);
    process.once('beforeExit', onExit);
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

  /** Stop the flush timer and flush remaining records. Call on process shutdown. */
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
    // DISABLED: POST /api/market/revenue/batch was removed as a fraud
    // vector (caller-controlled buyer_id + unbounded _cents fields).
    // Revenue logging will be re-introduced in M1 via a trusted internal
    // ingest path derived from LiteLLM spend records. Until then we drop
    // buffered records on the floor to prevent unbounded memory growth.
    if (this.buffer.length === 0) return;
    const dropped = this.buffer.length;
    this.buffer = [];
    if (dropped > 0) {
      console.warn(`[revenue] Revenue logging disabled — dropped ${dropped} records (M1 re-introduces via trusted ingest)`);
    }
  }
}
