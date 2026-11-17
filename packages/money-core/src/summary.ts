import { monthOf } from './dates'
import type { Transaction } from './types'

export interface TransactionFilter {
  account?: string
  /** `YYYY-MM` */
  month?: string
}

export interface MonthTotal {
  month: string
  moneyIn: number
  moneyOut: number
}

export interface TransactionSummary {
  moneyIn: number
  /** Positive pence. */
  moneyOut: number
  /** Spending (money out, excluding transfers) per category, largest first. */
  byCategory: { category: string; amount: number }[]
  /** Newest month first. */
  byMonth: MonthTotal[]
}

/** Not spending: moving your own money about. */
const NOT_SPEND = new Set(['Transfers'])

export function filterTransactions(transactions: Transaction[], f: TransactionFilter): Transaction[] {
  return transactions.filter(
    (t) => (!f.account || t.accountName === f.account) && (!f.month || monthOf(t.date) === f.month),
  )
}

export function summarise(transactions: Transaction[]): TransactionSummary {
  let moneyIn = 0
  let moneyOut = 0
  const cats = new Map<string, number>()
  const months = new Map<string, MonthTotal>()
  for (const t of transactions) {
    const m = months.get(monthOf(t.date)) ?? { month: monthOf(t.date), moneyIn: 0, moneyOut: 0 }
    months.set(m.month, m)
    if (t.amount > 0) {
      moneyIn += t.amount
      m.moneyIn += t.amount
      continue
    }
    moneyOut -= t.amount
    m.moneyOut -= t.amount
    const c = t.category ?? 'Other'
    if (!NOT_SPEND.has(c)) cats.set(c, (cats.get(c) ?? 0) - t.amount)
  }
  return {
    moneyIn,
    moneyOut,
    byCategory: [...cats]
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category)),
    byMonth: [...months.values()].sort((a, b) => b.month.localeCompare(a.month)),
  }
}
