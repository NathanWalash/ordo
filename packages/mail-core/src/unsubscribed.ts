import type { CleanupSummary, UnsubscribeMethod } from './types'

/** The last time Ordo unsubscribed from a sender, worked out from clean-up history. */
export interface SenderUnsubscribed {
  at: Date
  /**
   * `done`: Ordo unsubscribed (one-click) or sent the unsubscribe email. `opened`: Ordo opened the
   * sender's unsubscribe page in the browser, for the user to finish there.
   */
  status: 'done' | 'opened'
  method: Exclude<UnsubscribeMethod['kind'], 'none'>
}

const STATUSES = new Set<unknown>(['done', 'opened'])
const METHODS = new Set<unknown>(['one-click', 'link', 'mailto'])

/**
 * Who Ordo has unsubscribed from, by lower-case address, from clean-up history (newest wins). History
 * is stored as JSON on disk, so every entry is checked: anything malformed is ignored. A failed or
 * skipped unsubscribe never counts, and never cancels an earlier one that worked; undoing a clean-up
 * only puts emails back, so its unsubscribes still count.
 */
export function unsubscribedFromHistory(
  cleanups: readonly Pick<CleanupSummary, 'at' | 'senders'>[],
): Map<string, SenderUnsubscribed> {
  const out = new Map<string, SenderUnsubscribed>()
  for (const c of cleanups) {
    const at = c.at instanceof Date ? c.at : new Date(Number.NaN)
    if (Number.isNaN(at.getTime()) || !Array.isArray(c.senders)) continue
    for (const s of c.senders as unknown[]) {
      if (!s || typeof s !== 'object') continue
      const { address, unsubscribe } = s as { address?: unknown; unsubscribe?: unknown }
      if (typeof address !== 'string' || !address || !unsubscribe || typeof unsubscribe !== 'object') continue
      const { status, method } = unsubscribe as { status?: unknown; method?: unknown }
      if (!STATUSES.has(status) || !METHODS.has(method)) continue
      const key = address.trim().toLowerCase()
      const before = out.get(key)
      if (before && before.at >= at) continue
      out.set(key, {
        at,
        status: status as SenderUnsubscribed['status'],
        method: method as SenderUnsubscribed['method'],
      })
    }
  }
  return out
}

/** The senders, each with `unsubscribed` set when clean-up history says Ordo unsubscribed from it. */
export function withUnsubscribed<T extends { address: string; unsubscribed?: SenderUnsubscribed }>(
  senders: readonly T[],
  cleanups: readonly Pick<CleanupSummary, 'at' | 'senders'>[],
): T[] {
  const done = unsubscribedFromHistory(cleanups)
  return senders.map((s) => {
    const u = done.get(s.address.trim().toLowerCase())
    return u ? { ...s, unsubscribed: u } : s
  })
}
