/**
 * Pure OAuth polling state helpers.
 *
 * Extracted from panel.ts so the state-machine logic (URL validation,
 * backoff, timeout, result classification) can be unit-tested in isolation
 * from the DOM, timers, and the injected `xai` SDK.
 */

export type PollOutcome = 'success' | 'error' | 'wait';

/** Polling backoff bounds — RFC 8628 §3.5 slow_down handling. */
export const POLL_MIN_DELAY_MS = 3000;
export const POLL_MAX_DELAY_MS = 30000;
export const POLL_SLOW_DOWN_STEP_MS = 5000;

/** Maximum wall-clock duration of a single OAuth flow. */
export const OAUTH_POLL_MAX_MS = 15 * 60 * 1000;

/** Authorize URL must use http or https — blocks `javascript:` and other schemes. */
export function isValidAuthUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * Classify a poll response from the router backend.
 * 'ok' → success, 'error' → error, anything else (wait / slow_down / unknown) → wait.
 */
export function classifyPollStatus(status: string): PollOutcome {
  if (status === 'ok') return 'success';
  if (status === 'error') return 'error';
  return 'wait';
}

/**
 * Compute the next polling delay in milliseconds.
 * `slow_down` bumps the delay by `POLL_SLOW_DOWN_STEP_MS`, capped at `POLL_MAX_DELAY_MS`.
 * Any other status leaves the delay unchanged.
 */
export function nextPollDelay(status: string, currentDelay: number): number {
  if (status === 'slow_down') {
    return Math.min(currentDelay + POLL_SLOW_DOWN_STEP_MS, POLL_MAX_DELAY_MS);
  }
  return currentDelay;
}

/** True once the elapsed time since `startedAt` exceeds `maxMs`. */
export function hasTimedOut(startedAt: number, now: number, maxMs: number = OAUTH_POLL_MAX_MS): boolean {
  return now - startedAt > maxMs;
}
