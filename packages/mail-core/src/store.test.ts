import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MailStore } from './store'
import type { MailboxInfo, MessageContent, MessageHeader } from './types'

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
      {
        ...original,
        listUnsubscribe: undefined,
        precedence: undefined,
        autoSubmitted: undefined,
        flagged: false,
        answered: false,
        to: [],
        cc: [],
      },
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

const content = (uid: number, mailbox = 'INBOX'): MessageContent => ({
  mailbox,
  uid,
  date: new Date('2026-11-16T10:00:00Z'),
  subject: `s${uid}`,
  from: { address: 'a@x.example' },
  to: [],
  cc: [],
  bcc: [],
  replyTo: [],
  messageId: '<m@x.example>',
  inReplyTo: null,
  references: [],
  seen: false,
  flagged: false,
  answered: false,
  draft: false,
  text: 'Hello',
  html: null,
  truncated: false,
  attachments: [],
  inlineImages: {},
})

describe('MailStore for the mail client', () => {
  it('pages a mailbox newest first, optionally unread only', () => {
    store.saveHeaders([h(1), h(2, { seen: true }), h(3), h(4, { mailbox: 'Archive' })])
    expect(store.messages('INBOX', { limit: 2 })).toMatchObject({
      total: 3,
      messages: [{ uid: 3 }, { uid: 2 }],
    })
    expect(store.messages('INBOX', { limit: 2, offset: 2 }).messages.map((m) => m.uid)).toEqual([1])
    expect(store.messages('INBOX', { limit: 10, unread: true })).toMatchObject({
      total: 2,
      messages: [{ uid: 3 }, { uid: 1 }],
    })
    expect(store.message('Archive', 4)?.uid).toBe(4)
    expect(store.message('INBOX', 4)).toBeNull()
    expect(store.cachedUids('INBOX')).toEqual([1, 2, 3])
  })

  it('updates flags of cached messages only, and counts real changes', () => {
    store.saveHeaders([h(1), h(2)])
    const changed = store.updateFlags('INBOX', [
      { uid: 1, seen: true, flagged: true, answered: false },
      { uid: 2, seen: false, flagged: false, answered: false },
      { uid: 99, seen: true, flagged: true, answered: true },
    ])
    expect(changed).toBe(1)
    expect(store.message('INBOX', 1)).toMatchObject({ seen: true, flagged: true })
    expect(store.message('INBOX', 99)).toBeNull()
    store.setFlag('INBOX', [1, 2], 'answered', true)
    expect(store.headers('INBOX').map((m) => m.answered)).toEqual([true, true])
  })

  it('searches subjects, people and cached bodies, every word, newest first', () => {
    store.saveHeaders([
      h(1, { subject: 'Invoice for October', from: { address: 'billing@power.example', name: 'Power Co' } }),
      h(2, { subject: 'Lunch?', to: [{ address: 'pat@friend.example', name: 'Pat' }] }),
      h(3, { subject: 'Notes', mailbox: 'Archive' }),
      h(4, { subject: '100% off_today' }),
    ])
    store.saveBody({ ...content(3, 'Archive') }, 'The quarterly invoice is attached')
    expect(store.search('invoice', { limit: 10 }).map((m) => m.uid)).toEqual([3, 1])
    expect(store.search('INVOICE power', { limit: 10 }).map((m) => m.uid)).toEqual([1])
    expect(store.search('invoice', { mailbox: 'Archive', limit: 10 }).map((m) => m.uid)).toEqual([3])
    expect(store.search('pat', { limit: 10 }).map((m) => m.uid)).toEqual([2])
    // LIKE wildcards in the query are literal.
    expect(store.search('100%', { limit: 10 }).map((m) => m.uid)).toEqual([4])
    expect(store.search('%', { limit: 10 }).map((m) => m.uid)).toEqual([4])
    expect(store.search('o_f', { limit: 10 })).toEqual([])
    expect(store.search('   ', { limit: 10 })).toEqual([])
  })

  it('caches bodies, takes flags from the headers and forgets a body with its message', () => {
    store.saveHeaders([h(1, { flagged: true })])
    store.saveBody(content(1), 'Hello')
    expect(store.body('INBOX', 1)).toMatchObject({ uid: 1, text: 'Hello', flagged: true, seen: false })
    expect(store.body('INBOX', 1)?.date).toEqual(new Date('2026-11-16T10:00:00Z'))
    // Re-saving headers (a rescan) keeps the body.
    store.saveHeaders([h(1, { seen: true })])
    expect(store.body('INBOX', 1)?.seen).toBe(true)
    store.deleteMessages('INBOX', [1])
    expect(store.body('INBOX', 1)).toBeNull()
  })

  it('keeps the folder list and forgets messages of folders that are gone', () => {
    const box = (path: string, role: MailboxInfo['role'] = null): MailboxInfo => ({
      path,
      name: path,
      role,
      delimiter: '/',
      total: 1,
      unread: 0,
    })
    store.saveHeaders([h(1), h(2, { mailbox: 'Old' })])
    store.setMailboxState('Old', { uidValidity: '1', lastUid: 2 })
    store.saveMailboxes([box('INBOX', 'inbox'), box('Old')])
    store.saveMailboxes([box('INBOX', 'inbox'), box('Projects')])
    expect(store.mailboxes().map((m) => m.path)).toEqual(['INBOX', 'Projects'])
    expect(store.count('Old')).toBe(0)
    expect(store.mailboxState('Old')).toBeNull()
    // An empty list (a failed fetch) forgets nothing.
    store.saveMailboxes([])
    expect(store.count('INBOX')).toBe(1)
    store.saveMailboxes([box('INBOX', 'inbox')])
    store.setMailboxCounts('INBOX', { total: 9, unread: 4 })
    expect(store.mailboxes()[0]).toMatchObject({ role: 'inbox', total: 9, unread: 4 })
  })

  it('clear() forgets folders and bodies too', () => {
    store.saveHeaders([h(1)])
    store.saveBody(content(1), 'x')
    store.saveMailboxes([
      { path: 'INBOX', name: 'Inbox', role: 'inbox', delimiter: '/', total: 1, unread: 1 },
    ])
    store.clear()
    expect(store.mailboxes()).toEqual([])
    expect(store.body('INBOX', 1)).toBeNull()
  })

  it('adds the new columns to a database made before the mail client', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordo-store-'))
    const file = join(dir, 'mail.sqlite')
    const old = new DatabaseSync(file)
    old.exec(
      'CREATE TABLE messages (mailbox TEXT NOT NULL, uid INTEGER NOT NULL, date INTEGER NOT NULL, seen INTEGER NOT NULL, ' +
        'from_address TEXT NOT NULL, from_name TEXT, subject TEXT NOT NULL, list_id TEXT, list_unsubscribe TEXT, ' +
        'list_unsubscribe_post TEXT, precedence TEXT, auto_submitted TEXT, PRIMARY KEY (mailbox, uid));' +
        "INSERT INTO messages VALUES ('INBOX', 7, 0, 1, 'a@x.example', NULL, 'old', NULL, NULL, NULL, NULL, NULL);",
    )
    old.close()
    const migrated = new MailStore(file)
    try {
      expect(migrated.message('INBOX', 7)).toMatchObject({ subject: 'old', flagged: false, to: [] })
      migrated.saveHeaders([h(8, { flagged: true })])
      expect(migrated.message('INBOX', 8)?.flagged).toBe(true)
    } finally {
      migrated.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
