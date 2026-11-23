import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { AiCategoryCache, AiCategoryRecord } from './ai-sort'
import type {
  Address,
  Category,
  CleanupRecord,
  CleanupSenderResult,
  CleanupSummary,
  MailboxInfo,
  MailboxRole,
  MessageContent,
  MessageHeader,
} from './types'

export interface MailboxState {
  uidValidity: string
  lastUid: number
}

type Row = {
  account_id: string
  mailbox: string
  uid: number
  date: number
  seen: number
  from_address: string
  from_name: string | null
  subject: string
  list_id: string | null
  list_unsubscribe: string | null
  list_unsubscribe_post: string | null
  precedence: string | null
  auto_submitted: string | null
  flagged: number
  answered: number
  to_json: string | null
  cc_json: string | null
  message_id: string | null
  has_attachments: number
}

/** Flags that can change on the server after a message was cached. */
export interface FlagUpdate {
  uid: number
  seen: boolean
  flagged: boolean
  answered: boolean
}

export interface MessageQuery {
  limit: number
  offset?: number
  /** Only unread messages. */
  unread?: boolean
}

export interface SearchQuery {
  /** Only this mailbox; every cached mailbox when missing. */
  mailbox?: string
  limit: number
}

/**
 * The account a cache from before Ordo had several accounts belongs to. The accounts list gives
 * the account it migrates to the same id, so its cached mail, folders and clean-ups stay with it.
 */
export const DEFAULT_ACCOUNT_ID = 'acc-1'

/**
 * The cache's schema version (`PRAGMA user_version`). 0: one account, no account column (or a
 * new, empty file). 2: every table with per-account rows has an `account_id`.
 */
export const MAIL_SCHEMA_VERSION = 2

