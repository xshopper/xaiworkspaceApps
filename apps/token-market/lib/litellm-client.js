/**
 * LiteLLM Client — manages virtual keys for marketplace subscriptions.
 *
 * Virtual keys are scoped per-model so buyers never see real API keys.
 * Uses LiteLLM's /key/generate and /key/delete endpoints.
 */

export class LitellmClient {
  /** @param {string} baseUrl  @param {string} masterKey */
  constructor(baseUrl, masterKey) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.masterKey = masterKey;
  }

  /**
   * Create a virtual key scoped to specific models.
   * @param {{
   *   models: string[],
   *   metadata?: object,
   *   maxBudget?: number,
   *   budgetDuration?: string,
   *   tpmLimit?: number,
   *   rpmLimit?: number,
   * }} opts
   * @returns {Promise<{ key: string, key_name: string, expires: string | null }>}
   */
  async createVirtualKey(opts) {
    const body = {
      models: opts.models,
      metadata: opts.metadata ?? {},
      max_budget: opts.maxBudget ?? null,
      budget_duration: opts.budgetDuration ?? null,
      tpm_limit: opts.tpmLimit ?? null,
      rpm_limit: opts.rpmLimit ?? null,
      key_alias: opts.metadata?.subscription_id
        ? `market-sub-${opts.metadata.subscription_id}`
        : undefined,
    };

    const resp = await fetch(`${this.baseUrl}/key/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.masterKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`LiteLLM /key/generate failed (${resp.status}): ${text}`);
    }

    const data = await resp.json();
    return {
      key: data.key,
      key_name: data.key_name ?? data.key_alias ?? data.token,
      expires: data.expires ?? null,
    };
  }

  /**
   * Delete (revoke) a virtual key.
   * @param {string} keyId — the key_name or token to delete
   */
  async deleteVirtualKey(keyId) {
    const resp = await fetch(`${this.baseUrl}/key/delete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.masterKey}`,
      },
      body: JSON.stringify({ keys: [keyId] }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`LiteLLM /key/delete failed (${resp.status}): ${text}`);
    }

    return resp.json();
  }
}
