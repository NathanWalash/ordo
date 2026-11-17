import type { PlannedSender } from './cleanup-plan'
import type { MailStore } from './store'
import type {
  CleanupProgress,
  CleanupRecord,
  CleanupSenderResult,
  MailProvider,
  UndoResult,
  UnsubscribeMethod,
} from './types'
import type { UnsubscribeOutcome } from './unsubscribe-run'

export interface CleanupOptions {
  mailbox?: string
  /** UIDs per MOVE command. */
  batchSize?: number
  /** Unsubscribes run at the same time. */
  concurrency?: number
  now?: () => Date
  onProgress?: (p: CleanupProgress) => void
  /** Carry out one unsubscribe; must not throw (see executeUnsubscribe). */
  unsubscribe: (method: UnsubscribeMethod, sender: PlannedSender) => Promise<UnsubscribeOutcome>
}

const chunk = <T>(xs: readonly T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))

/**
 * Carry out a clean-up plan: unsubscribe, then move every cached message from
 * the chosen senders to Trash in batches, then record it all for History and
 * Undo. Nothing is ever deleted: messages only move to the account's Trash.
 */
export async function runCleanup(
  provider: MailProvider,
  store: MailStore,
  senders: readonly PlannedSender[],
  opts: CleanupOptions,
): Promise<CleanupRecord> {
  const mailbox = opts.mailbox ?? 'INBOX'
  const batchSize = opts.batchSize ?? 250
  const results = new Map<string, CleanupSenderResult>(
    senders.map((s) => [
      s.address,
      { address: s.address, name: s.name, category: s.category, trash: s.trash, moved: 0, unsubscribe: null },
    ]),
  )

  // 1. Unsubscribe, a few at a time.
  const toUnsubscribe = senders.filter((s) => s.unsubscribe)
  let unsubscribed = 0
  opts.onProgress?.({ phase: 'unsubscribe', done: 0, total: toUnsubscribe.length })
  const queue = [...toUnsubscribe]
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      let outcome: UnsubscribeOutcome
      try {
        outcome = await opts.unsubscribe(s.unsubscribe!, s)
      } catch (err) {
        outcome = { status: 'failed', method: s.unsubscribe!.kind, detail: String(err) }
      }
      results.get(s.address)!.unsubscribe = outcome
      opts.onProgress?.({ phase: 'unsubscribe', done: ++unsubscribed, total: toUnsubscribe.length })
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, queue.length) }, worker))

  // 2. Move to Trash.
  const owner = new Map<number, string>()
  for (const [address, uids] of store.uidsFrom(
    mailbox,
    senders.filter((s) => s.trash).map((s) => s.address),
  ))
    for (const uid of uids) owner.set(uid, address)
  const uids = [...owner.keys()].sort((a, b) => a - b)

  let trashMailbox: string | null = null
  let trashUidValidity: string | null = null
  let uidMap: [number, number][] | null = []
  let moved = 0
  let error: string | null = null
  opts.onProgress?.({ phase: 'move', done: 0, total: uids.length })
  if (uids.length) {
    try {
      trashMailbox = await provider.findMailbox('\\Trash')
      if (!trashMailbox) throw new Error('This account has no Trash mailbox')
      trashUidValidity = (await provider.status(trashMailbox)).uidValidity
      for (const batch of chunk(uids, batchSize)) {
        const res = await provider.moveMessages(mailbox, trashMailbox, batch)
        if (res.uidValidity) trashUidValidity = res.uidValidity
        // Without COPYUID we can't tell which Trash message is which, so Undo isn't offered.
        if (res.uidMap && uidMap) uidMap.push(...res.uidMap)
        else uidMap = null
        const done = res.uidMap ? batch.filter((u) => res.uidMap!.has(u)) : batch
        for (const u of done) results.get(owner.get(u)!)!.moved++
        moved += done.length
        // Gone from the mailbox either way (moved now, or already gone on the server).
        store.deleteMessages(mailbox, batch)
        opts.onProgress?.({ phase: 'move', done: moved, total: uids.length })
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }

  const record = store.addCleanup({
    at: (opts.now ?? (() => new Date()))(),
    mailbox,
    trashMailbox,
    trashUidValidity,
    moved,
    senders: [...results.values()],
    uidMap: uidMap?.length ? uidMap : null,
    error,
  })
  opts.onProgress?.({ phase: 'done', done: moved, total: uids.length })
  return record
}

/**
 * Move a clean-up's emails from Trash back to where they came from, using the
 * UID map the server reported. Emails no longer in Trash are counted as missing;
 * if Trash was renumbered (UIDVALIDITY changed) none can be found reliably.
 */
export async function undoCleanup(
  provider: MailProvider,
  store: MailStore,
  id: number,
  opts: { batchSize?: number; now?: () => Date } = {},
): Promise<UndoResult> {
  const record = store.cleanup(id)
  if (!record) throw new Error(`No clean-up with id ${id}`)
  if (record.undoneAt) return { restored: 0, missing: 0, reason: 'already-undone' }
  const markUndone = (restored: number) => store.markUndone(id, restored, (opts.now ?? (() => new Date()))())
  if (!record.uidMap?.length || !record.trashMailbox)
    return { restored: 0, missing: record.moved, reason: 'no-map' }

  const inTrash = record.uidMap.map(([, trashUid]) => trashUid)
  const status = await provider.status(record.trashMailbox)
  if (record.trashUidValidity && status.uidValidity !== record.trashUidValidity) {
    markUndone(0)
    return { restored: 0, missing: inTrash.length, reason: 'trash-renumbered' }
  }
  const present = await provider.existingUids(record.trashMailbox, inTrash)
  let restored = 0
  for (const batch of chunk(present, opts.batchSize ?? 250)) {
    const res = await provider.moveMessages(record.trashMailbox, record.mailbox, batch)
    restored += res.uidMap ? res.uidMap.size : batch.length
  }
  markUndone(restored)
  return { restored, missing: inTrash.length - restored }
}