/** The schema before accounts, as Ordo created it, so a very old file can be brought up to date. */
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS mailbox_state (
  mailbox TEXT PRIMARY KEY,
  uid_validity TEXT NOT NULL,
  last_uid INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  mailbox TEXT NOT NULL,
  uid INTEGER NOT NULL,
  date INTEGER NOT NULL,
  seen INTEGER NOT NULL,
  from_address TEXT NOT NULL,
  from_name TEXT,
  subject TEXT NOT NULL,
  list_id TEXT,
  list_unsubscribe TEXT,
  list_unsubscribe_post TEXT,
  precedence TEXT,
  auto_submitted TEXT,
  PRIMARY KEY (mailbox, uid)
);
CREATE TABLE IF NOT EXISTS replied_to (address TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS cleanups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  mailbox TEXT NOT NULL,
  trash_mailbox TEXT,
  trash_uid_validity TEXT,
  moved INTEGER NOT NULL,
  senders TEXT NOT NULL,
  uid_map TEXT,
  error TEXT,
  undone_at INTEGER,
  restored INTEGER
);
CREATE TABLE IF NOT EXISTS mailboxes (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT,
  delimiter TEXT NOT NULL,
  position INTEGER NOT NULL,
  total INTEGER NOT NULL,
  unread INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bodies (
  mailbox TEXT NOT NULL,
  uid INTEGER NOT NULL,
  content TEXT NOT NULL,
  search_text TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (mailbox, uid)
);
`

/** Columns added to v1's `messages` for the mail client, for files created before it. */
const MESSAGE_COLUMNS_V1: [string, string][] = [
  ['flagged', 'INTEGER NOT NULL DEFAULT 0'],
  ['answered', 'INTEGER NOT NULL DEFAULT 0'],
  ['to_json', 'TEXT'],
  ['cc_json', 'TEXT'],
  ['message_id', 'TEXT'],
  ['has_attachments', 'INTEGER NOT NULL DEFAULT 0'],
  // When Ordo last changed this message's flags itself (ms), so a sync doesn't undo it.
  ['flags_at', 'INTEGER NOT NULL DEFAULT 0'],
]

/** Version 2: per-account tables. Shared by new files and the migration. */
const TABLES_V2: Record<string, string> = {
  mailbox_state: `CREATE TABLE mailbox_state (
  account_id TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  uid_validity TEXT NOT NULL,
  last_uid INTEGER NOT NULL,
  flag_cursor INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, mailbox)
)`,
  messages: `CREATE TABLE messages (
  account_id TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  uid INTEGER NOT NULL,
  date INTEGER NOT NULL,
  seen INTEGER NOT NULL,
  from_address TEXT NOT NULL,
  from_name TEXT,
  subject TEXT NOT NULL,
  list_id TEXT,
  list_unsubscribe TEXT,
  list_unsubscribe_post TEXT,
  precedence TEXT,
  auto_submitted TEXT,
  flagged INTEGER NOT NULL DEFAULT 0,
  answered INTEGER NOT NULL DEFAULT 0,
  to_json TEXT,
  cc_json TEXT,
  message_id TEXT,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  flags_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, mailbox, uid)
)`,
  replied_to: `CREATE TABLE replied_to (
  account_id TEXT NOT NULL,
  address TEXT NOT NULL,
  PRIMARY KEY (account_id, address)
)`,
  mailboxes: `CREATE TABLE mailboxes (
  account_id TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT,
  delimiter TEXT NOT NULL,
  position INTEGER NOT NULL,
  total INTEGER NOT NULL,
  unread INTEGER NOT NULL,
  PRIMARY KEY (account_id, path)
)`,
  bodies: `CREATE TABLE bodies (
  account_id TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  uid INTEGER NOT NULL,
  content TEXT NOT NULL,
  search_text TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, mailbox, uid)
)`,
}

const CLEANUPS_V2 = `CREATE TABLE cleanups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  mailbox TEXT NOT NULL,
  trash_mailbox TEXT,
  trash_uid_validity TEXT,
  moved INTEGER NOT NULL,
  senders TEXT NOT NULL,
  uid_map TEXT,
  error TEXT,
  undone_at INTEGER,
  restored INTEGER
)`

const AI_CATEGORIES = `CREATE TABLE IF NOT EXISTS ai_categories (
  address TEXT NOT NULL,
  model TEXT NOT NULL,
  category TEXT NOT NULL,
  confidence REAL NOT NULL,
  fingerprint TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (address, model)
)`

// INSERT OR REPLACE doesn't fire delete triggers (recursive_triggers is off), so re-caching a
// message's headers keeps its body; a real delete (moved, expunged, renumbered) drops it.
const INDEXES_V2 = `
CREATE INDEX IF NOT EXISTS messages_from ON messages (from_address);
CREATE INDEX IF NOT EXISTS messages_date ON messages (account_id, mailbox, date DESC);
CREATE INDEX IF NOT EXISTS messages_mailbox_date ON messages (mailbox, date DESC);
CREATE INDEX IF NOT EXISTS cleanups_account ON cleanups (account_id);
CREATE TRIGGER IF NOT EXISTS messages_forget_body AFTER DELETE ON messages BEGIN
  DELETE FROM bodies WHERE account_id = old.account_id AND mailbox = old.mailbox AND uid = old.uid;
