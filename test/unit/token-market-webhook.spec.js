/**
 * token-market / server.js — webhook auth unit tests.
 *
 * Re-implements the /hooks/completion secret check inline so we can
 * exercise it without booting the HTTP server. The contract is:
 *   - null / empty configured secret → ALWAYS reject (401)
 *   - header missing               → reject
 *   - header wrong length          → reject (no timingSafeEqual throw)
 *   - header matches               → accept
 *   - comparison uses crypto.timingSafeEqual (not `!==`)
 */

const crypto = require('node:crypto');

function webhookAuth(configuredSecret, headerValue) {
  const configuredBuf = configuredSecret ? Buffer.from(configuredSecret, 'utf8') : null;
  if (!configuredBuf) return false;
  const provided = Buffer.from(String(headerValue ?? ''), 'utf8');
  if (provided.length !== configuredBuf.length) return false;
  return crypto.timingSafeEqual(provided, configuredBuf);
}

describe('token-market — webhook secret auth', () => {
  test('rejects when no secret is configured (empty string)', () => {
    expect(webhookAuth('', 'anything')).toBe(false);
    expect(webhookAuth('', '')).toBe(false);
  });

  test('rejects when no secret is configured (null/undefined)', () => {
    expect(webhookAuth(null, 'x')).toBe(false);
    expect(webhookAuth(undefined, 'x')).toBe(false);
  });

  test('rejects when header missing but secret configured', () => {
    expect(webhookAuth('s3cret', undefined)).toBe(false);
    expect(webhookAuth('s3cret', null)).toBe(false);
    expect(webhookAuth('s3cret', '')).toBe(false);
  });

  test('rejects when header length differs (no timingSafeEqual throw)', () => {
    // This is the key safety property — a naive `!==` would work here too,
    // but calling timingSafeEqual with mismatched lengths throws. The
    // length pre-check is what protects us.
    expect(() => webhookAuth('short', 'muchlongerheader')).not.toThrow();
    expect(webhookAuth('short', 'muchlongerheader')).toBe(false);
  });

  test('rejects when header wrong but same length', () => {
    expect(webhookAuth('aaaaa', 'bbbbb')).toBe(false);
  });

  test('accepts exact match', () => {
    expect(webhookAuth('topsecret', 'topsecret')).toBe(true);
  });

  test('rejects case mismatch (timingSafeEqual is byte-exact)', () => {
    expect(webhookAuth('Secret', 'SECRET')).toBe(false);
  });
});
