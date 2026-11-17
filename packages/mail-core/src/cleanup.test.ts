import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCleanup, undoCleanup } from './cleanup'
import type { PlannedSender } from './cleanup-plan'
import { MailStore } from './store'
import type { CleanupProgress, MailboxStatus, MailProvider, MessageHeader, MoveResult } from './types'

/** An in-memory IMAP account with UIDPLUS-style UID maps. */
class FakeAccount implements MailProvider {
  boxes = new Map<string, { uidValidity: string; next: number; msgs: Map<number, string> }>()
  moves: { from: string; to: string; uids: number[] }[] = []
  uidPlus = true
  failAfterMoves = Infinity

  constructor() {
    this.boxes.set('INBOX', { uidValidity: '1', next: 1, msgs: new Map() })
    this.boxes.set('Deleted Messages', { uidValidity: '7', next: 100, msgs: new Map() })
  }
  add(mailbox: string, id: string): number {
    const b = this.boxes.get(mailbox)!
    const uid = b.next++
    b.msgs.set(uid, id)
    return uid
  }
  ids(mailbox: string) {
    return [...this.boxes.get(mailbox)!.msgs.values()].sort()
  }
  async connect() {}
  async status(mailbox: string): Promise<MailboxStatus> {
    const b = this.boxes.get(mailbox)!
    return { messages: b.msgs.size, uidNext: b.next, uidValidity: b.uidValidity }
  }
  async *fetchHeaders(): AsyncIterable<MessageHeader> {}
  async findMailbox(use: string) {
    return use === '\\Trash' ? 'Deleted Messages' : null
  }
  async fetchRecipients() {
    return []
  }
  async moveMessages(from: string, to: string, uids: number[]): Promise<MoveResult> {
    if (this.moves.length >= this.failAfterMoves) throw new Error('Connection lost')
    this.moves.push({ from, to, uids })
    const src = this.boxes.get(from)!
    const map = new Map<number, number>()
    for (const uid of uids) {
      const id = src.msgs.get(uid)
      if (id === undefined) continue
      src.msgs.delete(uid)
      map.set(uid, this.add(to, id))
    }
    return this.uidPlus
      ? { uidValidity: this.boxes.get(to)!.uidValidity, uidMap: map }
      : { uidValidity: null, uidMap: null }
  }
  async existingUids(mailbox: string, uids: number[]) {
    const b = this.boxes.get(mailbox)!
    return uids.filter((u) => b.msgs.has(u))
  }
  async close() {}
}

const header = (uid: number, from: string): MessageHeader => ({
  uid,
  mailbox: 'INBOX',
  date: new Date(uid * 1000),
  seen: false,
  from: { address: from },
  subject: `m${uid}`,
})

const planned = (address: string, o: Partial<PlannedSender> = {}): PlannedSender => ({
  address,
  category: 'promotions',
  count: 0,
  unsubscribe: { kind: 'one-click', url: 'https://x.example/u' },
  insecureLinkConfirmed: false,
  trash: true,
  ...o,
})

let store: MailStore
let account: FakeAccount
const T0 = new Date('2026-11-17T10:00:00Z')

/** Put `n` messages from each sender in the fake INBOX and the cache. */
function seed(senders: Record<string, number>) {
  for (const [from, n] of Object.entries(senders))
    for (let i = 0; i < n; i++) {
      const uid = account.add('INBOX', `${from}#${i}`)
      store.saveHeaders([header(uid, from)])
    }
}

beforeEach(() => {
  store = new MailStore(':memory:')
  account = new FakeAccount()
})
afterEach(() => store.close())