END;
`

const columnsOf = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

const hasTable = (db: DatabaseSync, table: string) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined

export interface MigrateOptions {
  /**
   * Before migrating a cache from before accounts, copy it here first (once: an existing copy is
   * kept), so there's a way back if anything goes wrong.
   */
  backupTo?: string
}

const userVersion = (db: DatabaseSync) =>
  (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version

/**
 * A consistent copy of a cache that's about to be migrated (VACUUM INTO reads one snapshot, so a
 * write by another Ordo process can't tear it). Only for a file with data from before accounts,
 * and only once. Another process making the same copy at the same moment is fine: one wins.
 */
function backupBeforeMigrating(db: DatabaseSync, to: string): void {
  if (userVersion(db) >= MAIL_SCHEMA_VERSION || !hasTable(db, 'messages') || existsSync(to)) return
  try {
    db.prepare('VACUUM INTO ?').run(to)
  } catch (err) {
    // Made by another process in the meantime: that copy will do.
    if (!existsSync(to)) throw err
  }
}

/** Account ids are short and plain (see the accounts list): safe inside a DEFAULT clause. */
const ACCOUNT_ID = /^[a-z0-9-]{1,40}$/

/**
 * Bring a mail cache up to MAIL_SCHEMA_VERSION, in one transaction: a new file gets the current
 * tables; a file from before accounts keeps every row, each now belonging to `legacyAccount`.
 * Safe to run again (it checks the version inside the transaction, so two Ordo processes opening
 * the same file at once migrate it once) and all-or-nothing (a failure leaves the old file as it
 * was). Returns the version it found.
 */
export function migrateMailDb(
  db: DatabaseSync,
  legacyAccount = DEFAULT_ACCOUNT_ID,
  options: MigrateOptions = {},
): number {
  if (!ACCOUNT_ID.test(legacyAccount)) throw new Error('Not an account id')
  if (options.backupTo) backupBeforeMigrating(db, options.backupTo)
  db.exec('BEGIN IMMEDIATE')
  try {
    const found = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (found >= MAIL_SCHEMA_VERSION) {
      db.exec('COMMIT')
      return found
    }
    const addAccountToCleanups = () => {
      if (!columnsOf(db, 'cleanups').includes('account_id'))
        db.exec(`ALTER TABLE cleanups ADD COLUMN account_id TEXT NOT NULL DEFAULT '${legacyAccount}'`)
    }
    if (!hasTable(db, 'messages')) {
      // A new file (or one with nothing in it yet).
      for (const sql of Object.values(TABLES_V2)) db.exec(sql)
      if (hasTable(db, 'cleanups')) addAccountToCleanups()
      else db.exec(CLEANUPS_V2)
    } else {
      // Version 0: bring the old tables up to their last shape, then copy each into v2's.
      db.exec(SCHEMA_V1)
      const have = new Set(columnsOf(db, 'messages'))
      for (const [name, type] of MESSAGE_COLUMNS_V1)
        if (!have.has(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`)
      if (!columnsOf(db, 'mailbox_state').includes('flag_cursor'))
        db.exec('ALTER TABLE mailbox_state ADD COLUMN flag_cursor INTEGER NOT NULL DEFAULT 0')
      // Renaming a table rewrites triggers and indexes that name it: drop them first.
      db.exec(
        'DROP TRIGGER IF EXISTS messages_forget_body; DROP INDEX IF EXISTS messages_from; ' +
          'DROP INDEX IF EXISTS messages_date;',
      )
      for (const [table, create] of Object.entries(TABLES_V2)) {
        const cols = columnsOf(db, table)
          .filter((c) => c !== 'account_id')
          .join(', ')
        db.exec(`ALTER TABLE ${table} RENAME TO ${table}_v1`)
        db.exec(create)
        db.prepare(`INSERT INTO ${table} (account_id, ${cols}) SELECT ?, ${cols} FROM ${table}_v1`).run(
          legacyAccount,
        )
        db.exec(`DROP TABLE ${table}_v1`)
      }
      addAccountToCleanups()
    }
    db.exec(AI_CATEGORIES)
    db.exec(INDEXES_V2)
    db.exec(`PRAGMA user_version = ${MAIL_SCHEMA_VERSION}`)
    db.exec('COMMIT')
    return found
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

type CleanupRow = {
  id: number
  account_id: string
  created_at: number
  mailbox: string
  trash_mailbox: string | null
  trash_uid_validity: string | null
  moved: number
  senders: string
  uid_map: string | null
  error: string | null
  undone_at: number | null
  restored: number | null
}

export type NewCleanup = Omit<CleanupRecord, 'id' | 'account' | 'canUndo' | 'undoneAt' | 'restored'>

function toCleanup(r: CleanupRow): CleanupRecord {
  const uidMap = r.uid_map ? (JSON.parse(r.uid_map) as [number, number][]) : null
  return {
    id: r.id,
    account: r.account_id,
    at: new Date(r.created_at),
    mailbox: r.mailbox,
    trashMailbox: r.trash_mailbox,
    trashUidValidity: r.trash_uid_validity,
    moved: r.moved,
    senders: JSON.parse(r.senders) as CleanupSenderResult[],
    uidMap,
    error: r.error,
    canUndo: Boolean(uidMap?.length) && r.undone_at === null,
    undoneAt: r.undone_at === null ? null : new Date(r.undone_at),
    restored: r.restored,
  }
}

function parseAddresses(json: string | null): Address[] {
  if (!json) return []
  try {
    const v = JSON.parse(json) as unknown
    return Array.isArray(v) ? (v as Address[]) : []
  } catch {
    return []
  }
}

