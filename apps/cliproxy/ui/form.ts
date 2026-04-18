/**
 * Pure form-validation helpers for the connect-provider form.
 *
 * Extracted from panel.ts so the branching between "no provider selected",
 * "API key required", and "CLI subscription OAuth" can be unit-tested
 * without instantiating the panel module or touching the DOM.
 */

import type { ProviderDef } from './types';

export type ConnectFormResult =
  | { kind: 'noop' }
  | { kind: 'invalid'; error: string }
  | { kind: 'api-key'; providerId: string; apiKey: string }
  | { kind: 'oauth'; providerId: string; label: string };

/**
 * Validate the connect-provider form and decide which flow to run.
 *
 * - Missing provider definition produces a `noop` (form disabled state).
 * - An api-key provider with empty key produces `invalid`.
 * - An api-key provider with a key produces `api-key` (key is trimmed).
 * - A cli-subscription provider produces `oauth`.
 */
export function validateConnectForm(def: ProviderDef | undefined, apiKeyDraft: string): ConnectFormResult {
  if (!def) return { kind: 'noop' };
  if (def.type === 'api-key') {
    const apiKey = apiKeyDraft.trim();
    if (!apiKey) return { kind: 'invalid', error: 'Please enter an API key' };
    return { kind: 'api-key', providerId: def.id, apiKey };
  }
  return { kind: 'oauth', providerId: def.id, label: def.label };
}
