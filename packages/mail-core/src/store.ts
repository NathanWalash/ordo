import { DatabaseSync } from 'node:sqlite'
import type { MessageHeader } from './types'

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
`

/**
 * Local cache of scanned message headers (never bodies), so re-scans only fetch
 * new mail. Backed by Node's built-in SQLite.
 */
export class MailStore {
  private db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
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

  /** Delete every cached header and state, e.g. when the account is disconnected. */
  clear(): void {
    this.db.exec('DELETE FROM messages; DELETE FROM mailbox_state; DELETE FROM replied_to;')
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