describe('runCleanup', () => {
  it('unsubscribes, moves in batches, empties the cache and records a UID map', async () => {
    seed({ 'Deals@Shop.example': 5, 'keep@friend.example': 2, 'news@paper.example': 3 })
    const progress: CleanupProgress[] = []
    const unsubscribe = vi.fn(async () => ({ status: 'done' as const, method: 'one-click' as const }))
    const record = await runCleanup(
      account,
      store,
      [planned('deals@shop.example', { name: 'Shop' }), planned('news@paper.example', { unsubscribe: null })],
      { batchSize: 3, unsubscribe, now: () => T0, onProgress: (p) => progress.push(p) },
    )

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(account.moves.map((m) => m.uids.length)).toEqual([3, 3, 2])
    expect(account.ids('INBOX')).toEqual(['keep@friend.example#0', 'keep@friend.example#1'])
    expect(account.ids('Deleted Messages')).toHaveLength(8)
    expect(store.headers('INBOX').map((h) => h.from.address)).toEqual([
      'keep@friend.example',
      'keep@friend.example',
    ])

    expect(record).toMatchObject({
      at: T0,
      mailbox: 'INBOX',
      trashMailbox: 'Deleted Messages',
      trashUidValidity: '7',
      moved: 8,
      error: null,
      canUndo: true,
      undoneAt: null,
    })
    expect(record.uidMap).toHaveLength(8)
    expect(record.senders).toEqual([
      {
        address: 'deals@shop.example',
        name: 'Shop',
        category: 'promotions',
        trash: true,
        moved: 5,
        unsubscribe: { status: 'done', method: 'one-click' },
      },
      {
        address: 'news@paper.example',
        category: 'promotions',
        trash: true,
        moved: 3,
        unsubscribe: null,
      },
    ])
    expect(progress[0]).toEqual({ phase: 'unsubscribe', done: 0, total: 1 })
    expect(progress.filter((p) => p.phase === 'move').map((p) => p.done)).toEqual([0, 3, 6, 8])
    expect(progress.at(-1)).toEqual({ phase: 'done', done: 8, total: 8 })
    expect(store.cleanups()).toEqual([record])
  })

  it('only unsubscribes when the user turned Trash off', async () => {
    seed({ 'deals@shop.example': 2 })
    const record = await runCleanup(account, store, [planned('deals@shop.example', { trash: false })], {
      unsubscribe: async () => ({ status: 'failed', method: 'one-click', detail: 'The server answered 410' }),
    })
    expect(account.moves).toEqual([])
    expect(record).toMatchObject({ moved: 0, canUndo: false, trashMailbox: null })
    expect(record.senders[0]!.unsubscribe).toEqual({
      status: 'failed',
      method: 'one-click',
      detail: 'The server answered 410',
    })
  })

  it('records a partial move when the connection drops', async () => {
    seed({ 'deals@shop.example': 5 })
    account.failAfterMoves = 1
    const record = await runCleanup(account, store, [planned('deals@shop.example', { unsubscribe: null })], {
      batchSize: 2,
      unsubscribe: vi.fn(),
    })
    expect(record).toMatchObject({ moved: 2, error: 'Connection lost', canUndo: true })
    expect(store.count('INBOX')).toBe(3)
  })

  it('offers no undo when the server reports no UID map', async () => {
    seed({ 'deals@shop.example': 2 })
    account.uidPlus = false
    const record = await runCleanup(account, store, [planned('deals@shop.example', { unsubscribe: null })], {
      unsubscribe: vi.fn(),
    })
    expect(record).toMatchObject({ moved: 2, uidMap: null, canUndo: false })
    expect(await undoCleanup(account, store, record.id)).toEqual({
      restored: 0,
      missing: 2,
      reason: 'no-map',
    })
  })
})

describe('undoCleanup', () => {
  const clear = async () => {
    seed({ 'deals@shop.example': 4, 'keep@friend.example': 1 })
    return runCleanup(account, store, [planned('deals@shop.example', { unsubscribe: null })], {
      unsubscribe: vi.fn(),
    })
  }

  it('moves every email back from Trash using the UID map', async () => {
    const record = await clear()
    expect(await undoCleanup(account, store, record.id, { now: () => T0 })).toEqual({
      restored: 4,
      missing: 0,
    })
    expect(account.ids('INBOX')).toHaveLength(5)
    expect(account.ids('Deleted Messages')).toEqual([])
    expect(account.moves.at(-1)).toMatchObject({ from: 'Deleted Messages', to: 'INBOX' })
    expect(store.cleanup(record.id)).toMatchObject({ undoneAt: T0, restored: 4, canUndo: false })
  })

  it('only touches the mapped messages and counts ones no longer in Trash', async () => {
    const record = await clear()
    const unrelated = account.add('Deleted Messages', 'other#0')
    const [, firstTrashUid] = record.uidMap![0]!
    account.boxes.get('Deleted Messages')!.msgs.delete(firstTrashUid)
    expect(await undoCleanup(account, store, record.id)).toEqual({ restored: 3, missing: 1 })
    expect(account.boxes.get('Deleted Messages')!.msgs.has(unrelated)).toBe(true)
  })

  it('restores nothing if Trash was renumbered', async () => {
    const record = await clear()
    account.boxes.get('Deleted Messages')!.uidValidity = '8'
    expect(await undoCleanup(account, store, record.id)).toEqual({
      restored: 0,
      missing: 4,
      reason: 'trash-renumbered',
    })
    expect(account.ids('INBOX')).toHaveLength(1)
  })

  it('runs once', async () => {
    const record = await clear()
    await undoCleanup(account, store, record.id)
    expect(await undoCleanup(account, store, record.id)).toEqual({
      restored: 0,
      missing: 0,
      reason: 'already-undone',
    })
  })
})
