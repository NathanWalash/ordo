// Month-by-month series for the Finances charts, and "this month against your usual month".
// Every number comes from `summarise`, so the charts always agree with the totals beside them:
// money between your own accounts is left out the same way, transfers are never spending, and a
// refund is money in rather than less spending.

import { addMonths, monthOf, toISODate, type ISODate } from './dates'
import { summarise } from './summary'
import type { Transaction } from './types'

/**
 * Why a month's numbers are only part of a month: `start` is the first month of your statements
 * when they begin after the 1st, `to-date` is the month you're in.
 */
export type PartialMonth = 'start' | 'to-date'

export interface MonthFlow {
  /** `YYYY-MM` */
  month: string
  moneyIn: number
  /** Positive pence. */
  moneyOut: number
  /** Money in minus money out: negative when more went out. */
  net: number
  /** Spending (money out, excluding transfers), so the chart can show it beside money out. */
  spent: number
  partial?: PartialMonth
}

export interface CategorySeries {
  category: string
  /** Spending across every month, in pence. */
  total: number
  /** Spending in each month, lined up with `SpendingTrends.months`; 0 for a month with none. */
  monthly: number[]
  /** The median of `monthly` over whole months, or null when there isn't a whole month yet. */
  usual: number | null
}

export interface SpendingTrends {
  /** Every month from the first transaction to the last, oldest first, with empty months filled in. */
  months: MonthFlow[]
  /** Every category with spending, largest total first. */
  categories: CategorySeries[]
}

export interface TrendOptions {
  /** As in `summarise`: leave out money moved between your own accounts (the "All accounts" view). */
  excludeOwnTransfers?: boolean
  /** Today, for working out which month is still going. Defaults to the computer's date. */
  today?: ISODate
}

/** The middle value (the mean of the middle two for an even count), rounded to whole pence; 0 for none. */
export function median(values: readonly number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}

/** Every `YYYY-MM` from `from` to `to`, inclusive; empty when `from` is after `to`. */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = []
  for (let m = from; m <= to; m = monthOf(addMonths(`${m}-01`, 1))) out.push(m)
  return out
}

const byMonth = (transactions: readonly Transaction[]) => {
  const groups = new Map<string, Transaction[]>()
  for (const t of transactions) {
    const m = monthOf(t.date)
    const g = groups.get(m)
    if (g) g.push(t)
    else groups.set(m, [t])
  }
  return groups
}

const spentIn = (s: ReturnType<typeof summarise>) => s.byCategory.reduce((n, c) => n + c.amount, 0)

/** Which months only cover part of the month: the first (when it starts after the 1st) and today's. */
function partialMonths(transactions: readonly Transaction[], today: ISODate): Map<string, PartialMonth> {
  const out = new Map<string, PartialMonth>()
  let first: ISODate | null = null
  for (const t of transactions) if (first === null || t.date < first) first = t.date
  if (first && !first.endsWith('-01')) out.set(monthOf(first), 'start')
  out.set(monthOf(today), 'to-date')
  return out
}

/**
 * Money in, out and net for every month, and each category's spending month by month with its
 * usual (median) whole month. Partial months are marked and never count towards the usual.
 */
export function spendingTrends(
  transactions: readonly Transaction[],
  opts: TrendOptions = {},
): SpendingTrends {
  if (!transactions.length) return { months: [], categories: [] }
  const groups = byMonth(transactions)
  const keys = [...groups.keys()].sort()
  const months = monthRange(keys[0]!, keys.at(-1)!)
  const partial = partialMonths(transactions, opts.today ?? toISODate())
  const cats = new Map<string, number[]>()
  const flows = months.map((month, i): MonthFlow => {
    const s = summarise(groups.get(month) ?? [], { excludeOwnTransfers: opts.excludeOwnTransfers })
    for (const c of s.byCategory) {
      const row = cats.get(c.category) ?? months.map(() => 0)
      row[i] = c.amount
      cats.set(c.category, row)
    }
    const p = partial.get(month)
    return {
      month,
      moneyIn: s.moneyIn,
      moneyOut: s.moneyOut,
      net: s.moneyIn - s.moneyOut,
      spent: spentIn(s),
      ...(p && { partial: p }),
    }
  })
  const whole = flows.flatMap((f, i) => (f.partial ? [] : [i]))
  const categories = [...cats]
    .map(([category, monthly]) => ({
      category,
      total: monthly.reduce((a, b) => a + b, 0),
      monthly,
      usual: whole.length ? median(whole.map((i) => monthly[i]!)) : null,
    }))
    .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category))
  return { months: flows, categories }
}

