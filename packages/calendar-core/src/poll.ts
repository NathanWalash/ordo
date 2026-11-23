// When to check a live calendar (Google) again. Pure, so the policy is tested on its own.

export interface PollDelayOptions {
  /** Failed syncs in a row (0 after a success). */
  failures: number
  /** What the server asked for (Retry-After), if it did. Never sync sooner than that. */
  retryAfterMs?: number
  /** Between successful syncs. Default three minutes. */
  baseMs?: number
  /** The longest wait after failures. Default thirty minutes. */
  maxMs?: number
  /** Spread, as a fraction either side, so many clients (or accounts) don't sync in step. */
  jitter?: number
  random?: () => number
}

export const POLL_BASE_MS = 3 * 60_000
export const POLL_MAX_MS = 30 * 60_000

/**
 * Milliseconds until the next sync: every `baseMs` (with jitter) while things work, doubling after
 * each failure in a row up to `maxMs`, and never before a Retry-After the server sent.
 */
export function nextPollDelay({
  failures,
  retryAfterMs,
  baseMs = POLL_BASE_MS,
  maxMs = POLL_MAX_MS,
  jitter = 0.15,
  random = Math.random,
}: PollDelayOptions): number {
  const backoff = Math.min(baseMs * 2 ** Math.max(0, Math.min(failures, 20)), Math.max(maxMs, baseMs))
  const spread = 1 + (random() * 2 - 1) * jitter
  const delay = Math.round(backoff * spread)
  return Math.max(delay, retryAfterMs ?? 0)
}
