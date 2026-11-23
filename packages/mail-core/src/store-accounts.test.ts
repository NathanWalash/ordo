import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_ACCOUNT_ID, MAIL_SCHEMA_VERSION, MailStore, migrateMailDb } from './store'
import type { MessageHeader } from './types'

// Several accounts in one cache, and the migration of a cache from before accounts. The fixture
// databases below are built with the exact SQL older Ordo versions ran, filled with synthetic mail.

const tmp = () => join(mkdtempSync(join(tmpdir(), 'ordo-accounts-')), 'mail.sqlite')

const h = (uid: number, extra: Partial<MessageHeader> = {}): MessageHeader => ({
  uid,
  mailbox: 'INBOX',
  date: new Date(1_790_000_000_000 + uid * 1000),
  seen: false,
  from: { address: `sender${uid}@shop.example`, name: `Sender ${uid}` },
  subject: `Subject ${uid}`,
  ...extra,
})

/** The schema Ordo 0.x created (before the mail client added columns), as it ran it. */
const OLDEST = `
CREATE TABLE IF NOT EXISTS mailbox_state (mailbox TEXT PRIMARY KEY, uid_validity TEXT NOT NULL, last_uid INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  mailbox TEXT NOT NULL, uid INTEGER NOT NULL, date INTEGER NOT NULL, seen INTEGER NOT NULL,
  from_address TEXT NOT NULL, from_name TEXT, subject TEXT NOT NULL, list_id TEXT, list_unsubscribe TEXT,
  list_unsubscribe_post TEXT, precedence TEXT, auto_submitted TEXT, PRIMARY KEY (mailbox, uid)
);
CREATE INDEX IF NOT EXISTS messages_from ON messages (from_address);
CREATE TABLE IF NOT EXISTS replied_to (address TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS ai_categories (
  address TEXT NOT NULL, model TEXT NOT NULL, category TEXT NOT NULL, confidence REAL NOT NULL,
  fingerprint TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (address, model)
);
CREATE TABLE IF NOT EXISTS cleanups (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, mailbox TEXT NOT NULL, trash_mailbox TEXT,
  trash_uid_validity TEXT, moved INTEGER NOT NULL, senders TEXT NOT NULL, uid_map TEXT, error TEXT,
  undone_at INTEGER, restored INTEGER
);
`

/** What the single-account mail client (the release before accounts) left on disk. */
const SINGLE_ACCOUNT = `${OLDEST}
CREATE TABLE IF NOT EXISTS mailboxes (
  path TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT, delimiter TEXT NOT NULL, position INTEGER NOT NULL,
  total INTEGER NOT NULL, unread INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bodies (
  mailbox TEXT NOT NULL, uid INTEGER NOT NULL, content TEXT NOT NULL, search_text TEXT NOT NULL,
  fetched_at INTEGER NOT NULL, PRIMARY KEY (mailbox, uid)
);
ALTER TABLE messages ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN answered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN to_json TEXT;
ALTER TABLE messages ADD COLUMN cc_json TEXT;
ALTER TABLE messages ADD COLUMN message_id TEXT;
ALTER TABLE messages ADD COLUMN has_attachments INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN flags_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mailbox_state ADD COLUMN flag_cursor INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS messages_date ON messages (mailbox, date DESC);
CREATE TRIGGER IF NOT EXISTS messages_forget_body AFTER DELETE ON messages BEGIN
  DELETE FROM bodies WHERE mailbox = old.mailbox AND uid = old.uid;
END;
`

