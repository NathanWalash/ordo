import { DatabaseSync } from 'node:sqlite'
import type { AiCategoryCache, AiCategoryRecord } from './ai-sort'
import type {
  Address,
  Category,
  CleanupRecord,
  CleanupSenderResult,
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

const SCHEMA = `
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
CREATE INDEX IF NOT EXISTS messages_from ON messages (from_address);
CREATE TABLE IF NOT EXISTS replied_to (address TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS ai_categories (
  address TEXT NOT NULL,
  model TEXT NOT NULL,
  category TEXT NOT NULL,
  confidence REAL NOT NULL,
  fingerprint TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (address, model)
);
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

/** Columns added to `messages` for the mail client, for databases created before it. */
const MESSAGE_COLUMNS: [string, string][] = [
  ['flagged', 'INTEGER NOT NULL DEFAULT 0'],
  ['answered', 'INTEGER NOT NULL DEFAULT 0'],
  ['to_json', 'TEXT'],
  ['cc_json', 'TEXT'],
  ['message_id', 'TEXT'],
  ['has_attachments', 'INTEGER NOT NULL DEFAULT 0'],
  // When Ordo last changed this message's flags itself (ms), so a sync doesn't undo it.
  ['flags_at', 'INTEGER NOT NULL DEFAULT 0'],
]

// INSERT OR REPLACE doesn't fire delete triggers (recursive_triggers is off), so re-caching a
// message's headers keeps its body; a real delete (moved, expunged, renumbered) drops it.
const AFTER_COLUMNS = `
CREATE INDEX IF NOT EXISTS messages_date ON messages (mailbox, date DESC);
CREATE TRIGGER IF NOT EXISTS messages_forget_body AFTER DELETE ON messages BEGIN
  DELETE FROM bodies WHERE mailbox = old.mailbox AND uid = old.uid;
END;
`

type CleanupRow = {
  id: number
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

export type NewCleanup = Omit<CleanupRecord, 'id' | 'canUndo' | 'undoneAt' | 'restored'>

function toCleanup(r: CleanupRow): CleanupRecord {
  const uidMap = r.uid_map ? (JSON.parse(r.uid_map) as [number, number][]) : null
  return {
    id: r.id,
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

/**
 * Local cache of message headers, the folder list and the bodies of messages you've opened, so
 * re-scans only fetch new mail and search works offline. Backed by Node's built-in SQLite.
 */
export class MailStore implements AiCategoryCache {
  private db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    // The app and a headless Ordo may share this file: wait for the other's write instead of failing.
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(SCHEMA)
    const have = new Set(
      (this.db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name),
    )
    for (const [name, type] of MESSAGE_COLUMNS)
      if (!have.has(name)) this.db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`)
    const state = new Set(
      (this.db.prepare('PRAGMA table_info(mailbox_state)').all() as { name: string }[]).map((c) => c.name),
    )
    if (!state.has('flag_cursor'))
      this.db.exec('ALTER TABLE mailbox_state ADD COLUMN flag_cursor INTEGER NOT NULL DEFAULT 0')
    this.db.exec(AFTER_COLUMNS)
  }

  /** Where the rotating flag refresh of older messages got to in a mailbox (see reconcileFolder). */
  flagCursor(mailbox: string): number {
    const row = this.db.prepare('SELECT flag_cursor FROM mailbox_state WHERE mailbox = ?').get(mailbox) as
      { flag_cursor: number } | undefined
    return row?.flag_cursor ?? 0
  }

  setFlagCursor(mailbox: string, cursor: number): void {
    this.db.prepare('UPDATE mailbox_state SET flag_cursor = ? WHERE mailbox = ?').run(cursor, mailbox)
  }

  mailboxState(mailbox: string): MailboxState | null {
    const row = this.db
      .prepare('SELECT uid_validity, last_uid FROM mailbox_state WHERE mailbox = ?')
      .get(mailbox) as { uid_validity: string; last_uid: number } | undefined
    return row ? { uidValidity: row.uid_validity, lastUid: row.last_uid } : null
  }

  setMailboxState(mailbox: string, state: MailboxState): void {
    this.db
      .prepare(
        'INSERT INTO mailbox_state (mailbox, uid_validity, last_uid) VALUES (?, ?, ?) ' +
          'ON CONFLICT(mailbox) DO UPDATE SET uid_validity = excluded.uid_validity, last_uid = excluded.last_uid',
      )
      .run(mailbox, state.uidValidity, state.lastUid)
  }

  /** Forget everything cached for a mailbox (used when its UIDVALIDITY changes). */
  resetMailbox(mailbox: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE mailbox = ?').run(mailbox)
      this.db.prepare('DELETE FROM mailbox_state WHERE mailbox = ?').run(mailbox)
    })
  }

  saveHeaders(headers: MessageHeader[]): void {
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO messages (mailbox, uid, date, seen, from_address, from_name, subject, list_id, ' +
        'list_unsubscribe, list_unsubscribe_post, precedence, auto_submitted, flagged, answered, to_json, cc_json, ' +
        'message_id, has_attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    this.transaction(() => {
      for (const h of headers) {
        insert.run(
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
      this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE mailbox = ?').get(mailbox) as { n: number }
    ).n
  }

  headers(mailbox: string): MessageHeader[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE mailbox = ? ORDER BY uid')
      .all(mailbox) as Row[]
    return rows.map(toHeader)
  }

  /** One page of a mailbox, newest first, and how many there are in all. */
  messages(mailbox: string, q: MessageQuery): { total: number; messages: MessageHeader[] } {
    const unread = q.unread ? ' AND seen = 0' : ''
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE mailbox = ?${unread}`).get(mailbox) as {
        n: number
      }
    ).n
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE mailbox = ?${unread} ORDER BY date DESC, uid DESC LIMIT ? OFFSET ?`,
      )
      .all(mailbox, q.limit, q.offset ?? 0) as Row[]
    return { total, messages: rows.map(toHeader) }
  }

  /** One cached message's headers, or null. */
  message(mailbox: string, uid: number): MessageHeader | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE mailbox = ? AND uid = ?').get(mailbox, uid) as
      Row | undefined
    return row ? toHeader(row) : null
  }

  /** Every cached UID in a mailbox, lowest first. */
  cachedUids(mailbox: string): number[] {
    const rows = this.db.prepare('SELECT uid FROM messages WHERE mailbox = ? ORDER BY uid').all(mailbox) as {
      uid: number
    }[]
    return rows.map((r) => r.uid)
  }

  /**
   * Update flags of messages already cached; unknown UIDs are ignored. Returns how many changed.
   * With `fetchedAt`, messages whose flags you changed in Ordo since then are left alone, so a
   * fetch that started before your change can't undo it.
   */
  updateFlags(mailbox: string, updates: readonly FlagUpdate[], fetchedAt = Number.MAX_SAFE_INTEGER): number {
    const update = this.db.prepare(
      'UPDATE messages SET seen = ?, flagged = ?, answered = ? WHERE mailbox = ? AND uid = ? ' +
        'AND (seen != ? OR flagged != ? OR answered != ?) AND flags_at < ?',
    )
    let changed = 0
    this.transaction(() => {
      for (const u of updates) {
        const s = u.seen ? 1 : 0
        const f = u.flagged ? 1 : 0
        const a = u.answered ? 1 : 0
        changed += Number(update.run(s, f, a, mailbox, u.uid, s, f, a, fetchedAt).changes)
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
      `UPDATE messages SET ${flag} = ?, flags_at = ? WHERE mailbox = ? AND uid = ?`,
    )
    const now = Date.now()
    this.transaction(() => {
      for (const uid of uids) update.run(on ? 1 : 0, now, mailbox, uid)
    })
  }

  /**
   * Search cached messages: every word must appear in the subject, a sender or recipient, or the
   * cached body text (case-insensitive for ASCII letters). Newest first.
   */
  search(text: string, q: SearchQuery): MessageHeader[] {
    const terms = text.trim().split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TERMS)
    if (!terms.length) return []
    const where: string[] = []
    const params: (string | number)[] = []
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
        'SELECT m.* FROM messages m LEFT JOIN bodies b ON b.mailbox = m.mailbox AND b.uid = m.uid ' +
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
      'INSERT INTO mailboxes (path, name, role, delimiter, position, total, unread) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    this.transaction(() => {
      this.db.exec('DELETE FROM mailboxes')
      list.forEach((m, i) => insert.run(m.path, m.name, m.role, m.delimiter, i, m.total, m.unread))
      if (!list.length) return
      const keep = new Set(list.map((m) => m.path))
      const cached = this.db.prepare('SELECT DISTINCT mailbox FROM messages').all() as { mailbox: string }[]
      for (const { mailbox } of cached) {
        if (keep.has(mailbox)) continue
        this.db.prepare('DELETE FROM messages WHERE mailbox = ?').run(mailbox)
        this.db.prepare('DELETE FROM mailbox_state WHERE mailbox = ?').run(mailbox)
      }
    })
  }

  /** The cached folder list, in the order it was saved. */
  mailboxes(): MailboxInfo[] {
    const rows = this.db.prepare('SELECT * FROM mailboxes ORDER BY position').all() as {
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
      .prepare('UPDATE mailboxes SET total = ?, unread = ? WHERE path = ?')
      .run(counts.total, counts.unread, path)
  }

  /** Cache a message's body (it never changes for a UID). `searchText` is what search looks in. */
  saveBody(content: MessageContent, searchText: string, at = new Date()): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO bodies (mailbox, uid, content, search_text, fetched_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(content.mailbox, content.uid, JSON.stringify(content), searchText, at.getTime())
  }

  /** A cached body, or null. Flags come from the cached headers, which a sync keeps current. */
  body(mailbox: string, uid: number): MessageContent | null {
    const row = this.db
      .prepare('SELECT content FROM bodies WHERE mailbox = ? AND uid = ?')
      .get(mailbox, uid) as { content: string } | undefined
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
      .prepare('SELECT uid, from_address FROM messages WHERE mailbox = ? ORDER BY uid')
      .all(mailbox) as { uid: number; from_address: string }[]
    for (const r of rows) out.get(r.from_address.trim().toLowerCase())?.push(r.uid)
    return out
  }

  /** Forget cached headers (and bodies) for messages that have left `mailbox`. */
  deleteMessages(mailbox: string, uids: readonly number[]): void {
    const del = this.db.prepare('DELETE FROM messages WHERE mailbox = ? AND uid = ?')
    this.transaction(() => {
      for (const uid of uids) del.run(mailbox, uid)
    })
  }

  addCleanup(c: NewCleanup): CleanupRecord {
    const res = this.db
      .prepare(
        'INSERT INTO cleanups (created_at, mailbox, trash_mailbox, trash_uid_validity, moved, senders, uid_map, error) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
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

  cleanup(id: number): CleanupRecord | null {
    const row = this.db.prepare('SELECT * FROM cleanups WHERE id = ?').get(id) as CleanupRow | undefined
    return row ? toCleanup(row) : null
  }

  /** Every clean-up, newest first. */
  cleanups(): CleanupRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM cleanups ORDER BY created_at DESC, id DESC')
      .all() as CleanupRow[]
    return rows.map(toCleanup)
  }

  markUndone(id: number, restored: number, at: Date): void {
    this.db
      .prepare('UPDATE cleanups SET undone_at = ?, restored = ? WHERE id = ?')
      .run(at.getTime(), restored, id)
  }

  setRepliedTo(addresses: Iterable<string>): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO replied_to (address) VALUES (?)')
    this.transaction(() => {
      this.db.exec('DELETE FROM replied_to')
      for (const a of addresses) insert.run(a.trim().toLowerCase())
    })
  }

  repliedTo(): Set<string> {
    const rows = this.db.prepare('SELECT address FROM replied_to').all() as { address: string }[]
    return new Set(rows.map((r) => r.address))
  }

  /** Delete every cached header, body, folder, state and clean-up record, e.g. when the account is disconnected. */
  clear(): void {
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

  close(): void {
    this.db.close()
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
