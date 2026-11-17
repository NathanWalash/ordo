// Read bank statement CSVs. Auto-detects the common UK layouts and falls back to a
// column mapping the person picks when it can't.

import { hash, parseAmount } from './amount'
import { categorise, tidyCategory } from './categories'
import { guessDateOrder, parseStatementDate, type DateOrder } from './dates'
import { normaliseMerchant } from './merchant'
import type { Transaction } from './types'

/** Which column holds what. Column numbers are zero-based. */
export interface ColumnMapping {
  /** Row index of the header row, or -1 when the file has no header. */
  headerRow: number
  date: number
  description: number
  /** One signed amount column (negative = money out)... */
  amount?: number
  /** ...or separate money-out and money-in columns. */
  debit?: number
  credit?: number
  balance?: number
  category?: number
  /** Extra detail shown after the description, e.g. Monzo's `Subtitle`. Not used for the merchant. */
  reference?: number
  dateOrder?: DateOrder
}

export type StatementResult =
  | {
      ok: true
      /** Recognised layout, e.g. `Monzo`, or `Custom` when a mapping was supplied. */
      layout: string
      mapping: ColumnMapping
      headers: string[]
      transactions: Transaction[]
      /** Rows that weren't transactions (blank, pending, footers, zero amounts). */
      skipped: number
    }
  | {
      ok: false
      error: 'empty' | 'unrecognised' | 'no-rows'
      message: string
      /** The first rows of the file, for a mapping UI. */
      sample: string[][]
      /** Best guess at the mapping, for the UI to start from. */
      suggested: ColumnMapping
    }

/** Split CSV text into rows of cells. Handles quotes, escaped quotes, CRLF and a BOM. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const delimiter = guessDelimiter(src)
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === delimiter) {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''))
}

function guessDelimiter(src: string): string {
  const head = src.split(/\r?\n/).slice(0, 10).join('\n')
  const count = (d: string) => head.split(d).length - 1
  return [',', ';', '\t'].reduce((best, d) => (count(d) > count(best) ? d : best), ',')
}

const norm = (h: string) =>
  h
    .toLowerCase()
    .replace(/[£()]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

const DATE = [
  'date',
  'transaction date',
  'completed date',
  'posted date',
  'posting date',
  'value date',
  'booking date',
  'started date',
  'created',
]
const DESCRIPTION = [
  'counter party',
  'counterparty',
  'name',
  'title',
  'payee',
  'merchant',
  'merchant name',
  'description',
  'transaction description',
  'details',
  'transaction details',
  'narrative',
  'memo',
  'reference',
]
const AMOUNT = ['amount', 'amount gbp', 'transaction amount', 'value', 'amount in gbp']
const DEBIT = [
  'debit',
  'debit amount',
  'paid out',
  'money out',
  'out',
  'withdrawals',
  'withdrawal',
  'payments',
  'spent',
]
const CREDIT = ['credit', 'credit amount', 'paid in', 'money in', 'in', 'deposits', 'deposit', 'received']
const BALANCE = ['balance', 'balance gbp', 'running balance']
const CATEGORY = ['category', 'categories', 'spending category']
const REFERENCE = ['subtitle']

function find(headers: string[], names: string[]): number | undefined {
  for (const n of names) {
    const i = headers.indexOf(n)
    if (i >= 0) return i
  }
  return undefined
}

function mappingFromHeader(raw: string[], headerRow: number): ColumnMapping | null {
  const h = raw.map(norm)
  const date = find(h, DATE)
  const description = find(h, DESCRIPTION)
  if (date === undefined || description === undefined) return null
  const amount = find(h, AMOUNT)
  const debit = find(h, DEBIT)
  const credit = find(h, CREDIT)
  if (amount === undefined && (debit === undefined || credit === undefined)) return null
  return {
    headerRow,
    date,
    description,
    ...(amount !== undefined ? { amount } : { debit, credit }),
    balance: find(h, BALANCE),
    category: find(h, CATEGORY),
    reference: find(h, REFERENCE),
  }
}

function layoutName(raw: string[]): string {
  const h = new Set(raw.map(norm))
  if (h.has('transaction id') && h.has('emoji')) return 'Monzo'
  // The Monzo app's search export: ID, Created, Title, Subtitle, Amount, Currency, Categories.
  if (h.has('created') && h.has('title') && h.has('subtitle')) return 'Monzo'
  if (h.has('counter party') && h.has('spending category')) return 'Starling'
  if (h.has('started date') && h.has('completed date')) return 'Revolut'
  if (h.has('paid out') && h.has('paid in')) return 'Nationwide'
  if (h.has('debit amount') && h.has('credit amount')) return 'Lloyds'
  return 'CSV'
}

/** Find the header row (banks like Nationwide put account details above it) and map its columns. */
export function detectMapping(rows: string[][]): { mapping: ColumnMapping; layout: string } | null {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const mapping = mappingFromHeader(rows[i]!, i)
    if (mapping) return { mapping, layout: layoutName(rows[i]!) }
  }
  return detectHeaderless(rows)
}

/** HSBC's transaction codes at the end of a description: contactless, card, direct debit... */
export const HSBC_CODE = /\s(\)\)\)|VIS|DD|SO|BP|OBP|CR|DR|ATM)$/

/**
 * Files with no header row, like HSBC's `13/11/2026,TESCO STORES LEEDS ))),-3.41`: three
 * columns of date, description and signed amount on (nearly) every row.
 */
