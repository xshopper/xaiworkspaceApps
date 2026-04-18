import {
  classifyPollStatus,
  hasTimedOut,
  isValidAuthUrl,
  nextPollDelay,
  OAUTH_POLL_MAX_MS,
  POLL_MAX_DELAY_MS,
  POLL_MIN_DELAY_MS,
  POLL_SLOW_DOWN_STEP_MS,
} from '../oauth-state';

describe('isValidAuthUrl', () => {
  it.each([
    ['https://auth.example.com/authorize', true],
    ['http://localhost:3000/callback', true],
    ['HTTPS://EXAMPLE.COM', true],
  ])('accepts http(s) URL %s', (url, expected) => {
    expect(isValidAuthUrl(url)).toBe(expected);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'ftp://example.com',
    '',
    '//example.com/oauth',
  ])('rejects non-http(s) URL %s', (url) => {
    expect(isValidAuthUrl(url)).toBe(false);
  });
});

describe('classifyPollStatus', () => {
  it('maps ok to success (idle→polling→connected transition)', () => {
    expect(classifyPollStatus('ok')).toBe('success');
  });

  it('maps error to error (polling→error transition)', () => {
    expect(classifyPollStatus('error')).toBe('error');
  });

  it.each(['wait', 'slow_down', 'pending', '', 'unknown-future-status'])(
    'maps %s to wait',
    (status) => {
      expect(classifyPollStatus(status)).toBe('wait');
    },
  );
});

describe('nextPollDelay', () => {
  it('increments delay by POLL_SLOW_DOWN_STEP_MS on slow_down', () => {
    expect(nextPollDelay('slow_down', POLL_MIN_DELAY_MS)).toBe(
      POLL_MIN_DELAY_MS + POLL_SLOW_DOWN_STEP_MS,
    );
  });

  it('caps delay at POLL_MAX_DELAY_MS', () => {
    expect(nextPollDelay('slow_down', POLL_MAX_DELAY_MS - 1000)).toBe(POLL_MAX_DELAY_MS);
    expect(nextPollDelay('slow_down', POLL_MAX_DELAY_MS)).toBe(POLL_MAX_DELAY_MS);
    expect(nextPollDelay('slow_down', POLL_MAX_DELAY_MS + 10_000)).toBe(POLL_MAX_DELAY_MS);
  });

  it('leaves delay unchanged for non-slow_down statuses', () => {
    expect(nextPollDelay('wait', 3000)).toBe(3000);
    expect(nextPollDelay('ok', 3000)).toBe(3000);
    expect(nextPollDelay('error', 3000)).toBe(3000);
    expect(nextPollDelay('', 3000)).toBe(3000);
  });
});

describe('hasTimedOut', () => {
  it('is false while elapsed is within limit', () => {
    expect(hasTimedOut(0, OAUTH_POLL_MAX_MS, OAUTH_POLL_MAX_MS)).toBe(false);
    expect(hasTimedOut(1000, 1000 + OAUTH_POLL_MAX_MS, OAUTH_POLL_MAX_MS)).toBe(false);
  });

  it('is true once elapsed exceeds limit', () => {
    expect(hasTimedOut(0, OAUTH_POLL_MAX_MS + 1, OAUTH_POLL_MAX_MS)).toBe(true);
  });

  it('defaults to OAUTH_POLL_MAX_MS', () => {
    expect(hasTimedOut(0, OAUTH_POLL_MAX_MS)).toBe(false);
    expect(hasTimedOut(0, OAUTH_POLL_MAX_MS + 1)).toBe(true);
  });
});
