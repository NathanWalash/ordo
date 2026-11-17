import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { Cadence, ISODate } from './dates'
import {
  ME,
  type BillSource,
  type BillStatus,
  type Person,
  type Settlement,
  type Split,
  type SplitMode,
  type SplitShare,
  type StoredBill,
  type Transaction,
} from './types'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  account_name TEXT NOT NULL,
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  amount INTEGER NOT NULL,
  category TEXT,
  merchant TEXT,
  imported_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS transactions_date ON transactions (date);
CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  cadence TEXT NOT NULL,
  anchor_date TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  merchant_key TEXT,
  cancelled_on TEXT
);
CREATE TABLE IF NOT EXISTS dismissed (key TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS splits (
  bill_id TEXT PRIMARY KEY,
  paid_by TEXT NOT NULL,
  mode TEXT NOT NULL,
  shares TEXT NOT NULL,
  since TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settlements (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  date TEXT NOT NULL,
  note TEXT
);
`

type TxRow = {
  id: string
  account_name: string
  date: string
  description: string
  amount: number
  category: string | null
  merchant: string | null
}
type BillRow = {
  id: string
  name: string
  amount: number
  cadence: string
  anchor_date: string
  source: string
  status: string
  merchant_key: string | null
  cancelled_on: string | null
}

/**
 * Money data in its own local SQLite file: imported statement lines, bills, flatmates,
 * splits and settlements. Nothing here leaves the computer.
 */
export class MoneyStore {
  private db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(SCHEMA)
    this.db.prepare('INSERT OR IGNORE INTO people (id, name, position) VALUES (?, ?, 0)').run(ME, 'Me')
  }

  // Transactions

  /** Insert new transactions; ones already imported (same id) are left alone. */
  addTransactions(txs: Transaction[]): { added: number; duplicates: number } {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO transactions (id, account_name, date, description, amount, category, merchant, imported_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    const now = new Date().toISOString()
    let added = 0
    this.transaction(() => {
      for (const t of txs) {
        const r = insert.run(
          t.id,
          t.accountName,
          t.date,
          t.description,
          t.amount,
          t.category ?? null,
          t.merchant ?? null,
          now,
        )
        added += Number(r.changes)
      }
    })
    return { added, duplicates: txs.length - added }
  }

  /** Newest first. */
  transactions(): Transaction[] {
    const rows = this.db.prepare('SELECT * FROM transactions ORDER BY date DESC, rowid DESC').all() as TxRow[]
    return rows.map((r) => ({
      id: r.id,
      accountName: r.account_name,
      date: r.date,
      description: r.description,
      amount: r.amount,
      ...(r.category !== null && { category: r.category }),
      ...(r.merchant !== null && { merchant: r.merchant }),
    }))
  }

  accounts(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT account_name AS a FROM transactions ORDER BY account_name')
      .all() as { a: string }[]
    return rows.map((r) => r.a)
  }

  removeAccount(name: string): void {
    this.db.prepare('DELETE FROM transactions WHERE account_name = ?').run(name)
  }

  // Bills

  bills(): StoredBill[] {
    const rows = this.db.prepare('SELECT * FROM bills ORDER BY name').all() as BillRow[]
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      amount: r.amount,
      cadence: r.cadence as Cadence,
      anchorDate: r.anchor_date,
      source: r.source as BillSource,
      status: r.status as BillStatus,
      ...(r.merchant_key !== null && { merchantKey: r.merchant_key }),
      ...(r.cancelled_on !== null && { cancelledOn: r.cancelled_on }),
    }))
  }

  bill(id: string): StoredBill | undefined {
    return this.bills().find((b) => b.id === id)
  }

  /** Create (without an id) or replace a bill. */
  saveBill(b: Omit<StoredBill, 'id'> & { id?: string }): StoredBill {
    const bill: StoredBill = { ...b, id: b.id ?? randomUUID() }
    this.db
      .prepare(
        'INSERT OR REPLACE INTO bills (id, name, amount, cadence, anchor_date, source, status, merchant_key, cancelled_on) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        bill.id,
        bill.name,
        bill.amount,
        bill.cadence,
        bill.anchorDate,
        bill.source,
        bill.status,
        bill.merchantKey ?? null,
        bill.cancelledOn ?? null,
      )
    return bill
  }

  deleteBill(id: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM splits WHERE bill_id = ?').run(id)
      this.db.prepare('DELETE FROM bills WHERE id = ?').run(id)
    })
  }

  dismissed(): Set<string> {
    const rows = this.db.prepare('SELECT key FROM dismissed').all() as { key: string }[]
    return new Set(rows.map((r) => r.key))
  }

  dismiss(key: string): void {
    this.db.prepare('INSERT OR IGNORE INTO dismissed (key) VALUES (?)').run(key)
  }

  // People

  /** "Me" first, then everyone else in the order they were added. */
  people(): Person[] {
    return this.db.prepare('SELECT id, name FROM people ORDER BY position').all() as unknown as Person[]
  }

  savePerson(p: { id?: string; name: string }): Person {
    const id = p.id ?? randomUUID()
    this.db
      .prepare(
        'INSERT INTO people (id, name, position) VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM people)) ' +
          'ON CONFLICT(id) DO UPDATE SET name = excluded.name',
      )
      .run(id, p.name)
    return { id, name: p.name }
  }

  deletePerson(id: string): void {
    if (id === ME) throw new Error("You can't remove yourself")
    this.db.prepare('DELETE FROM people WHERE id = ?').run(id)
  }

  // Splits

  splits(): Split[] {
    const rows = this.db.prepare('SELECT * FROM splits').all() as {
      bill_id: string
      paid_by: string
      mode: string
      shares: string
      since: string
    }[]
    return rows.map((r) => ({
      billId: r.bill_id,
      paidBy: r.paid_by,
      mode: r.mode as SplitMode,
      shares: JSON.parse(r.shares) as SplitShare[],
      since: r.since as ISODate,
    }))
  }

  saveSplit(s: Split): void {
    this.db
      .prepare('INSERT OR REPLACE INTO splits (bill_id, paid_by, mode, shares, since) VALUES (?, ?, ?, ?, ?)')
      .run(s.billId, s.paidBy, s.mode, JSON.stringify(s.shares), s.since)
  }

  deleteSplit(billId: string): void {
    this.db.prepare('DELETE FROM splits WHERE bill_id = ?').run(billId)
  }

  // Settlements

  /** Newest first. */
  settlements(): Settlement[] {
    const rows = this.db.prepare('SELECT * FROM settlements ORDER BY date DESC, rowid DESC').all() as {
      id: string
      from_id: string
      to_id: string
      amount: number
      date: string
      note: string | null
    }[]
    return rows.map((r) => ({
      id: r.id,
      from: r.from_id,
      to: r.to_id,
      amount: r.amount,
      date: r.date,
      ...(r.note !== null && { note: r.note }),
    }))
  }

  addSettlement(s: Omit<Settlement, 'id'>): Settlement {
    const settlement = { ...s, id: randomUUID() }
    this.db
      .prepare('INSERT INTO settlements (id, from_id, to_id, amount, date, note) VALUES (?, ?, ?, ?, ?, ?)')
      .run(settlement.id, s.from, s.to, s.amount, s.date, s.note ?? null)
    return settlement
  }

  deleteSettlement(id: string): void {
    this.db.prepare('DELETE FROM settlements WHERE id = ?').run(id)
  }

  /** Forget everything except "Me". */
  clear(): void {
    this.db.exec(
      "DELETE FROM transactions; DELETE FROM bills; DELETE FROM dismissed; DELETE FROM splits; DELETE FROM settlements; DELETE FROM people WHERE id <> 'me';",
    )
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
