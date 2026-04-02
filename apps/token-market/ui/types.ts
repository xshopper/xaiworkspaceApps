/** A model from the local CLIProxyAPI */
export interface LocalModel {
  id: string;
  name: string;
  object?: string;
  owned_by?: string;
}

/** A marketplace listing */
export interface MarketListing {
  id: string;
  seller_id: string;
  model_id: string;
  provider: string;
  display_name: string | null;
  description: string | null;
  source_type: 'apikey' | 'subscription' | 'local';
  pricing_strategy_id: string | null;
  base_price_input_per_mtok: number;
  base_price_output_per_mtok: number;
  is_active: boolean;
  max_concurrent_users: number;
  rate_limit_rpm: number | null;
  health_state?: 'closed' | 'open' | 'half_open';
  subscriber_count?: number;
  created_at: string;
  updated_at: string;
}

/** A subscription to a marketplace listing */
export interface MarketSubscription {
  id: string;
  buyer_id: string;
  listing_id: string;
  listing?: MarketListing;
  virtual_key: string | null;
  litellm_key_id: string | null;
  status: 'active' | 'paused' | 'revoked';
  created_at: string;
  updated_at: string;
}

/** A pricing strategy */
export interface PricingStrategy {
  id: string;
  owner_id: string;
  name: string;
  code: string;
  max_execution_ms: number;
  is_valid: boolean;
  validation_error: string | null;
  last_validated_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Result from running a pricing strategy */
export interface PricingResult {
  inputPricePerMTok: number;
  outputPricePerMTok: number;
  error?: string;
  executionMs?: number;
}

/** Key health status */
export interface KeyHealth {
  state: 'closed' | 'open' | 'half_open';
  failureCount: number;
  lastFailureReason: string | null;
  disabledUntil: string | null;
  successCount: number;
}

/** Revenue summary */
export interface RevenueSummary {
  total_revenue_cents: number;
  total_expense_cents: number;
  total_platform_fee_cents: number;
  total_calls: number;
  today_revenue_cents: number;
  today_calls: number;
  daily?: { date: string; revenue_cents: number; calls: number }[];
}

/** Revenue log entry */
export interface RevenueEntry {
  id: number;
  buyer_id: string;
  seller_id: string;
  listing_id: string;
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  cost_to_seller_cents: number;
  price_to_buyer_cents: number;
  revenue_cents: number;
  platform_fee_cents: number;
  created_at: string;
}

/** Panel state */
export interface PanelState {
  loading: boolean;
  error: string | null;
  success: string | null;
  activeTab: 'browse' | 'listings' | 'pricing' | 'revenue' | 'health';
  // Browse tab
  marketListings: MarketListing[];
  browseFilter: string;
  // My listings tab
  myListings: MarketListing[];
  localModels: LocalModel[];
  // Pricing tab
  strategies: PricingStrategy[];
  editingStrategy: PricingStrategy | null;
  testResult: PricingResult | null;
  // Revenue tab
  revenueSummary: RevenueSummary | null;
  // Health tab
  healthStatus: Record<string, KeyHealth>;
  // Subscriptions
  subscriptions: MarketSubscription[];
}