export interface UsualRow {
  category: string
  /** Spending this month (to date, when it's the month you're in), in pence. */
  thisMonth: number
  /** The median of the same stretch of the months before, in pence. */
  usual: number
  /** `thisMonth - usual`: positive means you've spent more than usual. */
  difference: number
}

export interface UsualComparison {
  month: string
  /**
   * Set when `month` is still going: only days 1 to this of each earlier month are counted, so
   * "so far this month" is set against "by this point in a usual month".
   */
  throughDay: number | null
  /** The earlier months the usual is the median of, oldest first. */
  baseline: string[]
  /** All spending: this month's against the median month's (not the sum of the category medians). */
  total: UsualRow
  /** Every category spent on this month or in the baseline, biggest change first. */
  categories: UsualRow[]
}

const daysIn = (ym: string) => {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/**
 * This month's spending per category against the median of up to `lookback` whole months before
 * it (6 by default). A first month that starts after the 1st is left out, as it's only part of a
 * month. Null when there's no earlier whole month to compare with.
 */
export function compareWithUsual(
  transactions: readonly Transaction[],
  month: string,
  opts: TrendOptions & { lookback?: number } = {},
): UsualComparison | null {
  const today = opts.today ?? toISODate()
  const lookback = opts.lookback ?? 6
  const throughDay = monthOf(today) === month ? Number(today.slice(8, 10)) : null
  const groups = byMonth(transactions)
  const first = [...groups.keys()].sort()[0]
  if (!first || month <= first) return null
  const partial = partialMonths(transactions, today)
  const baseline = monthRange(first, monthOf(addMonths(`${month}-01`, -1)))
    .filter((m) => !partial.has(m))
    .slice(-Math.max(1, lookback))
  if (!baseline.length) return null

  const summary = (m: string) => {
    const rows = groups.get(m) ?? []
    const last = throughDay === null ? 31 : Math.min(throughDay, daysIn(m))
    const upTo = throughDay === null ? rows : rows.filter((t) => Number(t.date.slice(8, 10)) <= last)
    return summarise(upTo, { excludeOwnTransfers: opts.excludeOwnTransfers })
  }
  const now = summary(month)
  const before = baseline.map(summary)
  const amounts = (s: ReturnType<typeof summarise>) =>
    new Map(s.byCategory.map((c) => [c.category, c.amount]))
  const nowBy = amounts(now)
  const beforeBy = before.map(amounts)
  const names = new Set([...nowBy.keys(), ...beforeBy.flatMap((b) => [...b.keys()])])
  const row = (category: string, thisMonth: number, usual: number): UsualRow => ({
    category,
    thisMonth,
    usual,
    difference: thisMonth - usual,
  })
  const categories = [...names]
    .map((c) => row(c, nowBy.get(c) ?? 0, median(beforeBy.map((b) => b.get(c) ?? 0))))
    .sort(
      (a, b) =>
        Math.abs(b.difference) - Math.abs(a.difference) ||
        b.thisMonth - a.thisMonth ||
        a.category.localeCompare(b.category),
    )
  return {
    month,
    throughDay,
    baseline,
    total: row('All spending', spentIn(now), median(before.map(spentIn))),
    categories,
  }
}
