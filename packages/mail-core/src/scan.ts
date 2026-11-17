import type { MailProvider, MessageHeader, ScanProgress, ScanResult } from './types'
import type { MailStore } from './store'

export interface ScanOptions {
  mailbox?: string
  batchSize?: number
  sentLimit?: number
  signal?: AbortSignal
  onProgress?: (p: ScanProgress) => void
}

/**
 * Fetch headers that aren't cached yet and store them, then record who you've
 * written to. Safe to stop and resume: progress is saved after every batch.
 */
export async function scanMailbox(
  provider: MailProvider,
  store: MailStore,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const mailbox = opts.mailbox ?? 'INBOX'
  const batchSize = opts.batchSize ?? 500
  const status = await provider.status(mailbox)

  let state = store.mailboxState(mailbox)
  if (state && state.uidValidity !== status.uidValidity) {
    store.resetMailbox(mailbox)
    state = null
  }
  let lastUid = state?.lastUid ?? 0
  let checked = store.count(mailbox)
  const total = Math.max(status.messages, checked)
  let added = 0
  let batch: MessageHeader[] = []

  const flush = () => {
    if (batch.length) {
      store.saveHeaders(batch)
      added += batch.length
      batch = []
    }
    store.setMailboxState(mailbox, { uidValidity: status.uidValidity, lastUid })
  }

  opts.onProgress?.({ phase: 'inbox', checked, total })
  for await (const header of provider.fetchHeaders(mailbox, lastUid + 1)) {
    if (opts.signal?.aborted) break
    batch.push(header)
    lastUid = Math.max(lastUid, header.uid)
    checked++
    if (batch.length >= batchSize) {
      flush()
      opts.onProgress?.({ phase: 'inbox', checked, total })
    }
  }
  flush()
  if (opts.signal?.aborted) return { added, total: store.count(mailbox), stopped: true }

  opts.onProgress?.({ phase: 'sent', checked, total })
  const sent = await provider.findMailbox('\\Sent')
  if (sent) store.setRepliedTo(await provider.fetchRecipients(sent, opts.sentLimit ?? 2000))

  const final = store.count(mailbox)
  opts.onProgress?.({ phase: 'done', checked: final, total: final })
  return { added, total: final, stopped: false }
}
