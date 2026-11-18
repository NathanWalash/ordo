// This month so far against last month to the same day, with or without a category. Uses the
// ledger, so transfers, held money, pass-throughs and ignored payments are never spending.

import { addMonths, toISODate, type ISODate } from './dates'
import { paybackFacts, type MoneyFact } from './memory'
import type { Ledger } from './ledger'
import type { Transaction } from './types'

export interface PeriodSpend {
  from: ISODate
  to: ISODate
  /** Your own spending, in pence. */
  spent: number
  /** Paybacks that came in for this spending, in pence. */
  paidBack: number
  /** Spent minus paid back. */
  net: number
  byCategory: { category: string; amount: number }[]
}

export interface MonthComparison {
  category: string | null
  account: string | null
  thisMonth: PeriodSpend
  lastMonth: PeriodSpend
  /** This month's net minus last month's: positive means you've spent more. */
  difference: number
  /** Ordo-written notes about what the numbers can't see. */
  caveats: string[]
}

const daysIn = (ym: string) => {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

export interface SpendFilter {
  category?: string
  account?: string
}

/** Spending between two days (inclusive), net of paybacks for it. */
export function spendBetween(
  transactions: readonly Transaction[],
  ledger: Ledger,
  facts: readonly MoneyFact[],
  from: ISODate,
  to: ISODate,
  filter: SpendFilter = {},
): PeriodSpend {
  const byId = new Map(transactions.map((t) => [t.id, t]))
  const cats = new Map<string, number>()
  const wanted = filter.category?.toLowerCase()
  const inCategory = (t: Transaction) => !wanted || (t.category ?? 'Other').toLowerCase() === wanted
  let spent = 0
  const within = (t: Transaction) =>
    t.date >= from && t.date <= to && (!filter.account || t.accountName === filter.account)
  for (const t of transactions) {
    if (!within(t)) continue
    const e = ledger.get(t.id)
    if (!e?.spend) continue
    const c = t.category ?? 'Other'
    if (!inCategory(t)) continue
    spent += e.spend
    cats.set(c, (cats.get(c) ?? 0) + e.spend)
  }
  // A payback counts where the spending it paid back was: in that period and that category, shared
  // in proportion when it covered several outgoings, and only for the part of each outgoing that is
  // still your spending (not ignored, passed through, a transfer or money you passed on). A payback
  // for an event (no outgoings named) counts when it came in, and only without a category.
  let paidBack = 0
  for (const p of paybackFacts(facts)) {
    const inn = byId.get(p.inId)
    if (!inn || ledger.get(inn.id)?.role !== 'payback') continue
    const outs = p.outIds.map((id) => byId.get(id)).filter((t): t is Transaction => !!t)
    if (!outs.length) {
      if (!wanted && within(inn)) paidBack += inn.amount
      continue
    }
    const total = outs.reduce((n, o) => n - o.amount, 0)
    const here = outs
      .filter((o) => within(o) && inCategory(o))
      .reduce((n, o) => n + (ledger.get(o.id)?.spend ?? 0), 0)
    paidBack += total > 0 ? Math.min(here, Math.round((inn.amount * here) / total)) : 0
  }
  return {
    from,
    to,
    spent,
    paidBack,
    net: spent - paidBack,
    byCategory: [...cats]
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category)),
  }
}

/**
 * This month from the 1st to `today` against last month from the 1st to the same day (or its last
 * day, when last month was shorter).
 */
export function compareMonthToDate(
  transactions: readonly Transaction[],
  ledger: Ledger,
  facts: readonly MoneyFact[],
  opts: SpendFilter & { today?: ISODate; caveats?: string[] } = {},
): MonthComparison {
  const today = opts.today ?? toISODate()
  const day = Number(today.slice(8, 10))
  const thisStart = `${today.slice(0, 7)}-01`
  const lastStart = addMonths(thisStart, -1)
  const lastDay = Math.min(day, daysIn(lastStart.slice(0, 7)))
  const lastEnd = `${lastStart.slice(0, 7)}-${String(lastDay).padStart(2, '0')}`
  const filter = { category: opts.category, account: opts.account }
  const thisMonth = spendBetween(transactions, ledger, facts, thisStart, today, filter)
  const lastMonth = spendBetween(transactions, ledger, facts, lastStart, lastEnd, filter)
  return {
    category: opts.category ?? null,
    account: opts.account ?? null,
    thisMonth,
    lastMonth,
    difference: thisMonth.net - lastMonth.net,
    caveats: opts.caveats ?? [],
  }
}