function detectHeaderless(rows: string[][]): { mapping: ColumnMapping; layout: string } | null {
  const body = rows.slice(0, 40)
  if (!body.length) return null
  const fits = body.filter(
    (r) => r.length === 3 && parseStatementDate(r[0]!) !== null && parseAmount(r[2]!) !== null && r[1],
  )
  if (fits.length / body.length < 0.9) return null
  const coded = fits.filter((r) => HSBC_CODE.test(r[1]!)).length / fits.length
  return {
    mapping: { headerRow: -1, date: 0, description: 1, amount: 2 },
    layout: coded > 0.5 ? 'HSBC' : 'CSV',
  }
}

/**
 * A best guess for files without a recognisable header: the column that reads as dates,
 * the column that reads as amounts and the wordiest text column.
 */
export function suggestMapping(rows: string[][]): ColumnMapping {
  const detected = detectMapping(rows)
  if (detected) return detected.mapping
  const body = rows.slice(0, 30)
  const width = Math.max(0, ...body.map((r) => r.length))
  const share = (col: number, test: (v: string) => boolean) => {
    const vals = body.map((r) => r[col] ?? '').filter(Boolean)
    return vals.length ? vals.filter(test).length / vals.length : 0
  }
  let date = 0
  let amount: number | undefined
  let description = 0
  let bestText = -1
  for (let c = 0; c < width; c++) {
    if (share(c, (v) => parseStatementDate(v) !== null) > 0.6) {
      if (share(date, (v) => parseStatementDate(v) !== null) <= 0.6 || c < date) date = c
      continue
    }
    if (amount === undefined && share(c, (v) => parseAmount(v) !== null) > 0.6) {
      amount = c
      continue
    }
    const avg = body.reduce((n, r) => n + (r[c]?.length ?? 0), 0) / Math.max(1, body.length)
    if (avg > bestText) {
      bestText = avg
      description = c
    }
  }
  const firstIsHeader = rows[0] ? parseStatementDate(rows[0][date] ?? '') === null : false
  return { headerRow: firstIsHeader ? 0 : -1, date, description, amount: amount ?? Math.min(2, width - 1) }
}

function amountOf(row: string[], m: ColumnMapping): number | null {
  if (m.amount !== undefined) return parseAmount(row[m.amount] ?? '')
  const out = m.debit !== undefined ? parseAmount(row[m.debit] ?? '') : null
  const inn = m.credit !== undefined ? parseAmount(row[m.credit] ?? '') : null
  if (out === null && inn === null) return null
  return (inn ?? 0) - Math.abs(out ?? 0)
}

/**
 * Parse a statement into transactions for `accountName`. Pass `mapping` to override
 * detection (from the mapping UI). Identical rows within one file (two £3.20 coffees on
 * the same day) get distinct ids by their order, so a re-import of the same file adds nothing.
 */
export function parseStatement(
  text: string,
  options: { accountName: string; mapping?: ColumnMapping },
): StatementResult {
  const rows = parseCsv(text)
  if (!rows.length)
    return {
      ok: false,
      error: 'empty',
      message: 'This file is empty.',
      sample: [],
      suggested: { headerRow: -1, date: 0, description: 1, amount: 2 },
    }

  const detected = options.mapping ? null : detectMapping(rows)
  const mapping = options.mapping ?? detected?.mapping
  if (!mapping)
    return {
      ok: false,
      error: 'unrecognised',
      message: "Ordo didn't recognise this layout. Choose which column is which.",
      sample: rows.slice(0, 6),
      suggested: suggestMapping(rows),
    }

  const body = rows.slice(mapping.headerRow + 1)
  const order = mapping.dateOrder ?? guessDateOrder(body.map((r) => r[mapping.date] ?? ''))
  const seen = new Map<string, number>()
  const transactions: Transaction[] = []
  let skipped = 0
  for (const row of body) {
    const date = parseStatementDate(row[mapping.date] ?? '', order)
    const amount = amountOf(row, mapping)
    const name = (row[mapping.description] ?? '').replace(/\s+/g, ' ').trim()
    const ref =
      mapping.reference !== undefined ? (row[mapping.reference] ?? '').replace(/\s+/g, ' ').trim() : ''
    const description = ref && ref.toLowerCase() !== name.toLowerCase() ? `${name} · ${ref}` : name
    if (!date || amount === null || amount === 0 || !description) {
      skipped++
      continue
    }
    const base = `${options.accountName}|${date}|${amount}|${description.toLowerCase()}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    const merchant = normaliseMerchant(name || description)
    const bankCategory =
      mapping.category !== undefined ? tidyCategory(row[mapping.category] ?? '') : undefined
    transactions.push({
      id: hash(n ? `${base}|${n}` : base),
      accountName: options.accountName,
      date,
      description,
      amount,
      merchant,
      category: bankCategory ?? categorise(description, merchant, amount),
    })
  }

  if (!transactions.length)
    return {
      ok: false,
      error: 'no-rows',
      message: "Ordo couldn't find any transactions with these columns.",
      sample: rows.slice(0, 6),
      suggested: mapping,
    }

  return {
    ok: true,
    layout: options.mapping ? 'Custom' : (detected?.layout ?? 'CSV'),
    mapping,
    headers: mapping.headerRow >= 0 ? rows[mapping.headerRow]! : [],
    transactions,
    skipped,
  }
}
