import type { PanelState, MarketListing, PricingStrategy, PricingResult } from './types';
import * as api from './api';

// ── Pricing strategy templates ───────────────────────────────────────────

const TEMPLATES: Record<string, { name: string; code: string }> = {
  flat: {
    name: 'Flat Rate',
    code: `// Flat rate: fixed price per million tokens
return {
  inputPricePerMTok: 3.00,   // $3.00 per million input tokens
  outputPricePerMTok: 15.00,  // $15.00 per million output tokens
};`,
  },
  timeOfDay: {
    name: 'Time-of-Day',
    code: `// Peak pricing during business hours (UTC)
const hour = new Date(input.time).getUTCHours();
const isPeak = hour >= 9 && hour <= 17;
const multiplier = isPeak ? 1.5 : 1.0;
return {
  inputPricePerMTok: 3.00 * multiplier,
  outputPricePerMTok: 15.00 * multiplier,
};`,
  },
  demand: {
    name: 'Demand-Responsive',
    code: `// Adjust price based on feed data (demand signal)
const demandMultiplier = input.feedData?.demandScore
  ? Math.max(0.5, Math.min(3.0, input.feedData.demandScore))
  : 1.0;
return {
  inputPricePerMTok: 3.00 * demandMultiplier,
  outputPricePerMTok: 15.00 * demandMultiplier,
};`,
  },
};

// ── State ────────────────────────────────────────────────────────────────

const state: PanelState = {
  loading: true,
  error: null,
  success: null,
  activeTab: 'browse',
  marketListings: [],
  browseFilter: '',
  myListings: [],
  localModels: [],
  strategies: [],
  editingStrategy: null,
  testResult: null,
  revenueSummary: null,
  healthStatus: {},
  subscriptions: [],
};

// ── Helpers ──────────────────────────────────────────────────────────────

/** Escape HTML special characters to prevent XSS when inserting into innerHTML. */
function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showSuccess(msg: string) {
  state.success = msg;
  setTimeout(() => { state.success = null; render(); }, 3000);
}

function showError(msg: string) {
  state.error = msg;
  setTimeout(() => { state.error = null; render(); }, 5000);
}

