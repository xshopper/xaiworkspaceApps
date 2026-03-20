/** A model exposed by a provider through CLIProxyAPI */
export interface Model {
  id: string;
  name: string;
  object?: string;
  owned_by?: string;
}

/** OpenAI-compatible /v1/models response */
export interface ModelsResponse {
  data: Model[];
  object: string;
}

/** A connected provider derived from the models list */
export interface Provider {
  name: string;
  type: 'cli-subscription' | 'api-key';
  models: Model[];
}

/** Token status for a CLI subscription provider (e.g. Claude) */
export interface TokenStatus {
  type: string | null;
  email: string | null;
  expired: string | null;
  is_expired: boolean;
  access_token_prefix: string | null;
  has_refresh_token: boolean;
  last_refresh: string | null;
}

/** Overall service status */
export interface ServiceStatus {
  running: boolean;
  port: number;
  providerCount: number;
  modelCount: number;
}

/** Panel state */
export interface PanelState {
  loading: boolean;
  error: string | null;
  success: string | null;
  status: ServiceStatus | null;
  providers: Provider[];
  tokenStatus: TokenStatus | null;
  savingToken: boolean;
}

/** Known provider definitions for the connect form */
export interface ProviderDef {
  id: string;
  label: string;
  type: 'cli-subscription' | 'api-key';
  hint: string;
}
