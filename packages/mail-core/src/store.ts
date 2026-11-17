import { DatabaseSync } from 'node:sqlite'
import type { AiCategoryCache, AiCategoryRecord } from './ai-sort'
import type { Category, CleanupRecord, CleanupSenderResult, MessageHeader } from './types'

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

/**
 * Local cache of scanned message headers (never bodies), so re-scans only fetch
 * new mail. Backed by Node's built-in SQLite.
 */
export class MailStore implements AiCategoryCache {
  private db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    // The app and a headless Ordo may share this file: wait for the other's write instead of failing.
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(SCHEMA)
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
        'list_unsubscribe, list_unsubscribe_post, precedence, auto_submitted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
    return rows.map((r) => ({
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
    }))
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

  /** Forget cached headers for messages that have left `mailbox`. */
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

  /** Delete every cached header, state and clean-up record, e.g. when the account is disconnected. */
  clear(): void {
    this.db.exec(
      'DELETE FROM messages; DELETE FROM mailbox_state; DELETE FROM replied_to; DELETE FROM ai_categories; DELETE FROM cleanups;',
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