/** A single-account cache with real-looking synthetic mail: inbox, Sent, a body, a clean-up. */
function singleAccountFixture(path: string): void {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec(SINGLE_ACCOUNT)
  const msg = db.prepare(
    'INSERT INTO messages (mailbox, uid, date, seen, from_address, from_name, subject, list_id, list_unsubscribe, ' +
      'list_unsubscribe_post, flagged, answered, to_json, message_id, has_attachments, flags_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  for (let uid = 1; uid <= 120; uid++)
    msg.run(
      'INBOX',
      uid,
      1_790_000_000_000 + uid * 60_000,
      uid % 3 === 0 ? 0 : 1,
      uid % 4 === 0 ? 'sam@friend.example' : 'deals@shop.example',
      uid % 4 === 0 ? 'Sam' : 'Shop',
      uid % 4 === 0 ? `Dinner ${uid}?` : `Sale ${uid}: 50% off`,
      uid % 4 === 0 ? null : '<deals.shop.example>',
      uid % 4 === 0 ? null : '<https://shop.example/u>',
      uid % 4 === 0 ? null : 'List-Unsubscribe=One-Click',
      uid === 7 ? 1 : 0,
      uid === 8 ? 1 : 0,
      JSON.stringify([{ address: 'me@icloud.com' }]),
      `<m${uid}@shop.example>`,
      uid === 9 ? 1 : 0,
      uid === 7 ? 1_790_000_000_500 : 0,
    )
  msg.run(
    'Sent Messages',
    3,
    1_790_000_100_000,
    1,
    'me@icloud.com',
    'Me',
    'Re: Dinner',
    null,
    null,
    null,
    0,
    0,
    null,
    null,
    0,
    0,
  )
  db.prepare(
    'INSERT INTO mailbox_state (mailbox, uid_validity, last_uid, flag_cursor) VALUES (?, ?, ?, ?)',
  ).run('INBOX', '1700000000', 120, 40)
  db.prepare('INSERT INTO replied_to (address) VALUES (?)').run('sam@friend.example')
  const box = db.prepare(
    'INSERT INTO mailboxes (path, name, role, delimiter, position, total, unread) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  box.run('INBOX', 'Inbox', 'inbox', '/', 0, 120, 40)
  box.run('Sent Messages', 'Sent Messages', 'sent', '/', 1, 1, 0)
  box.run('Deleted Messages', 'Deleted Messages', 'trash', '/', 2, 0, 0)
  db.prepare(
    'INSERT INTO bodies (mailbox, uid, content, search_text, fetched_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    'INBOX',
    4,
    JSON.stringify({ mailbox: 'INBOX', uid: 4, date: new Date(0).toISOString(), subject: 'Dinner 4?' }),
    'see you at the pineapple place',
    1_790_000_200_000,
  )
  db.prepare(
    'INSERT INTO cleanups (created_at, mailbox, trash_mailbox, trash_uid_validity, moved, senders, uid_map) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    1_790_000_300_000,
    'INBOX',
    'Deleted Messages',
    '9',
    1,
    '[{"address":"old@shop.example"}]',
    '[[200,10]]',
  )
  db.prepare(
    'INSERT INTO ai_categories (address, model, category, confidence, fingerprint, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('deals@shop.example', 'lmstudio:m1', 'promotions', 0.9, 'f', 1)
  db.close()
}

/** Every row of every table, for comparing a file before and after. */
function dump(path: string): Record<string, unknown[]> {
  const db = new DatabaseSync(path)
  const out: Record<string, unknown[]> = {}
  for (const t of [
    'messages',
    'mailbox_state',
    'replied_to',
    'mailboxes',
    'bodies',
    'cleanups',
    'ai_categories',
  ])
    out[t] = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()
  db.close()
  return out
}

describe('migrating a cache from before accounts', () => {
  it('keeps every row, now belonging to the first account, and sets the schema version', () => {
    const path = tmp()
    singleAccountFixture(path)
    const before = dump(path)
    const store = new MailStore(path)
    try {
      expect(store.schemaVersion()).toBe(MAIL_SCHEMA_VERSION)
      const after = dump(path)
      for (const table of Object.keys(before)) {
        expect(after[table], table).toHaveLength(before[table]!.length)
        // Every row is the same, plus account_id (ai_categories stays shared).
        after[table]!.forEach((row, i) => {
          const { account_id, ...rest } = row as Record<string, unknown>
          expect(rest, table).toEqual(before[table]![i])
          if (table !== 'ai_categories') expect(account_id).toBe(DEFAULT_ACCOUNT_ID)
          else expect(account_id).toBeUndefined()
        })
      }
      // And the store reads it as account #1's mail.
      expect(store.count('INBOX')).toBe(120)
      expect(store.mailboxState('INBOX')).toEqual({ uidValidity: '1700000000', lastUid: 120 })
      expect(store.flagCursor('INBOX')).toBe(40)
      expect(store.mailboxes().map((m) => m.role)).toEqual(['inbox', 'sent', 'trash'])
      expect(store.message('INBOX', 7)).toMatchObject({ flagged: true, account: DEFAULT_ACCOUNT_ID })
      expect(store.search('pineapple', { limit: 10 }).map((m) => m.uid)).toEqual([4])
      expect(store.repliedTo()).toEqual(new Set(['sam@friend.example']))
      expect(store.cleanups()).toEqual([
        expect.objectContaining({ account: DEFAULT_ACCOUNT_ID, uidMap: [[200, 10]], canUndo: true }),
      ])
      expect(store.getAiCategories('lmstudio:m1', ['deals@shop.example']).size).toBe(1)
      // A later delete still takes the body with it (the trigger was recreated for v2).
      store.deleteMessages('INBOX', [4])
      expect(store.body('INBOX', 4)).toBeNull()
    } finally {
      store.close()
    }
  })

  it('brings up the oldest schema too (no mail client columns, folders or bodies)', () => {
    const path = tmp()
    const db = new DatabaseSync(path)
    db.exec(OLDEST)
    db.prepare(
      'INSERT INTO messages (mailbox, uid, date, seen, from_address, subject) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('INBOX', 1, 1, 0, 'a@x.example', 'Hello')
    db.close()
    const store = new MailStore(path)
    try {
      expect(store.headers('INBOX')).toEqual([
        expect.objectContaining({ uid: 1, flagged: false, answered: false, account: DEFAULT_ACCOUNT_ID }),
      ])
      expect(store.mailboxes()).toEqual([])
    } finally {
      store.close()
    }
  })

  it('is idempotent: opening again changes nothing', () => {
    const path = tmp()
    singleAccountFixture(path)
    new MailStore(path).close()
    const once = dump(path)
    const again = new MailStore(path)
    again.close()
    expect(dump(path)).toEqual(once)
  })

  it('migrates once when two processes open the file at the same time', () => {
    const path = tmp()
    singleAccountFixture(path)
    const a = new DatabaseSync(path)
    const b = new DatabaseSync(path)
    a.exec('PRAGMA busy_timeout = 5000;')
    b.exec('PRAGMA busy_timeout = 5000;')
    expect(migrateMailDb(a)).toBe(0)
    expect(migrateMailDb(b)).toBe(MAIL_SCHEMA_VERSION)
    a.close()
    b.close()
    expect(dump(path)['messages']).toHaveLength(121)
  })

  it('leaves the old file exactly as it was when the migration fails part way', () => {
    const path = tmp()
    singleAccountFixture(path)
    // Something in the way of the copy: the rename of `bodies` collides with this table.
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE bodies_v1 (x INTEGER)')
    db.close()
    const before = dump(path)
    expect(() => new MailStore(path)).toThrow()
    expect(dump(path)).toEqual(before)
    const check = new DatabaseSync(path)
    expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 })
    check.close()
  })

  it('starts a new file at the current version, with nothing in it', () => {
    const store = new MailStore(tmp())
    try {
      expect(store.schemaVersion()).toBe(MAIL_SCHEMA_VERSION)
      expect(store.cachedAccounts()).toEqual([])
    } finally {
      store.close()
    }
  })

  it('refuses an account id that isn’t one', () => {
    const db = new DatabaseSync(':memory:')
    expect(() => migrateMailDb(db, "x'); DROP TABLE messages; --")).toThrow('Not an account id')
    db.close()
  })
})

describe('several accounts in one cache', () => {
  let root: MailStore
  let work: MailStore
  let home: MailStore
  beforeEach(() => {
    root = new MailStore(tmp())
    work = root.forAccount('acc-work')
    home = root.forAccount('acc-home')
  })
  afterEach(() => root.close())

  it('keeps each account’s messages, folders and state apart, even with the same UIDs', () => {
    work.saveHeaders([h(1, { subject: 'Work 1' }), h(2, { subject: 'Work 2' })])
    home.saveHeaders([h(1, { subject: 'Home 1' })])
    work.setMailboxState('INBOX', { uidValidity: '5', lastUid: 2 })
    home.setMailboxState('INBOX', { uidValidity: '9', lastUid: 1 })
    work.saveMailboxes([{ path: 'INBOX', name: 'Inbox', role: 'inbox', delimiter: '/', total: 2, unread: 2 }])
    home.saveMailboxes([
      { path: 'INBOX', name: 'Inbox', role: 'inbox', delimiter: '/', total: 1, unread: 1 },
      { path: '[Gmail]/All Mail', name: 'All Mail', role: 'all', delimiter: '/', total: 1, unread: 0 },
    ])
    expect(work.headers('INBOX').map((m) => m.subject)).toEqual(['Work 1', 'Work 2'])
    expect(home.message('INBOX', 1)).toMatchObject({ subject: 'Home 1', account: 'acc-home' })
    expect(work.mailboxState('INBOX')).toEqual({ uidValidity: '5', lastUid: 2 })
    expect(home.mailboxes().map((m) => m.path)).toEqual(['INBOX', '[Gmail]/All Mail'])
    expect(work.mailboxes()).toHaveLength(1)
    // A UIDVALIDITY reset in one account leaves the other alone.
    work.resetMailbox('INBOX')
    expect(work.count('INBOX')).toBe(0)
    expect(home.count('INBOX')).toBe(1)
  })

  it('lists the unified inbox newest first across accounts, with paging and the unread filter', () => {
    work.saveHeaders([h(1), h(3, { seen: true })])
    home.saveHeaders([h(2), h(4)])
    const all = root.messagesAcross(['acc-work', 'acc-home'], 'INBOX', { limit: 10 })
    expect(all.total).toBe(4)
    expect(all.messages.map((m) => [m.account, m.uid])).toEqual([
      ['acc-home', 4],
      ['acc-work', 3],
      ['acc-home', 2],
      ['acc-work', 1],
    ])
    expect(
      root.messagesAcross(['acc-work', 'acc-home'], 'INBOX', { limit: 2, offset: 2 }).messages,
    ).toHaveLength(2)
    expect(root.messagesAcross(['acc-work', 'acc-home'], 'INBOX', { limit: 10, unread: true }).total).toBe(3)
    expect(root.messagesAcross(['acc-home'], 'INBOX', { limit: 10 }).total).toBe(2)
    expect(root.messagesAcross([], 'INBOX', { limit: 10 })).toEqual({ total: 0, messages: [] })
  })

  it('searches one account or several, bodies included', () => {
    work.saveHeaders([h(1, { subject: 'Invoice March' })])
    home.saveHeaders([h(1, { subject: 'Holiday photos' }), h(2, { subject: 'Invoice April' })])
    home.saveBody(
      {
        ...h(1),
        from: null,
        to: [],
        cc: [],
        bcc: [],
        replyTo: [],
        messageId: null,
        inReplyTo: null,
        references: [],
        flagged: false,
        answered: false,
        draft: false,
        html: null,
        text: 'beach',
        truncated: false,
        attachments: [],
        inlineImages: {},
      },
      'the beach was lovely',
    )
    expect(work.search('invoice', { limit: 10 }).map((m) => m.subject)).toEqual(['Invoice March'])
    expect(
      root.searchAcross(['acc-work', 'acc-home'], 'invoice', { limit: 10 }).map((m) => m.account),
    ).toEqual(['acc-home', 'acc-work'])
    expect(home.search('lovely', { limit: 10 }).map((m) => m.uid)).toEqual([1])
    expect(work.search('lovely', { limit: 10 })).toEqual([])
  })

  it('records clean-ups per account and protects people written to from any account', () => {
    work.setRepliedTo(['boss@work.example'])
    home.setRepliedTo(['mum@family.example'])
    home.setRepliedTo(['mum@family.example', 'sam@friend.example'])
    expect(work.repliedTo()).toEqual(
      new Set(['boss@work.example', 'mum@family.example', 'sam@friend.example']),
    )
    const c = home.addCleanup({
      at: new Date(1000),
      mailbox: 'INBOX',
      trashMailbox: '[Gmail]/Bin',
      trashUidValidity: '1',
      moved: 0,
      senders: [],
      uidMap: null,
      error: null,
    })
    expect(c.account).toBe('acc-home')
    expect(root.cleanup(c.id)?.account).toBe('acc-home')
  })

  it('clearing one account forgets only its rows; clearAll forgets everything', () => {
    work.saveHeaders([h(1)])
    home.saveHeaders([h(1)])
    home.setRepliedTo(['sam@friend.example'])
    root.saveAiCategories(
      'm',
      new Map([['a@x.example', { category: 'promotions', confidence: 1, fingerprint: 'f' }]]),
    )
    expect(root.cachedAccounts()).toEqual(['acc-home', 'acc-work'])
    home.clear()
    expect(root.cachedAccounts()).toEqual(['acc-work'])
    expect(work.count('INBOX')).toBe(1)
    expect(root.getAiCategories('m', ['a@x.example']).size).toBe(1)
    root.clearAll()
    expect(root.cachedAccounts()).toEqual([])
    expect(root.getAiCategories('m', ['a@x.example']).size).toBe(0)
  })

  it('a store for an account shares the file: closing it closes nothing', () => {
    work.close()
    work.saveHeaders([h(1)])
    expect(work.count('INBOX')).toBe(1)
  })
})