function toHeader(r: Row): MessageHeader {
  return {
    uid: r.uid,
    mailbox: r.mailbox,
    account: r.account_id,
    date: new Date(r.date),
    seen: r.seen === 1,
    from: { address: r.from_address, name: r.from_name ?? undefined },
    subject: r.subject,
    listId: r.list_id ?? undefined,
    listUnsubscribe: r.list_unsubscribe ?? undefined,
    listUnsubscribePost: r.list_unsubscribe_post ?? undefined,
    precedence: r.precedence ?? undefined,
    autoSubmitted: r.auto_submitted ?? undefined,
    flagged: r.flagged === 1,
    answered: r.answered === 1,
    to: parseAddresses(r.to_json),
    cc: parseAddresses(r.cc_json),
    messageId: r.message_id ?? undefined,
    hasAttachments: r.has_attachments === 1 || undefined,
  }
}

/** `%term%` for LIKE … ESCAPE '\', with the term's own wildcards taken literally. */
export const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

/** At most this many words of a search are used. */
export const MAX_SEARCH_TERMS = 8

const SEARCH_FIELDS = [
  'm.subject',
  'm.from_address',
  'm.from_name',
  'm.to_json',
  'm.cc_json',
  'b.search_text',
]

/** `(?, ?, …)` for an IN list of `n` values. */
const marks = (n: number) => `(${Array.from({ length: n }, () => '?').join(', ')})`

/**
 * Local cache of message headers, the folder list and the bodies of messages you've opened, so
 * re-scans only fetch new mail and search works offline. Backed by Node's built-in SQLite.
 *
 * One file holds every account. A store reads and writes one account's rows (`accountId`; an
 * opened file starts with DEFAULT_ACCOUNT_ID); `forAccount` gives another account's store on the
 * same connection. The `…Across` methods read several accounts at once, for the unified inbox and
 * search. AI sender categories are shared: a sender is the same sender in every account.
 */
export class MailStore implements AiCategoryCache {
  private db: DatabaseSync
  private readonly owner: boolean
  /** The account this store reads and writes. */
  readonly accountId: string

  constructor(
    path: string,
    accountId = DEFAULT_ACCOUNT_ID,
    shared?: DatabaseSync,
    options: MigrateOptions = {},
  ) {
    this.accountId = accountId
    if (shared) {
      this.db = shared
      this.owner = false
      return
    }
    this.db = new DatabaseSync(path)
    this.owner = true
    // The app and a headless Ordo may share this file: wait for the other's write instead of failing.
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.db.exec('PRAGMA journal_mode = WAL;')
    migrateMailDb(this.db, DEFAULT_ACCOUNT_ID, options)
  }

  /** The same cache, reading and writing another account's rows. Closing it closes nothing. */
  forAccount(accountId: string): MailStore {
    return new MailStore('', accountId, this.db)
  }

  /** The schema version of the file (MAIL_SCHEMA_VERSION once opened). */
  schemaVersion(): number {
    return (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  }

  /** Where the rotating flag refresh of older messages got to in a mailbox (see reconcileFolder). */
  flagCursor(mailbox: string): number {
    const row = this.db
      .prepare('SELECT flag_cursor FROM mailbox_state WHERE account_id = ? AND mailbox = ?')
      .get(this.accountId, mailbox) as { flag_cursor: number } | undefined
    return row?.flag_cursor ?? 0
  }

  setFlagCursor(mailbox: string, cursor: number): void {
    this.db
      .prepare('UPDATE mailbox_state SET flag_cursor = ? WHERE account_id = ? AND mailbox = ?')
      .run(cursor, this.accountId, mailbox)
  }

  mailboxState(mailbox: string): MailboxState | null {
    const row = this.db
      .prepare('SELECT uid_validity, last_uid FROM mailbox_state WHERE account_id = ? AND mailbox = ?')
      .get(this.accountId, mailbox) as { uid_validity: string; last_uid: number } | undefined
    return row ? { uidValidity: row.uid_validity, lastUid: row.last_uid } : null
  }

  setMailboxState(mailbox: string, state: MailboxState): void {
    this.db
      .prepare(
        'INSERT INTO mailbox_state (account_id, mailbox, uid_validity, last_uid) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(account_id, mailbox) DO UPDATE SET uid_validity = excluded.uid_validity, ' +
          'last_uid = excluded.last_uid',
      )
      .run(this.accountId, mailbox, state.uidValidity, state.lastUid)
  }

  /** Forget everything cached for a mailbox (used when its UIDVALIDITY changes). */
  resetMailbox(mailbox: string): void {
    this.transaction(() => {
      this.db
        .prepare('DELETE FROM messages WHERE account_id = ? AND mailbox = ?')
        .run(this.accountId, mailbox)
      this.db
        .prepare('DELETE FROM mailbox_state WHERE account_id = ? AND mailbox = ?')
        .run(this.accountId, mailbox)
    })
  }

  saveHeaders(headers: MessageHeader[]): void {
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO messages (account_id, mailbox, uid, date, seen, from_address, from_name, subject, ' +
        'list_id, list_unsubscribe, list_unsubscribe_post, precedence, auto_submitted, flagged, answered, ' +
        'to_json, cc_json, message_id, has_attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    this.transaction(() => {
      for (const h of headers) {
        insert.run(
          this.accountId,
          h.mailbox,
          h.uid,
          h.date.getTime(),
          h.seen ? 1 : 0,
          h.from.address,
          h.from.name ?? null,
          h.subject,
          h.listId ?? null,
          h.listUnsubscribe ?? null,
          h.listUnsubscribePost ?? null,
          h.precedence ?? null,
          h.autoSubmitted ?? null,
          h.flagged ? 1 : 0,
          h.answered ? 1 : 0,
          h.to?.length ? JSON.stringify(h.to) : null,
          h.cc?.length ? JSON.stringify(h.cc) : null,
          h.messageId ?? null,
          h.hasAttachments ? 1 : 0,
        )
      }
    })
  }

