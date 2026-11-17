import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { addDays, addMonths } from './dates'
import { detectRecurring } from './recurring'
import { parseStatement } from './statement'
import type { Transaction } from './types'

let n = 0
const tx = (date: string, amount: number, merchant: string): Transaction => ({
  id: `t${n++}`,
  accountName: 'Test',
  date,
  description: merchant.toUpperCase(),
  amount,
  merchant,
})

const monthly = (merchant: string, amount: number, from: string, count: number) =>
  Array.from({ length: count }, (_, i) => tx(addMonths(from, i), amount, merchant))

describe('detectRecurring', () => {
  it('finds a monthly subscription and predicts the next payment', () => {
    const [c, ...rest] = detectRecurring(monthly('Netflix', -1099, '2026-07-03', 5), '2026-11-17')
    expect(rest).toHaveLength(0)
    expect(c).toMatchObject({
      id: 'netflix',
      merchant: 'Netflix',
      key: 'netflix',
      cadence: 'monthly',
      typicalAmount: 1099,
      lastDate: '2026-11-03',
      nextDue: '2026-12-03',
    })
    expect(c!.transactionIds).toHaveLength(5)
    expect(c!.confidence).toBe(1)
  })

  it('rolls the next due date past today when payments are old', () => {
    const [c] = detectRecurring(monthly('Netflix', -1099, '2026-01-03', 3), '2026-11-17')
    expect(c!.lastDate).toBe('2026-03-03')
    expect(c!.nextDue).toBe('2026-12-03')
  })

  it('finds weekly and yearly rhythms', () => {
    const weekly = Array.from({ length: 6 }, (_, i) => tx(addDays('2026-10-02', 7 * i), -500, 'Veg Box'))
    const yearly = [tx('2024-03-10', -15950, 'TV Licence'), tx('2025-03-10', -16950, 'TV Licence')]
    const found = detectRecurring([...weekly, ...yearly], '2026-11-17')
    expect(found.find((c) => c.merchant === 'Veg Box')).toMatchObject({
      cadence: 'weekly',
      nextDue: '2026-11-20',
    })
    expect(found.find((c) => c.merchant === 'TV Licence')).toMatchObject({
      cadence: 'yearly',
      nextDue: '2027-03-10',
      priceIncrease: { from: 15950, to: 16950, date: '2025-03-10' },
    })
  })

  it('tolerates a few days of drift and a skipped month', () => {
    const dates = ['2026-05-01', '2026-06-03', '2026-06-30', '2026-08-31', '2026-10-02']
    const [c] = detectRecurring(
      dates.map((d) => tx(d, -3800, 'Thames Water')),
      '2026-10-10',
    )
    expect(c).toMatchObject({ cadence: 'monthly' })
    expect(c!.confidence).toBeGreaterThan(0.8)
  })

  it('flags a price rise and reports the new price', () => {
    const txs = [...monthly('Spotify', -1199, '2026-08-12', 2), ...monthly('Spotify', -1299, '2026-10-12', 2)]
    const [c] = detectRecurring(txs, '2026-11-17')
    expect(c).toMatchObject({
      typicalAmount: 1299,
      priceIncrease: { from: 1199, to: 1299, date: '2026-10-12' },
    })
    expect(c!.transactionIds).toHaveLength(4)
  })

  it('keeps two subscriptions from one merchant apart', () => {
    const txs = [...monthly('Apple', -299, '2026-07-05', 4), ...monthly('Apple', -999, '2026-07-20', 4)]
    const found = detectRecurring(txs, '2026-11-17')
    expect(found.map((c) => [c.id, c.typicalAmount]).sort()).toEqual([
      ['apple~299', 299],
      ['apple~999', 999],
    ])
  })

  it('ignores irregular spending, income and one-offs', () => {
    const txs = [
      tx('2026-08-09', -4217, 'Tesco'),
      tx('2026-08-21', -1862, 'Tesco'),
      tx('2026-10-18', -5504, 'Tesco'),
      tx('2026-09-19', -2349, 'Amazon'),
      ...monthly('Acme Ltd', 245000, '2026-07-28', 4),
    ]
    expect(detectRecurring(txs, '2026-11-17')).toEqual([])
  })

  it('needs at least three weekly payments', () => {
    expect(
      detectRecurring([tx('2026-11-01', -500, 'Box'), tx('2026-11-08', -500, 'Box')], '2026-11-17'),
    ).toEqual([])
  })

  it('counts several payments on one day once', () => {
    const txs = [...monthly('Gym', -2499, '2026-08-06', 3), tx('2026-10-06', -2499, 'Gym')]
    const [c] = detectRecurring(txs, '2026-11-17')
    expect(c!.transactionIds).toHaveLength(3)
  })

  it('finds the subscriptions in a real-looking statement', () => {
    const text = readFileSync(new URL('./fixtures/monzo.csv', import.meta.url), 'utf8')
    const r = parseStatement(text, { accountName: 'Monzo' })
    if (!r.ok) throw new Error(r.message)
    const found = detectRecurring(r.transactions, '2026-11-17')
    expect(found.map((c) => c.merchant).sort()).toEqual(['Netflix', 'Spotify', 'Thames Water'])
  })
})
