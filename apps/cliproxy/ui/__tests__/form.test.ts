import { validateConnectForm } from '../form';
import type { ProviderDef } from '../types';

const apiKeyProvider: ProviderDef = {
  id: 'openai',
  label: 'OpenAI',
  type: 'api-key',
  hint: 'Get key at platform.openai.com',
};

const oauthProvider: ProviderDef = {
  id: 'claude',
  label: 'Claude Code',
  type: 'cli-subscription',
  hint: 'Browser OAuth — no API key needed',
};

describe('validateConnectForm', () => {
  it('returns noop when no provider selected', () => {
    expect(validateConnectForm(undefined, '')).toEqual({ kind: 'noop' });
    expect(validateConnectForm(undefined, 'irrelevant')).toEqual({ kind: 'noop' });
  });

  it('returns invalid for api-key provider with empty key', () => {
    expect(validateConnectForm(apiKeyProvider, '')).toEqual({
      kind: 'invalid',
      error: 'Please enter an API key',
    });
  });

  it('treats whitespace-only keys as empty', () => {
    expect(validateConnectForm(apiKeyProvider, '   \n\t  ')).toEqual({
      kind: 'invalid',
      error: 'Please enter an API key',
    });
  });

  it('returns api-key flow with trimmed key', () => {
    expect(validateConnectForm(apiKeyProvider, '  sk-abc123  ')).toEqual({
      kind: 'api-key',
      providerId: 'openai',
      apiKey: 'sk-abc123',
    });
  });

  it('returns oauth flow for cli-subscription provider regardless of apiKeyDraft', () => {
    expect(validateConnectForm(oauthProvider, '')).toEqual({
      kind: 'oauth',
      providerId: 'claude',
      label: 'Claude Code',
    });
    // The UI clears apiKeyDraft on provider switch, but a stale value must
    // not affect the oauth branch.
    expect(validateConnectForm(oauthProvider, 'stale-value')).toEqual({
      kind: 'oauth',
      providerId: 'claude',
      label: 'Claude Code',
    });
  });
});