  count(mailbox: string): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND mailbox = ?')
        .get(this.accountId, mailbox) as { n: number }
    ).n
  }

  headers(mailbox: string): MessageHeader[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE account_id = ? AND mailbox = ? ORDER BY uid')
      .all(this.accountId, mailbox) as Row[]
    return rows.map(toHeader)
  }

  /** One mailbox's cached headers in several accounts (Unclutter for every account). */
  headersAcross(accounts: readonly string[], mailbox: string): MessageHeader[] {
    if (!accounts.length) return []
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE account_id IN ${marks(accounts.length)} AND mailbox = ? ` +
          'ORDER BY account_id, uid',
      )
      .all(...accounts, mailbox) as Row[]
    return rows.map(toHeader)
  }

  /** One page of a mailbox, newest first, and how many there are in all. */
  messages(mailbox: string, q: MessageQuery): { total: number; messages: MessageHeader[] } {
    return this.messagesAcross([this.accountId], mailbox, q)
  }

  /**
   * One page of the same mailbox in several accounts, newest first, and how many there are in all:
   * the unified inbox. Every IMAP account's inbox is `INBOX`.
   */
  messagesAcross(
    accounts: readonly string[],
    mailbox: string,
    q: MessageQuery,
  ): { total: number; messages: MessageHeader[] } {
    if (!accounts.length) return { total: 0, messages: [] }
    const where = `account_id IN ${marks(accounts.length)} AND mailbox = ?${q.unread ? ' AND seen = 0' : ''}`
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${where}`).get(...accounts, mailbox) as {
        n: number
      }
    ).n
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE ${where} ORDER BY date DESC, uid DESC, account_id LIMIT ? OFFSET ?`,
      )
      .all(...accounts, mailbox, q.limit, q.offset ?? 0) as Row[]
    return { total, messages: rows.map(toHeader) }
  }

  /** One cached message's headers, or null. */
  message(mailbox: string, uid: number): MessageHeader | null {
    const row = this.db
      .prepare('SELECT * FROM messages WHERE account_id = ? AND mailbox = ? AND uid = ?')
      .get(this.accountId, mailbox, uid) as Row | undefined
    return row ? toHeader(row) : null
  }

  /** Every cached UID in a mailbox, lowest first. */
  cachedUids(mailbox: string): number[] {
    const rows = this.db
      .prepare('SELECT uid FROM messages WHERE account_id = ? AND mailbox = ? ORDER BY uid')
      .all(this.accountId, mailbox) as { uid: number }[]
    return rows.map((r) => r.uid)
  }

  /**
   * Update flags of messages already cached; unknown UIDs are ignored. Returns how many changed.
   * With `fetchedAt`, messages whose flags you changed in Ordo since then are left alone, so a
   * fetch that started before your change can't undo it.
   */
  updateFlags(mailbox: string, updates: readonly FlagUpdate[], fetchedAt = Number.MAX_SAFE_INTEGER): number {
    const update = this.db.prepare(
      'UPDATE messages SET seen = ?, flagged = ?, answered = ? WHERE account_id = ? AND mailbox = ? AND uid = ? ' +
        'AND (seen != ? OR flagged != ? OR answered != ?) AND flags_at < ?',
    )
    let changed = 0
    this.transaction(() => {
      for (const u of updates) {
        const s = u.seen ? 1 : 0
        const f = u.flagged ? 1 : 0
        const a = u.answered ? 1 : 0
        changed += Number(update.run(s, f, a, this.accountId, mailbox, u.uid, s, f, a, fetchedAt).changes)
      }
    })
    return changed
  }

  /** Set one flag on cached messages, after the server accepted the change. */
  setFlag(
    mailbox: string,
    uids: readonly number[],
    flag: 'seen' | 'flagged' | 'answered',
    on: boolean,
  ): void {
    // `flag` is one of three fixed column names, never user input.
    const update = this.db.prepare(
      `UPDATE messages SET ${flag} = ?, flags_at = ? WHERE account_id = ? AND mailbox = ? AND uid = ?`,
    )
    const now = Date.now()
    this.transaction(() => {
      for (const uid of uids) update.run(on ? 1 : 0, now, this.accountId, mailbox, uid)
    })
  }

  /**
   * Search this account's cached messages: every word must appear in the subject, a sender or
   * recipient, or the cached body text (case-insensitive for ASCII letters). Newest first.
   */
  search(text: string, q: SearchQuery): MessageHeader[] {
    return this.searchAcross([this.accountId], text, q)
  }

  /** `search`, in several accounts at once. */
  searchAcross(accounts: readonly string[], text: string, q: SearchQuery): MessageHeader[] {
    const terms = text.trim().split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TERMS)
    if (!terms.length || !accounts.length) return []
    const where: string[] = [`m.account_id IN ${marks(accounts.length)}`]
    const params: (string | number)[] = [...accounts]
    if (q.mailbox !== undefined) {
      where.push('m.mailbox = ?')
      params.push(q.mailbox)
    }
    for (const t of terms) {
      where.push(`(${SEARCH_FIELDS.map((f) => `${f} LIKE ? ESCAPE '\\'`).join(' OR ')})`)
      params.push(...SEARCH_FIELDS.map(() => likePattern(t)))
    }
    const rows = this.db
      .prepare(
        'SELECT m.* FROM messages m LEFT JOIN bodies b ON b.account_id = m.account_id AND ' +
          'b.mailbox = m.mailbox AND b.uid = m.uid ' +
          `WHERE ${where.join(' AND ')} ORDER BY m.date DESC, m.uid DESC LIMIT ?`,
      )
      .all(...params, q.limit) as Row[]
    return rows.map(toHeader)
  }

  /**
   * Replace the cached folder list. Cached messages of folders that are no longer on the server
   * are forgotten (an empty list, e.g. from a failed fetch, forgets nothing).
   */
  saveMailboxes(list: readonly MailboxInfo[]): void {
    const insert = this.db.prepare(
      'INSERT INTO mailboxes (account_id, path, name, role, delimiter, position, total, unread) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    const id = this.accountId
    this.transaction(() => {
      this.db.prepare('DELETE FROM mailboxes WHERE account_id = ?').run(id)
      list.forEach((m, i) => insert.run(id, m.path, m.name, m.role, m.delimiter, i, m.total, m.unread))
      if (!list.length) return
      const keep = new Set(list.map((m) => m.path))
      const cached = this.db
        .prepare('SELECT DISTINCT mailbox FROM messages WHERE account_id = ?')
        .all(id) as { mailbox: string }[]
      for (const { mailbox } of cached) {
        if (keep.has(mailbox)) continue
        this.db.prepare('DELETE FROM messages WHERE account_id = ? AND mailbox = ?').run(id, mailbox)
        this.db.prepare('DELETE FROM mailbox_state WHERE account_id = ? AND mailbox = ?').run(id, mailbox)
      }
    })
  }

  /** The cached folder list, in the order it was saved. */
  mailboxes(): MailboxInfo[] {
    const rows = this.db
      .prepare('SELECT * FROM mailboxes WHERE account_id = ? ORDER BY position')
      .all(this.accountId) as {
      path: string
      name: string
      role: string | null
      delimiter: string
      total: number
      unread: number
    }[]
    return rows.map((r) => ({
      path: r.path,
      name: r.name,
      role: (r.role as MailboxRole | null) ?? null,
      delimiter: r.delimiter,
      total: r.total,
      unread: r.unread,
    }))
  }

  /** Update one folder's counts, e.g. after reading or moving mail. */
  setMailboxCounts(path: string, counts: { total: number; unread: number }): void {
    this.db
      .prepare('UPDATE mailboxes SET total = ?, unread = ? WHERE account_id = ? AND path = ?')
      .run(counts.total, counts.unread, this.accountId, path)
  }

  /** Cache a message's body (it never changes for a UID). `searchText` is what search looks in. */
  saveBody(content: MessageContent, searchText: string, at = new Date()): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO bodies (account_id, mailbox, uid, content, search_text, fetched_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(this.accountId, content.mailbox, content.uid, JSON.stringify(content), searchText, at.getTime())
  }

  /** A cached body, or null. Flags come from the cached headers, which a sync keeps current. */
  body(mailbox: string, uid: number): MessageContent | null {
    const row = this.db
      .prepare('SELECT content FROM bodies WHERE account_id = ? AND mailbox = ? AND uid = ?')
      .get(this.accountId, mailbox, uid) as { content: string } | undefined
    if (!row) return null
    try {
      const c = JSON.parse(row.content) as MessageContent & { date: string }
      const h = this.message(mailbox, uid)
      return {
        ...c,
        date: new Date(c.date),
        ...(h && { seen: h.seen, flagged: h.flagged ?? false, answered: h.answered ?? false }),
      }
    } catch {
      return null
    }
  }

  /** Cached UIDs in `mailbox` from each of these senders (addresses compared case-insensitively). */
  uidsFrom(mailbox: string, addresses: Iterable<string>): Map<string, number[]> {
    const wanted = new Set([...addresses].map((a) => a.trim().toLowerCase()))
    const out = new Map<string, number[]>([...wanted].map((a) => [a, []]))
    const rows = this.db
      .prepare('SELECT uid, from_address FROM messages WHERE account_id = ? AND mailbox = ? ORDER BY uid')
      .all(this.accountId, mailbox) as { uid: number; from_address: string }[]
    for (const r of rows) out.get(r.from_address.trim().toLowerCase())?.push(r.uid)
    return out
  }

  /** Forget cached headers (and bodies) for messages that have left `mailbox`. */
  deleteMessages(mailbox: string, uids: readonly number[]): void {
    const del = this.db.prepare('DELETE FROM messages WHERE account_id = ? AND mailbox = ? AND uid = ?')
    this.transaction(() => {
      for (const uid of uids) del.run(this.accountId, mailbox, uid)
    })
  }

  /** Record a clean-up of this account. */
  addCleanup(c: NewCleanup): CleanupRecord {
    const res = this.db
      .prepare(
        'INSERT INTO cleanups (account_id, created_at, mailbox, trash_mailbox, trash_uid_validity, moved, ' +
          'senders, uid_map, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        this.accountId,
        c.at.getTime(),
        c.mailbox,
        c.trashMailbox,
        c.trashUidValidity,
        c.moved,
        JSON.stringify(c.senders),
        c.uidMap ? JSON.stringify(c.uidMap) : null,
        c.error,
      )
    return this.cleanup(Number(res.lastInsertRowid))!
  }

  /** A clean-up by id, whichever account it was in (`account` says which). */
  cleanup(id: number): CleanupRecord | null {
    const row = this.db.prepare('SELECT * FROM cleanups WHERE id = ?').get(id) as CleanupRow | undefined
    return row ? toCleanup(row) : null
  }

  /** Every clean-up of every account, newest first. */
  cleanups(): CleanupRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM cleanups ORDER BY created_at DESC, id DESC')
      .all() as CleanupRow[]
    return rows.map(toCleanup)
  }

  /**
   * Each clean-up's time and per-sender results only (every account), newest first, for working
   * out who Ordo has unsubscribed from. A row that can't be read (corrupt JSON) is skipped rather
   * than failing the whole sender list; the entries themselves are checked by
   * `unsubscribedFromHistory`.
   */
  cleanupSenders(): Pick<CleanupSummary, 'at' | 'senders'>[] {
    const rows = this.db
      .prepare('SELECT created_at, senders FROM cleanups ORDER BY created_at DESC, id DESC')
      .all() as Pick<CleanupRow, 'created_at' | 'senders'>[]
    const out: Pick<CleanupSummary, 'at' | 'senders'>[] = []
    for (const r of rows) {
      try {
        const senders = JSON.parse(r.senders) as unknown
        if (Array.isArray(senders))
          out.push({ at: new Date(r.created_at), senders: senders as CleanupSenderResult[] })
      } catch {
        // Skipped: one unreadable row mustn't hide every sender.
      }
    }
    return out
  }

  markUndone(id: number, restored: number, at: Date): void {
    this.db
      .prepare('UPDATE cleanups SET undone_at = ?, restored = ? WHERE id = ?')
      .run(at.getTime(), restored, id)
  }

  /** Replace who this account has written to (from its Sent folder). */
  setRepliedTo(addresses: Iterable<string>): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO replied_to (account_id, address) VALUES (?, ?)')
    this.transaction(() => {
      this.db.prepare('DELETE FROM replied_to WHERE account_id = ?').run(this.accountId)
      for (const a of addresses) insert.run(this.accountId, a.trim().toLowerCase())
    })
  }

  /**
   * Everyone you've written to from any account. Clean-up never clears people, and someone you
   * write to from your work account is still a person when they email your personal one.
   */
  repliedTo(): Set<string> {
    const rows = this.db.prepare('SELECT DISTINCT address FROM replied_to').all() as { address: string }[]
    return new Set(rows.map((r) => r.address))
  }

  /** Accounts with anything in the cache, for tidying up after an account is removed. */
  cachedAccounts(): string[] {
    const rows = this.db
      .prepare(
        'SELECT account_id FROM messages UNION SELECT account_id FROM mailboxes UNION ' +
          'SELECT account_id FROM mailbox_state UNION SELECT account_id FROM cleanups UNION ' +
          'SELECT account_id FROM replied_to UNION SELECT account_id FROM bodies',
      )
      .all() as { account_id: string }[]
    return rows.map((r) => r.account_id).sort()
  }

  /**
   * Delete everything cached for this account: headers, bodies, folders, sync state, who you've
   * written to and its clean-up history. Other accounts are untouched.
   */
  clear(): void {
    const id = this.accountId
    this.transaction(() => {
      for (const table of ['messages', 'mailbox_state', 'replied_to', 'cleanups', 'mailboxes', 'bodies'])
        this.db.prepare(`DELETE FROM ${table} WHERE account_id = ?`).run(id)
    })
  }

  /** Delete every account's cache and the AI sender categories, e.g. when the last account goes. */
  clearAll(): void {
    this.db.exec(
      'DELETE FROM messages; DELETE FROM mailbox_state; DELETE FROM replied_to; DELETE FROM ai_categories; ' +
        'DELETE FROM cleanups; DELETE FROM mailboxes; DELETE FROM bodies;',
    )
  }

  /** Cached model answers for these senders, from `aiCategorise`. */
  getAiCategories(model: string, addresses: string[]): Map<string, AiCategoryRecord> {
    const get = this.db.prepare(
      'SELECT category, confidence, fingerprint FROM ai_categories WHERE model = ? AND address = ?',
    )
    const out = new Map<string, AiCategoryRecord>()
    for (const address of addresses) {
      const row = get.get(model, address) as
        { category: Category; confidence: number; fingerprint: string } | undefined
      if (row) out.set(address, { ...row })
    }
    return out
  }

  saveAiCategories(model: string, records: Map<string, AiCategoryRecord>): void {
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO ai_categories (address, model, category, confidence, fingerprint, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
    )
    const now = Date.now()
    this.transaction(() => {
      for (const [address, r] of records)
        insert.run(address, model, r.category, r.confidence, r.fingerprint, now)
    })
  }

  /** Close the file. A store from `forAccount` shares its opener's connection and closes nothing. */
  close(): void {
    if (this.owner) this.db.close()
  }

  private transaction(fn: () => void): void {
    this.db.exec('BEGIN')
    try {
      fn()
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
}
