/**
 * When each account may be checked for new mail. Every account has its own connection and its own
 * record here, so one that fails (a wrong password, a server that's down) backs off without
 * holding up the others. Pure: the caller passes the time.
 */

export type SyncFailureKind = 'auth' | 'network' | 'unavailable' | 'unknown'

export interface AccountSyncRecord {
  /** Failures in a row since the last success. */
  failures: number
  /** Before this time (ms) automatic checks skip the account. Null: check whenever. */
  retryAt: number | null
  /** The latest failure, until a check succeeds. */
  last: { kind: SyncFailureKind; message: string; at: number } | null
}

export const SYNC_BACKOFF = {
  /** The wait after the first failure. */
  baseMs: 60_000,
  /** The longest wait between automatic tries. */
  maxMs: 30 * 60_000,
} as const

const fresh = (): AccountSyncRecord => ({ failures: 0, retryAt: null, last: null })

/**
 * How long to wait after `failures` failures in a row: one minute, doubling, at most half an hour.
 * A wrong password waits the longest at once: trying again won't fix it, and servers lock out
 * accounts that keep failing to sign in. Entering the password again clears it (`reset`).
 */
export function backoffMs(failures: number, kind: SyncFailureKind): number {
  if (failures <= 0) return 0
  if (kind === 'auth') return SYNC_BACKOFF.maxMs
  return Math.min(SYNC_BACKOFF.maxMs, SYNC_BACKOFF.baseMs * 2 ** (failures - 1))
}

export class SyncSchedule {
  private records = new Map<string, AccountSyncRecord>()

  /** An account's record (a fresh one if it has none). */
  get(account: string): AccountSyncRecord {
    return this.records.get(account) ?? fresh()
  }

  /**
   * The accounts to check now, in the order given. `manual` (the user pressed refresh, or opened
   * the folder) checks every account, backing off or not: they asked.
   */
  due(accounts: readonly string[], now: number, manual = false): string[] {
    return accounts.filter((a) => {
      const r = this.records.get(a)
      return manual || !r?.retryAt || now >= r.retryAt
    })
  }

  /** A check of the account worked: forget its failures. */
  succeeded(account: string): void {
    this.records.delete(account)
  }

  /** A check of the account failed: wait longer before the next automatic try. */
  failed(account: string, kind: SyncFailureKind, message: string, now: number): AccountSyncRecord {
    const failures = this.get(account).failures + 1
    const record: AccountSyncRecord = {
      failures,
      retryAt: now + backoffMs(failures, kind),
      last: { kind, message, at: now },
    }
    this.records.set(account, record)
    return record
  }

  /** Forget an account (removed, or its password entered again). */
  reset(account: string): void {
    this.records.delete(account)
  }
}
