import type { FlagUpdate, MailStore } from './store'
import type { MailboxStatus, MessageHeader } from './types'

/** What a folder sync needs from the server; ImapMailProvider has it all. */
export interface FolderSource {
  status(mailbox: string): Promise<MailboxStatus>
  fetchHeaders(mailbox: string, fromUid: number): AsyncIterable<MessageHeader>
  fetchRecentHeaders(mailbox: string, count: number): Promise<MessageHeader[]>
  allUids(mailbox: string): Promise<number[]>
  fetchFlags(mailbox: string, uids: readonly number[]): Promise<FlagUpdate[]>
}

export interface FolderSyncOptions {
  /** The first sync of a folder fetches only its newest messages; older ones are found by search. */
  initialLimit?: number
  /** Flags are refreshed for this many of the newest cached messages. */
  flagWindow?: number
  batchSize?: number
  signal?: AbortSignal
}

export interface FolderSyncResult {
  added: number
  /** Cached messages no longer on the server (moved or deleted elsewhere). */
  removed: number
  /** Cached messages whose read, flagged or replied state changed. */
  changed: number
  total: number
}

export const FOLDER_SYNC_DEFAULTS = { initialLimit: 500, flagWindow: 1000, batchSize: 500 } as const

/**
 * Bring the cache of one folder up to date: new messages since the last sync (the newest few
 * hundred, the first time), messages that have gone, and changed flags. Never changes anything
 * on the server.
 */
export async function syncFolder(
  source: FolderSource,
  store: MailStore,
  mailbox: string,
  opts: FolderSyncOptions = {},
): Promise<FolderSyncResult> {
  const status = await source.status(mailbox)
  let state = store.mailboxState(mailbox)
  if (state && state.uidValidity !== status.uidValidity) {
    store.resetMailbox(mailbox)
    state = null
  }

  if (!state) {
    const recent = await source.fetchRecentHeaders(
      mailbox,
      opts.initialLimit ?? FOLDER_SYNC_DEFAULTS.initialLimit,
    )
    store.saveHeaders(recent)
    const highest = recent.reduce((n, h) => Math.max(n, h.uid), 0)
    store.setMailboxState(mailbox, {
      uidValidity: status.uidValidity,
      lastUid: Math.max(highest, status.uidNext - 1),
    })
    return { added: recent.length, removed: 0, changed: 0, total: store.count(mailbox) }
  }

  const batchSize = opts.batchSize ?? FOLDER_SYNC_DEFAULTS.batchSize
  let lastUid = state.lastUid
  let added = 0
  let batch: MessageHeader[] = []
  const flush = () => {
    store.saveHeaders(batch)
    added += batch.length
    batch = []
    store.setMailboxState(mailbox, { uidValidity: status.uidValidity, lastUid })
  }
  for await (const h of source.fetchHeaders(mailbox, lastUid + 1)) {
    if (opts.signal?.aborted) break
    batch.push(h)
    lastUid = Math.max(lastUid, h.uid)
    if (batch.length >= batchSize) flush()
  }
  flush()
  if (opts.signal?.aborted) return { added, removed: 0, changed: 0, total: store.count(mailbox) }

  const r = await reconcileFolder(source, store, mailbox, opts)
  return { added, ...r, total: store.count(mailbox) }
}

/**
 * Forget cached messages that are no longer on the server and refresh the flags of the newest
 * ones. Used after every folder sync, and after the inbox scan.
 */
export async function reconcileFolder(
  source: Pick<FolderSource, 'allUids' | 'fetchFlags'>,
  store: MailStore,
  mailbox: string,
  opts: Pick<FolderSyncOptions, 'flagWindow'> = {},
): Promise<{ removed: number; changed: number }> {
  const cached = store.cachedUids(mailbox)
  if (!cached.length) return { removed: 0, changed: 0 }
  const onServer = new Set(await source.allUids(mailbox))
  const gone = cached.filter((u) => !onServer.has(u))
  store.deleteMessages(mailbox, gone)
  // The newest messages every time, plus the next slice of older ones, so over a few syncs every
  // cached message's flags are checked without fetching them all at once.
  const window = opts.flagWindow ?? FOLDER_SYNC_DEFAULTS.flagWindow
  const present = cached.filter((u) => onServer.has(u))
  const recent = present.slice(-window)
  const older = present.slice(0, Math.max(0, present.length - window))
  let cursor = store.flagCursor(mailbox)
  if (cursor >= older.length) cursor = 0
  const slice = older.slice(cursor, cursor + window)
  store.setFlagCursor(mailbox, cursor + window)
  const fetchedAt = Date.now()
  const flags = await source.fetchFlags(mailbox, [...slice, ...recent])
  const changed = store.updateFlags(mailbox, flags, fetchedAt)
  return { removed: gone.length, changed }
}

/** UIDs as a compact IMAP sequence set: `1:5,7,9:12`. */
export function toUidSet(uids: readonly number[]): string {
  const sorted = [...new Set(uids)].filter((u) => Number.isInteger(u) && u > 0).sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length;) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++
    parts.push(i === j ? String(sorted[i]) : `${sorted[i]}:${sorted[j]}`)
    i = j + 1
  }
  return parts.join(',')
}
