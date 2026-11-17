import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { MoneyAiCategoryCache, MoneyAiCategoryRecord, SpendingCategory } from './ai-categories'
import type { MoneyAiMatchCache, MoneyAiMatchRecord } from './ai-match'
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
CREATE TABLE IF NOT EXISTS category_overrides (transaction_id TEXT PRIMARY KEY, category TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_categories (
  model TEXT NOT NULL,
  merchant_key TEXT NOT NULL,
  category TEXT NOT NULL,
  confidence REAL NOT NULL,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY (model, merchant_key)
);
CREATE TABLE IF NOT EXISTS ai_matches (
  model TEXT NOT NULL,
  pair TEXT NOT NULL,
  is_match INTEGER NOT NULL,
  confidence REAL NOT NULL,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY (model, pair)
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
export class MoneyStore implements MoneyAiCategoryCache, MoneyAiMatchCache {
  private db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    // The app and a headless Ordo may share this file: wait for the other's write instead of failing.
    this.db.exec('PRAGMA busy_timeout = 5000;')
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
    this.transaction(() => {
      this.db
        .prepare(
          'DELETE FROM category_overrides WHERE transaction_id IN (SELECT id FROM transactions WHERE account_name = ?)',
        )
        .run(name)
      this.db.prepare('DELETE FROM transactions WHERE account_name = ?').run(name)
    })
  }

  /** Categories you chose yourself, by transaction id. They win over the bank, the rules and AI. */
  categoryOverrides(): Map<string, string> {
    const rows = this.db.prepare('SELECT transaction_id AS id, category FROM category_overrides').all() as {
      id: string
      category: string
    }[]
    return new Map(rows.map((r) => [r.id, r.category]))
  }

  /** Set your own category for a transaction, or clear it with null. False if there's no such transaction. */
  setCategoryOverride(transactionId: string, category: string | null): boolean {
    const exists = this.db.prepare('SELECT 1 FROM transactions WHERE id = ?').get(transactionId)
    if (!exists) return false
    if (category === null)
      this.db.prepare('DELETE FROM category_overrides WHERE transaction_id = ?').run(transactionId)
    else
      this.db
        .prepare('INSERT OR REPLACE INTO category_overrides (transaction_id, category) VALUES (?, ?)')
        .run(transactionId, category)
    return true
  }

  // AI answers, cached by model so a second run only asks about what's new or changed.

  getAiCategories(model: string, keys: string[]): Map<string, MoneyAiCategoryRecord> {
    const out = new Map<string, MoneyAiCategoryRecord>()
    const get = this.db.prepare(
      'SELECT category, confidence, fingerprint FROM ai_categories WHERE model = ? AND merchant_key = ?',
    )
    for (const key of keys) {
      const r = get.get(model, key) as
        { category: string; confidence: number; fingerprint: string } | undefined
      if (r)
        out.set(key, {
          category: r.category as SpendingCategory,
          confidence: r.confidence,
          fingerprint: r.fingerprint,
        })
    }
    return out
  }

  saveAiCategories(model: string, records: Map<string, MoneyAiCategoryRecord>): void {
    const put = this.db.prepare(
      'INSERT OR REPLACE INTO ai_categories (model, merchant_key, category, confidence, fingerprint) VALUES (?, ?, ?, ?, ?)',
    )
    this.transaction(() => {
      for (const [key, r] of records) put.run(model, key, r.category, r.confidence, r.fingerprint)
    })
  }

  getAiMatches(model: string, pairs: string[]): Map<string, MoneyAiMatchRecord> {
    const out = new Map<string, MoneyAiMatchRecord>()
    const get = this.db.prepare(
      'SELECT is_match, confidence, fingerprint FROM ai_matches WHERE model = ? AND pair = ?',
    )
    for (const pair of pairs) {
      const r = get.get(model, pair) as
        { is_match: number; confidence: number; fingerprint: string } | undefined
      if (r) out.set(pair, { match: r.is_match === 1, confidence: r.confidence, fingerprint: r.fingerprint })
    }
    return out
  }

  saveAiMatches(model: string, records: Map<string, MoneyAiMatchRecord>): void {
    const put = this.db.prepare(
      'INSERT OR REPLACE INTO ai_matches (model, pair, is_match, confidence, fingerprint) VALUES (?, ?, ?, ?, ?)',
    )
    this.transaction(() => {
      for (const [pair, r] of records) put.run(model, pair, r.match ? 1 : 0, r.confidence, r.fingerprint)
    })
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
      "DELETE FROM transactions; DELETE FROM bills; DELETE FROM dismissed; DELETE FROM splits; DELETE FROM settlements; DELETE FROM people WHERE id <> 'me'; " +
        'DELETE FROM category_overrides; DELETE FROM ai_categories; DELETE FROM ai_matches;',
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