function centsToUsd(cents: number): string {
  return (cents / 100).toFixed(2);
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function healthBadge(h?: string): string {
  if (!h || h === 'closed') return '<span class="badge badge-ok">Healthy</span>';
  if (h === 'open') return '<span class="badge badge-err">Disabled</span>';
  return '<span class="badge badge-warn">Testing</span>';
}

// ── Data loading ─────────────────────────────────────────────────────────

async function loadBrowse() {
  try {
    const data = await api.browseListings(state.browseFilter || undefined);
    state.marketListings = data.listings ?? [];
  } catch { state.marketListings = []; }
}

async function loadMyListings() {
  try {
    const [listings, models] = await Promise.all([
      api.getMyListings(),
      api.getLocalModels(),
    ]);
    state.myListings = listings.listings ?? [];
    state.localModels = models.models ?? [];
  } catch {
    state.myListings = [];
    state.localModels = [];
  }
}

async function loadStrategies() {
  try {
    const data = await api.getStrategies();
    state.strategies = data.strategies ?? [];
  } catch { state.strategies = []; }
}

async function loadRevenue() {
  try {
    state.revenueSummary = await api.getRevenueSummary();
  } catch { state.revenueSummary = null; }
}

async function loadHealth() {
  try {
    state.healthStatus = await api.getHealthStatus();
  } catch { state.healthStatus = {}; }
}

async function loadSubscriptions() {
  try {
    const data = await api.getSubscriptions();
    state.subscriptions = data.subscriptions ?? [];
  } catch { state.subscriptions = []; }
}

async function loadTab() {
  state.loading = true;
  state.error = null;
  render();

  try {
    switch (state.activeTab) {
      case 'browse': await Promise.all([loadBrowse(), loadSubscriptions()]); break;
      case 'listings': await loadMyListings(); break;
      case 'pricing': await loadStrategies(); break;
      case 'revenue': await loadRevenue(); break;
      case 'health': await loadHealth(); break;
    }
  } catch (err: any) {
    state.error = err.message ?? 'Failed to load data';
  }

  state.loading = false;
  render();
}

// ── Actions ──────────────────────────────────────────────────────────────

async function handleSubscribe(listingId: string) {
  try {
    const sub = await api.subscribe(listingId);
    const vkey = sub.virtual_key ? `${sub.virtual_key.slice(0, 8)}...` : 'pending';
    showSuccess(`Subscribed! Virtual key: ${vkey}`);
    await loadBrowse();
    await loadSubscriptions();
    render();
  } catch (err: any) {
    showError(err.message ?? 'Subscribe failed');
  }
}

async function handleUnsubscribe(subId: string) {
  try {
    await api.unsubscribe(subId);
    showSuccess('Unsubscribed');
    await loadSubscriptions();
    render();
  } catch (err: any) {
    showError(err.message ?? 'Unsubscribe failed');
  }
}

async function handleCreateListing(modelId: string, provider: string) {
  try {
    await api.createListing({
      model_id: modelId,
      provider,
      display_name: modelId,
      source_type: 'apikey',
      base_price_input_per_mtok: 3.0,
      base_price_output_per_mtok: 15.0,
    });
    showSuccess(`Listed ${modelId} on marketplace`);
    await loadMyListings();
    render();
  } catch (err: any) {
    showError(err.message ?? 'Failed to create listing');
  }
}

async function handleDeleteListing(listingId: string) {
  try {
    await api.deleteListing(listingId);
    showSuccess('Listing removed');
    await loadMyListings();
    render();
  } catch (err: any) {
    showError(err.message ?? 'Failed to delete listing');
  }
}

async function handleSaveStrategy() {
  const nameEl = document.getElementById('strat-name') as HTMLInputElement;
  const codeEl = document.getElementById('strat-code') as HTMLTextAreaElement;
  if (!nameEl || !codeEl) return;

  const name = nameEl.value.trim();
  const code = codeEl.value.trim();
  if (!name || !code) return showError('Name and code are required');

  try {
    if (state.editingStrategy) {
      await api.updateStrategy(state.editingStrategy.id, { name, code });
      showSuccess('Strategy updated');
    } else {
      await api.createStrategy({ name, code });
      showSuccess('Strategy created');
    }
    state.editingStrategy = null;
    await loadStrategies();
    render();
  } catch (err: any) {
    showError(err.message ?? 'Failed to save strategy');
  }
}

async function handleTestStrategy(strategyId: string) {
  try {
    state.testResult = await api.testStrategy(strategyId, {
      inputTokens: 1000,
      outputTokens: 500,
      model: 'test-model',
    });
    render();
  } catch (err: any) {
    state.testResult = { inputPricePerMTok: 0, outputPricePerMTok: 0, error: err.message };
    render();
  }
}

async function handleDeleteStrategy(strategyId: string) {
  try {
    await api.deleteStrategy(strategyId);
    showSuccess('Strategy deleted');
    await loadStrategies();
    render();
  } catch (err: any) {
    showError(err.message ?? 'Failed to delete strategy');
  }
}

async function handleResetBreaker(listingId: string) {
  try {
    await api.resetCircuitBreaker(listingId);
    showSuccess('Circuit breaker reset');
    await loadHealth();
    render();
  } catch (err: any) {
    showError(err.message ?? 'Failed to reset breaker');
  }
}

async function handleSync() {
  try {
    const result = await api.syncKeys();
    showSuccess(`Synced ${result.synced} key(s) to master`);
  } catch (err: any) {
    showError(err.message ?? 'Sync failed');
  }
}

// ── Tab renderers ────────────────────────────────────────────────────────

function renderBrowseTab(): string {
  const listings = state.marketListings;
  const subs = state.subscriptions;
  const subscribedIds = new Set(subs.map(s => s.listing_id));

  let cards = '';
  if (listings.length === 0) {
    cards = '<div class="empty">No listings available. Be the first to share your models!</div>';
  } else {
    for (const l of listings) {
      const isSubscribed = subscribedIds.has(l.id);
      const sub = subs.find(s => s.listing_id === l.id);
      cards += `
        <div class="card">
          <div class="card-header">
            <strong>${esc(l.display_name ?? l.model_id)}</strong>
            ${healthBadge(l.health_state)}
          </div>
          <div class="card-meta">
            Provider: ${esc(l.provider)} &middot; Seller: ${esc(shortId(l.seller_id))}
          </div>
          <div class="card-pricing">
            Input: <b>$${l.base_price_input_per_mtok?.toFixed(2) ?? '?'}</b>/MTok
            &middot; Output: <b>$${l.base_price_output_per_mtok?.toFixed(2) ?? '?'}</b>/MTok
          </div>
          <div class="card-actions">
            ${isSubscribed
              ? `<button class="btn btn-danger btn-sm" data-action="unsubscribe" data-id="${esc(sub!.id)}">Unsubscribe</button>`
              : `<button class="btn btn-primary btn-sm" data-action="subscribe" data-id="${esc(l.id)}">Subscribe</button>`
            }
          </div>
        </div>`;
    }
  }

  return `
    <div class="filter-bar">
      <input id="browse-filter" type="text" placeholder="Filter by provider..." value="${esc(state.browseFilter)}" />
      <button class="btn btn-sm" data-action="filter-browse">Filter</button>
    </div>
    <div class="card-grid">${cards}</div>
  `;
}

function renderListingsTab(): string {
  let listingsHtml = '';
  if (state.myListings.length === 0) {
    listingsHtml = '<div class="empty">You have no listings yet.</div>';
  } else {
    for (const l of state.myListings) {
      listingsHtml += `
        <div class="card">
          <div class="card-header">
            <strong>${esc(l.display_name ?? l.model_id)}</strong>
            <span class="badge ${l.is_active ? 'badge-ok' : 'badge-err'}">${l.is_active ? 'Active' : 'Inactive'}</span>
          </div>
          <div class="card-pricing">
            Input: $${l.base_price_input_per_mtok?.toFixed(2)}/MTok
            &middot; Output: $${l.base_price_output_per_mtok?.toFixed(2)}/MTok
            &middot; Subscribers: ${l.subscriber_count ?? 0}
          </div>
          <div class="card-actions">
            <button class="btn btn-danger btn-sm" data-action="delete-listing" data-id="${esc(l.id)}">Remove</button>
          </div>
        </div>`;
    }
  }

  // Available local models not yet listed
  const listedModels = new Set(state.myListings.map(l => l.model_id));
  const unlistedModels = state.localModels.filter(m => !listedModels.has(m.id));

  let modelsHtml = '';
  if (unlistedModels.length > 0) {
    modelsHtml = '<h3>Available to List</h3><div class="card-grid">';
    for (const m of unlistedModels) {
      modelsHtml += `
        <div class="card card-compact">
          <div class="card-header"><strong>${esc(m.id)}</strong></div>
          <div class="card-meta">Provider: ${esc(m.owned_by ?? 'unknown')}</div>
          <div class="card-actions">
            <button class="btn btn-primary btn-sm" data-action="create-listing" data-model="${esc(m.id)}" data-provider="${esc(m.owned_by ?? 'unknown')}">List on Market</button>
          </div>
        </div>`;
    }
    modelsHtml += '</div>';
  }

  return `
    <div class="section-header">
      <h3>My Listings</h3>
      <button class="btn btn-sm" data-action="sync">Sync Keys to Master</button>
    </div>
    <div class="card-grid">${listingsHtml}</div>
    ${modelsHtml}
  `;
}

function renderPricingTab(): string {
  // Strategy list
  let stratList = '';
  for (const s of state.strategies) {
    stratList += `
      <div class="card">
        <div class="card-header">
          <strong>${esc(s.name)}</strong>
          <span class="badge ${s.is_valid ? 'badge-ok' : 'badge-err'}">${s.is_valid ? 'Valid' : 'Invalid'}</span>
        </div>
        <div class="card-meta">Max exec: ${s.max_execution_ms}ms &middot; Updated: ${esc(s.updated_at?.slice(0, 10) ?? '')}</div>
        <div class="card-actions">
          <button class="btn btn-sm" data-action="edit-strategy" data-id="${esc(s.id)}">Edit</button>
          <button class="btn btn-sm" data-action="test-strategy" data-id="${esc(s.id)}">Test</button>
          <button class="btn btn-danger btn-sm" data-action="delete-strategy" data-id="${esc(s.id)}">Delete</button>
        </div>
      </div>`;
  }

  // Test result
  let testHtml = '';
  if (state.testResult) {
    const r = state.testResult;
    testHtml = r.error
      ? `<div class="test-result test-error">Error: ${esc(r.error)}</div>`
      : `<div class="test-result test-ok">Input: $${r.inputPricePerMTok.toFixed(4)}/MTok &middot; Output: $${r.outputPricePerMTok.toFixed(4)}/MTok &middot; ${r.executionMs}ms</div>`;
  }

  // Editor
  const editing = state.editingStrategy;
  const editorHtml = `
    <div class="editor-section">
      <h3>${editing ? 'Edit Strategy' : 'New Strategy'}</h3>
      <div class="form-group">
        <label>Name</label>
        <input id="strat-name" type="text" value="${esc(editing?.name ?? '')}" placeholder="My pricing strategy" />
      </div>
      <div class="form-group">
        <label>Templates</label>
        <div class="template-btns">
          ${Object.entries(TEMPLATES).map(([k, t]) =>
            `<button class="btn btn-sm" data-action="load-template" data-key="${k}">${t.name}</button>`
          ).join(' ')}
        </div>
      </div>
      <div class="form-group">
        <label>Code <span class="hint">(receives <code>input</code> object, must return <code>{ inputPricePerMTok, outputPricePerMTok }</code>)</span></label>
        <textarea id="strat-code" rows="12" spellcheck="false">${esc(editing?.code ?? TEMPLATES.flat.code)}</textarea>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" data-action="save-strategy">Save</button>
        ${editing ? '<button class="btn btn-sm" data-action="cancel-edit">Cancel</button>' : ''}
      </div>
      ${testHtml}
    </div>
  `;

  return `
    <div class="card-grid">${stratList}</div>
    ${editorHtml}
  `;
}

function renderRevenueTab(): string {
  const s = state.revenueSummary;
  if (!s) return '<div class="empty">No revenue data yet.</div>';

  return `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">$${centsToUsd(s.total_revenue_cents)}</div>
        <div class="stat-label">Total Revenue</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">$${centsToUsd(s.total_expense_cents)}</div>
        <div class="stat-label">Total Expenses</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">$${centsToUsd(s.total_platform_fee_cents)}</div>
        <div class="stat-label">Platform Fees</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${s.total_calls}</div>
        <div class="stat-label">Total Calls</div>
      </div>
    </div>
    <div class="stats-grid" style="margin-top: 12px;">
      <div class="stat-card">
        <div class="stat-value">$${centsToUsd(s.today_revenue_cents)}</div>
        <div class="stat-label">Today Revenue</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${s.today_calls}</div>
        <div class="stat-label">Today Calls</div>
      </div>
    </div>
  `;
}

function renderHealthTab(): string {
  const entries = Object.entries(state.healthStatus);
  if (entries.length === 0) {
    return '<div class="empty">No health data yet. Health tracking starts when your listings receive traffic.</div>';
  }

  let cards = '';
  for (const [id, h] of entries) {
    cards += `
      <div class="card">
        <div class="card-header">
          <strong>Listing ${esc(shortId(id))}</strong>
          ${healthBadge(h.state)}
        </div>
        <div class="card-meta">
          Failures: ${h.failureCount} &middot; Successes: ${h.successCount}
          ${h.lastFailureReason ? `&middot; Last: ${esc(h.lastFailureReason)}` : ''}
          ${h.disabledUntil ? `&middot; Until: ${esc(new Date(h.disabledUntil).toLocaleTimeString())}` : ''}
        </div>
        ${h.state !== 'closed' ? `
          <div class="card-actions">
            <button class="btn btn-sm" data-action="reset-breaker" data-id="${esc(id)}">Reset Breaker</button>
          </div>` : ''}
      </div>`;
  }

  return `<div class="card-grid">${cards}</div>`;
}

// ── Main render ──────────────────────────────────────────────────────────

function render() {
  const tabs: Array<{ key: PanelState['activeTab']; label: string }> = [
    { key: 'browse', label: 'Browse' },
    { key: 'listings', label: 'My Listings' },
    { key: 'pricing', label: 'Pricing' },
    { key: 'revenue', label: 'Revenue' },
    { key: 'health', label: 'Health' },
  ];

  const tabsHtml = tabs
    .map(t => `<button class="tab ${t.key === state.activeTab ? 'tab-active' : ''}" data-tab="${t.key}">${t.label}</button>`)
    .join('');

  let content = '';
  if (state.loading) {
    content = '<div class="loading">Loading...</div>';
  } else if (state.error) {
    content = `<div class="error">${esc(state.error)}</div>`;
  } else {
    switch (state.activeTab) {
      case 'browse': content = renderBrowseTab(); break;
      case 'listings': content = renderListingsTab(); break;
      case 'pricing': content = renderPricingTab(); break;
      case 'revenue': content = renderRevenueTab(); break;
      case 'health': content = renderHealthTab(); break;
    }
  }

  const successBanner = state.success
    ? `<div class="success-banner">${esc(state.success)}</div>`
    : '';

  xai.render(`
    <style>${CSS}</style>
    ${successBanner}
    <div class="tab-bar">${tabsHtml}</div>
    <div class="content">${content}</div>
  `);

  attachHandlers();
}

// ── Event delegation ─────────────────────────────────────────────────────

function attachHandlers() {
  // Tab switching
  document.querySelectorAll<HTMLElement>('.tab').forEach(el => {
    el.onclick = () => {
      state.activeTab = el.dataset.tab as PanelState['activeTab'];
      state.testResult = null;
      state.editingStrategy = null;
      loadTab();
    };
  });

  // Action buttons
  document.querySelectorAll<HTMLElement>('[data-action]').forEach(el => {
    el.onclick = () => {
      const action = el.dataset.action!;
      const id = el.dataset.id ?? '';

      switch (action) {
        case 'subscribe': handleSubscribe(id); break;
        case 'unsubscribe': handleUnsubscribe(id); break;
        case 'create-listing': handleCreateListing(el.dataset.model!, el.dataset.provider!); break;
        case 'delete-listing': handleDeleteListing(id); break;
        case 'save-strategy': handleSaveStrategy(); break;
        case 'test-strategy': handleTestStrategy(id); break;
        case 'delete-strategy': handleDeleteStrategy(id); break;
        case 'edit-strategy': {
          state.editingStrategy = state.strategies.find(s => s.id === id) ?? null;
          render();
          break;
        }
        case 'cancel-edit': {
          state.editingStrategy = null;
          state.testResult = null;
          render();
          break;
        }
        case 'load-template': {
          const tmpl = TEMPLATES[el.dataset.key!];
          if (tmpl) {
            const codeEl = document.getElementById('strat-code') as HTMLTextAreaElement;
            const nameEl = document.getElementById('strat-name') as HTMLInputElement;
            if (codeEl) codeEl.value = tmpl.code;
            if (nameEl && !nameEl.value) nameEl.value = tmpl.name;
          }
          break;
        }
        case 'reset-breaker': handleResetBreaker(id); break;
        case 'sync': handleSync(); break;
        case 'filter-browse': {
          const input = document.getElementById('browse-filter') as HTMLInputElement;
          state.browseFilter = input?.value ?? '';
          loadTab();
          break;
        }
      }
    };
  });
}

// ── CSS ──────────────────────────────────────────────────────────────────

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 13px; color: #e0e0e0; background: #1a1a2e; }

  .tab-bar { display: flex; gap: 2px; padding: 8px 12px; background: #16213e; border-bottom: 1px solid #333; overflow-x: auto; }
  .tab { padding: 6px 14px; border: none; border-radius: 4px; background: transparent; color: #999; cursor: pointer; font-size: 12px; white-space: nowrap; }
  .tab:hover { color: #ccc; background: rgba(255,255,255,0.05); }
  .tab-active { color: #4fc3f7; background: rgba(79,195,247,0.1); }

  .content { padding: 12px; }
  .loading { text-align: center; padding: 40px; color: #666; }
  .error { padding: 10px; background: rgba(244,67,54,0.1); border: 1px solid #f44336; border-radius: 4px; color: #ef9a9a; margin-bottom: 12px; }
  .empty { text-align: center; padding: 32px; color: #666; }
  .success-banner { padding: 8px 12px; background: rgba(76,175,80,0.15); border-bottom: 1px solid #4caf50; color: #a5d6a7; font-size: 12px; }

  .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .section-header h3 { font-size: 14px; color: #aaa; }

  .filter-bar { display: flex; gap: 8px; margin-bottom: 12px; }
  .filter-bar input { flex: 1; padding: 6px 10px; background: #0f3460; border: 1px solid #333; border-radius: 4px; color: #e0e0e0; font-size: 12px; }

  .card-grid { display: flex; flex-direction: column; gap: 8px; }
  .card { background: #16213e; border: 1px solid #333; border-radius: 6px; padding: 10px 12px; }
  .card-compact { padding: 8px 10px; }
  .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
  .card-header strong { font-size: 13px; color: #e0e0e0; }
  .card-meta { font-size: 11px; color: #888; margin-bottom: 4px; }
  .card-pricing { font-size: 12px; color: #aaa; margin-bottom: 6px; }
  .card-pricing b { color: #4fc3f7; }
  .card-actions { display: flex; gap: 6px; }

  .badge { font-size: 10px; padding: 2px 6px; border-radius: 3px; font-weight: 600; text-transform: uppercase; }
  .badge-ok { background: rgba(76,175,80,0.2); color: #81c784; }
  .badge-err { background: rgba(244,67,54,0.2); color: #ef9a9a; }
  .badge-warn { background: rgba(255,152,0,0.2); color: #ffb74d; }

  .btn { padding: 5px 12px; border: 1px solid #444; border-radius: 4px; background: #0f3460; color: #ccc; cursor: pointer; font-size: 11px; }
  .btn:hover { background: #1a4a8a; }
  .btn-primary { background: #1565c0; border-color: #1976d2; color: #fff; }
  .btn-primary:hover { background: #1976d2; }
  .btn-danger { background: #b71c1c; border-color: #c62828; color: #fff; }
  .btn-danger:hover { background: #c62828; }
  .btn-sm { padding: 3px 8px; font-size: 11px; }

  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; }
  .stat-card { background: #16213e; border: 1px solid #333; border-radius: 6px; padding: 12px; text-align: center; }
  .stat-value { font-size: 20px; font-weight: 700; color: #4fc3f7; margin-bottom: 4px; }
  .stat-label { font-size: 11px; color: #888; text-transform: uppercase; }

  .editor-section { margin-top: 16px; padding-top: 16px; border-top: 1px solid #333; }
  .editor-section h3 { font-size: 14px; color: #aaa; margin-bottom: 10px; }
  .form-group { margin-bottom: 10px; }
  .form-group label { display: block; font-size: 11px; color: #888; margin-bottom: 4px; }
  .form-group .hint { color: #555; }
  .form-group code { background: #0f3460; padding: 1px 4px; border-radius: 2px; font-size: 11px; }
  .form-group input { width: 100%; padding: 6px 10px; background: #0f3460; border: 1px solid #333; border-radius: 4px; color: #e0e0e0; font-size: 12px; }
  .form-group textarea { width: 100%; padding: 8px 10px; background: #0a0a1a; border: 1px solid #333; border-radius: 4px; color: #4fc3f7; font-family: 'Fira Code', 'Consolas', monospace; font-size: 12px; line-height: 1.5; resize: vertical; }
  .form-actions { display: flex; gap: 8px; }
  .template-btns { display: flex; gap: 4px; flex-wrap: wrap; }

  .test-result { margin-top: 10px; padding: 8px 10px; border-radius: 4px; font-size: 12px; }
  .test-ok { background: rgba(76,175,80,0.1); border: 1px solid #4caf50; color: #a5d6a7; }
  .test-error { background: rgba(244,67,54,0.1); border: 1px solid #f44336; color: #ef9a9a; }
`;

// ── Init ─────────────────────────────────────────────────────────────────

xai.on('ready', async () => {
  // Check if server is running
  const running = await api.checkServer();
  if (!running) {
    state.loading = false;
    state.error = 'Token Market server not running. Start with: @token-market start';
    render();
    return;
  }
  loadTab();
});

// Refresh on chat commands
xai.on('chat.message', (data: any) => {
  if (typeof data?.text === 'string' && data.text.startsWith('@token-market')) {
    setTimeout(() => loadTab(), 1000);
  }
});
