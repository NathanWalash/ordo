import { describe, expect, it } from 'vitest'
import { summarise } from './summary'
import { pairOwnTransfers } from './transfers'
import { compareWithUsual, median, monthRange, spendingTrends } from './trends'
import type { Transaction } from './types'

let n = 0
const tx = (
  date: string,
  amount: number,
  category?: string,
  extra: Partial<Transaction> = {},
): Transaction => ({
  id: `t${++n}`,
  accountName: 'Monzo',
  date,
  description: category ?? 'Something',
  amount,
  ...(category && { category }),
  ...extra,
})

const TODAY = '2026-11-23'

describe('median', () => {
  it('is 0 for nothing, the middle for an odd count and the rounded mean of the middle two for an even one', () => {
    expect(median([])).toBe(0)
    expect(median([500])).toBe(500)
    expect(median([300, 100, 200])).toBe(200)
    expect(median([100, 200, 400, 0])).toBe(150)
    expect(median([1, 2])).toBe(2)
    expect(median([-300, 100])).toBe(-100)
  })

  it('leaves its input alone', () => {
    const values = [3, 1, 2]
    median(values)
    expect(values).toEqual([3, 1, 2])
  })
})

describe('monthRange', () => {
  it('lists every month, across a year end', () => {
    expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
    expect(monthRange('2026-03', '2026-03')).toEqual(['2026-03'])
    expect(monthRange('2026-04', '2026-03')).toEqual([])
  })
})

describe('spendingTrends', () => {
  it('is empty with no transactions', () => {
    expect(spendingTrends([], { today: TODAY })).toEqual({ months: [], categories: [] })
  })

  it('gives money in, out, net and spending per month, oldest first, with empty months filled in', () => {
    const t = spendingTrends(
      [
        tx('2026-07-01', 200000, 'Income'),
        tx('2026-07-03', -5000, 'Groceries'),
        tx('2026-07-04', -20000, 'Transfers'),
        tx('2026-09-02', -4000, 'Groceries'),
        tx('2026-09-09', -1500, 'Eating out'),
      ],
      { today: TODAY },
    )
    expect(t.months).toEqual([
      { month: '2026-07', moneyIn: 200000, moneyOut: 25000, net: 175000, spent: 5000 },
      { month: '2026-08', moneyIn: 0, moneyOut: 0, net: 0, spent: 0 },
      { month: '2026-09', moneyIn: 0, moneyOut: 5500, net: -5500, spent: 5500 },
    ])
    expect(t.categories).toEqual([
      { category: 'Groceries', total: 9000, monthly: [5000, 0, 4000], usual: 4000 },
      { category: 'Eating out', total: 1500, monthly: [0, 0, 1500], usual: 0 },
    ])
  })

  it('agrees with summarise for every month', () => {
    const rows = [
      tx('2026-08-01', 150000, 'Income'),
      tx('2026-08-05', -1099, 'Subscriptions'),
      tx('2026-08-20', 2500, 'Shopping'),
      tx('2026-08-21', -6000, 'Shopping'),
      tx('2026-09-01', -700),
    ]
    const t = spendingTrends(rows, { today: TODAY })
    for (const m of t.months) {
      const s = summarise(rows.filter((r) => r.date.startsWith(m.month)))
      expect(m).toMatchObject({ moneyIn: s.moneyIn, moneyOut: s.moneyOut, net: s.moneyIn - s.moneyOut })
    }
  })

  it('counts a refund as money in, not as less spending, as the totals do', () => {
    const t = spendingTrends([tx('2026-08-01', -6000, 'Shopping'), tx('2026-08-09', 6000, 'Shopping')], {
      today: TODAY,
    })
    expect(t.months[0]).toMatchObject({ moneyIn: 6000, moneyOut: 6000, net: 0, spent: 6000 })
    expect(t.categories).toEqual([{ category: 'Shopping', total: 6000, monthly: [6000], usual: 6000 }])
  })

  it('leaves transfers between your own accounts out of All accounts, but not out of one account', () => {
    const rows = pairOwnTransfers([
      tx('2026-08-13', -3000, undefined, { accountName: 'HSBC', description: 'Me Monzo BP' }),
      tx('2026-08-13', 3000, undefined, { description: 'Me · Monzo' }),
      tx('2026-08-14', -1200, 'Eating out'),
    ])
    const all = spendingTrends(rows, { excludeOwnTransfers: true, today: TODAY })
    expect(all.months).toEqual([
      { month: '2026-08', moneyIn: 0, moneyOut: 1200, net: -1200, spent: 1200, partial: 'start' },
    ])
    const hsbc = spendingTrends(
      rows.filter((r) => r.accountName === 'HSBC'),
      { today: TODAY },
    )
    expect(hsbc.months[0]).toMatchObject({ moneyOut: 3000, net: -3000 })
  })

  it('marks a first month that starts after the 1st and the month still going, and leaves both out of the usual', () => {
    const t = spendingTrends(
      [
        tx('2026-08-17', -100, 'Groceries'),
        tx('2026-09-04', -4000, 'Groceries'),
        tx('2026-10-04', -6000, 'Groceries'),
        tx('2026-11-02', -9000, 'Groceries'),
      ],
      { today: TODAY },
    )
    expect(t.months.map((m) => m.partial)).toEqual(['start', undefined, undefined, 'to-date'])
    expect(t.categories[0]!.usual).toBe(5000)
  })

  it('has no usual when the only month is partial', () => {
    const t = spendingTrends([tx('2026-11-10', -500, 'Groceries')], { today: TODAY })
    expect(t.months).toEqual([
      { month: '2026-11', moneyIn: 0, moneyOut: 500, net: -500, spent: 500, partial: 'to-date' },
    ])
    expect(t.categories[0]!.usual).toBeNull()
  })

  it('counts a single whole month as the usual', () => {
    const t = spendingTrends([tx('2026-05-01', -500, 'Groceries')], { today: TODAY })
    expect(t.months[0]!.partial).toBeUndefined()
    expect(t.categories[0]!.usual).toBe(500)
  })

  it('spans a long history without gaps', () => {
    const t = spendingTrends([tx('2021-01-01', -100, 'Fees'), tx('2026-10-31', -100, 'Fees')], {
      today: TODAY,
    })
    expect(t.months).toHaveLength(70)
    expect(t.months[12]!.month).toBe('2022-01')
    expect(t.categories[0]).toMatchObject({ total: 200, usual: 0 })
  })
})

