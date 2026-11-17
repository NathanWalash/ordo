import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MailStore } from './store'
import type { MessageHeader } from './types'

const h = (uid: number, o: Partial<MessageHeader> = {}): MessageHeader => ({
  uid,
  mailbox: 'INBOX',
  date: new Date(1_700_000_000_000 + uid),
  seen: false,
  from: { address: 'a@x.example', name: 'A' },
  subject: `s${uid}`,
  ...o,
})

let store: MailStore
beforeEach(() => {
  store = new MailStore(':memory:')
})
afterEach(() => store.close())

describe('MailStore', () => {
  it('round-trips headers', () => {
    const original = h(1, { listId: '<l>', listUnsubscribePost: 'List-Unsubscribe=One-Click', seen: true })
    store.saveHeaders([original])
    expect(store.headers('INBOX')).toEqual([
      { ...original, listUnsubscribe: undefined, precedence: undefined, autoSubmitted: undefined },
    ])
  })

  it('upserts by mailbox and uid', () => {
    store.saveHeaders([h(1), h(2)])
    store.saveHeaders([h(2, { seen: true })])
    expect(store.count('INBOX')).toBe(2)
    expect(store.headers('INBOX')[1]?.seen).toBe(true)
  })

  it('tracks mailbox state and resets it', () => {
    store.setMailboxState('INBOX', { uidValidity: '1', lastUid: 2 })
    store.saveHeaders([h(1)])
    expect(store.mailboxState('INBOX')).toEqual({ uidValidity: '1', lastUid: 2 })
    store.resetMailbox('INBOX')
    expect(store.mailboxState('INBOX')).toBeNull()
    expect(store.count('INBOX')).toBe(0)
  })

  it('stores replied-to addresses normalised', () => {
    store.setRepliedTo(['Sam@iCloud.com ', 'sam@icloud.com'])
    expect(store.repliedTo()).toEqual(new Set(['sam@icloud.com']))
  })

  it('finds cached UIDs by sender and forgets moved messages', () => {
    store.saveHeaders([h(1), h(2, { from: { address: 'B@Y.example ' } }), h(3)])
    expect(store.uidsFrom('INBOX', ['a@x.example', 'b@y.example', 'none@z.example'])).toEqual(
      new Map([
        ['a@x.example', [1, 3]],
        ['b@y.example', [2]],
        ['none@z.example', []],
      ]),
    )
    store.deleteMessages('INBOX', [1, 2])
    expect(store.headers('INBOX').map((m) => m.uid)).toEqual([3])
  })
})

describe('MailStore clean-up history', () => {
  const cleanup = (at: number) => ({
    at: new Date(at),
    mailbox: 'INBOX',
    trashMailbox: 'Deleted Messages',
    trashUidValidity: '42',
    moved: 2,
    senders: [
      {
        address: 'a@x.example',
        name: 'A',
        category: 'promotions' as const,
        trash: true,
        moved: 2,
        unsubscribe: { status: 'done' as const, method: 'one-click' as const },
      },
    ],
    uidMap: [
      [1, 101],
      [2, 102],
    ] as [number, number][],
    error: null,
  })

  it('stores clean-ups newest first, with their UID map', () => {
    const older = store.addCleanup(cleanup(1000))
    const newer = store.addCleanup({ ...cleanup(2000), uidMap: null, error: 'Connection lost' })
    expect(older).toEqual({ ...cleanup(1000), id: older.id, canUndo: true, undoneAt: null, restored: null })
    expect(newer).toMatchObject({ uidMap: null, canUndo: false, error: 'Connection lost' })
    expect(store.cleanups().map((c) => c.id)).toEqual([newer.id, older.id])
  })

  it('marks a clean-up undone', () => {
    const { id } = store.addCleanup(cleanup(1000))
    store.markUndone(id, 2, new Date(5000))
    expect(store.cleanup(id)).toMatchObject({ undoneAt: new Date(5000), restored: 2, canUndo: false })
  })

  it('forgets history with the rest of the account', () => {
    store.addCleanup(cleanup(1000))
    store.clear()
    expect(store.cleanups()).toEqual([])
  })
})