describe('compareWithUsual', () => {
  const history = [
    tx('2026-06-01', -10000, 'Groceries'),
    tx('2026-07-01', -12000, 'Groceries'),
    tx('2026-07-10', -3000, 'Eating out'),
    tx('2026-08-01', -11000, 'Groceries'),
    tx('2026-08-12', -40000, 'Transfers'),
    tx('2026-09-01', -50000, 'Groceries'),
    tx('2026-09-02', 100000, 'Income'),
  ]

  it('sets a past month against the median of the months before it, biggest change first', () => {
    const c = compareWithUsual(history, '2026-09', { today: TODAY })!
    expect(c.month).toBe('2026-09')
    expect(c.throughDay).toBeNull()
    expect(c.baseline).toEqual(['2026-06', '2026-07', '2026-08'])
    expect(c.categories).toEqual([
      { category: 'Groceries', thisMonth: 50000, usual: 11000, difference: 39000 },
      // Eating out only in July: the usual month has none.
      { category: 'Eating out', thisMonth: 0, usual: 0, difference: 0 },
    ])
    // Transfers are never spending, and income isn't either.
    expect(c.total).toEqual({ category: 'All spending', thisMonth: 50000, usual: 11000, difference: 39000 })
  })

  it('counts a category you stopped spending on as less than usual', () => {
    const c = compareWithUsual(
      [
        tx('2026-06-03', -2000, 'Subscriptions'),
        tx('2026-07-03', -2000, 'Subscriptions'),
        tx('2026-08-03', -500, 'Groceries'),
      ],
      '2026-08',
      { today: TODAY },
    )!
    expect(c.categories[0]).toEqual({
      category: 'Subscriptions',
      thisMonth: 0,
      usual: 2000,
      difference: -2000,
    })
  })

  it('only looks back `lookback` months', () => {
    const c = compareWithUsual(history, '2026-09', { today: TODAY, lookback: 2 })!
    expect(c.baseline).toEqual(['2026-07', '2026-08'])
    expect(c.categories.find((r) => r.category === 'Groceries')!.usual).toBe(11500)
  })

  it('compares the month still going with the same days of earlier months', () => {
    const c = compareWithUsual(
      [
        tx('2026-09-01', -1000, 'Groceries'),
        tx('2026-09-25', -9000, 'Groceries'),
        tx('2026-10-05', -2000, 'Groceries'),
        tx('2026-10-28', -9000, 'Groceries'),
        tx('2026-11-03', -2500, 'Groceries'),
      ],
      '2026-11',
      { today: '2026-11-10' },
    )!
    expect(c.throughDay).toBe(10)
    expect(c.categories[0]).toEqual({ category: 'Groceries', thisMonth: 2500, usual: 1500, difference: 1000 })
  })

  it('counts the whole of a short month when today is past its end', () => {
    const c = compareWithUsual(
      [
        tx('2026-02-01', -400, 'Groceries'),
        tx('2026-02-28', -600, 'Groceries'),
        tx('2026-03-30', -1500, 'Groceries'),
      ],
      '2026-03',
      { today: '2026-03-31' },
    )!
    expect(c.categories[0]).toMatchObject({ thisMonth: 1500, usual: 1000 })
  })

  it('leaves a first month that starts after the 1st out of the usual', () => {
    const c = compareWithUsual(
      [
        tx('2026-07-28', -100, 'Groceries'),
        tx('2026-08-02', -5000, 'Groceries'),
        tx('2026-09-02', -6000, 'Groceries'),
      ],
      '2026-09',
      { today: TODAY },
    )!
    expect(c.baseline).toEqual(['2026-08'])
    expect(c.total.usual).toBe(5000)
  })

  it('is null with nothing to compare with', () => {
    expect(compareWithUsual([], '2026-11', { today: TODAY })).toBeNull()
    expect(compareWithUsual([tx('2026-11-02', -100, 'Fees')], '2026-11', { today: TODAY })).toBeNull()
    // The only earlier month is a partial first month.
    expect(
      compareWithUsual([tx('2026-10-20', -100, 'Fees'), tx('2026-11-02', -100, 'Fees')], '2026-11', {
        today: TODAY,
      }),
    ).toBeNull()
  })

  it('leaves own transfers out when asked, as summarise does', () => {
    const rows = pairOwnTransfers([
      tx('2026-08-01', -1000, 'Groceries'),
      tx('2026-09-13', -3000, undefined, { accountName: 'HSBC', description: 'Me Monzo BP' }),
      tx('2026-09-13', 3000, undefined, { description: 'Me · Monzo' }),
    ])
    const c = compareWithUsual(rows, '2026-09', { today: TODAY, excludeOwnTransfers: true })!
    expect(c.total).toMatchObject({ thisMonth: 0, usual: 1000, difference: -1000 })
  })
})
