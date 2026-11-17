import { describe, expect, it } from 'vitest'
import { summarise } from './summary'
import { pairOwnTransfers } from './transfers'
import type { Transaction } from './types'

let n = 0
const tx = (
  accountName: string,
  date: string,
  amount: number,
  description: string,
  extra: Partial<Transaction> = {},
): Transaction => ({
  id: `t${++n}`,
  accountName,
  date,
  amount,
  description,
  merchant: description,
  category: amount > 0 ? 'Income' : 'Other',
  ...extra,
})

describe('pairOwnTransfers', () => {
  it('pairs money out of one account with the same amount into the other when one side names it', () => {
    const out = tx('HSBC current', '2026-11-13', -3000, 'Test Person Monzo BP')
    const inn = tx('Monzo', '2026-11-13', 3000, 'TESTER A B · Monzo')
    const [a, b] = pairOwnTransfers([out, inn])
    expect(a).toMatchObject({ transferWith: inn.id, transferAccount: 'Monzo', category: 'Transfers' })
    expect(b).toMatchObject({ transferWith: out.id, transferAccount: 'HSBC current', category: 'Transfers' })
  })

  it('pairs two rows the banks already call transfers, within a few days', () => {
    const out = tx('Monzo', '2026-09-28', -42395, 'Test Person', { category: 'Transfers' })
    const inn = tx('HSBC', '2026-09-30', 42395, 'Test Person CR', { category: 'Transfers' })
    expect(pairOwnTransfers([out, inn]).every((t) => t.transferWith)).toBe(true)
  })

  it("doesn't pair a friend paying you the same amount you paid someone else", () => {
    const out = tx('HSBC', '2026-10-30', -3000, 'Pizza Place')
    const inn = tx('Monzo', '2026-10-30', 3000, 'Sam Example')
    expect(pairOwnTransfers([out, inn]).some((t) => t.transferWith)).toBe(false)
  })

  it('needs different accounts, equal amounts and dates close together', () => {
    const rows = [
      tx('Monzo', '2026-11-01', -3000, 'Monzo pot'),
      tx('Monzo', '2026-11-01', 3000, 'Monzo pot'),
      tx('HSBC', '2026-11-01', -2000, 'Me Monzo BP'),
      tx('Monzo', '2026-11-01', 2500, 'from HSBC'),
      tx('HSBC', '2026-11-01', -1000, 'Me Monzo BP'),
      tx('Monzo', '2026-11-09', 1000, 'from HSBC'),
    ]
    expect(pairOwnTransfers(rows).some((t) => t.transferWith)).toBe(false)
  })

  it('pairs each row once, with the closest date', () => {
    const out1 = tx('HSBC', '2026-10-02', -3000, 'Me Monzo BP')
    const out2 = tx('HSBC', '2026-10-04', -3000, 'Me Monzo BP')
    const inn1 = tx('Monzo', '2026-10-02', 3000, 'Me · Monzo')
    const inn2 = tx('Monzo', '2026-10-04', 3000, 'Me · Monzo')
    const r = pairOwnTransfers([out1, out2, inn1, inn2])
    expect(r.find((t) => t.id === out1.id)!.transferWith).toBe(inn1.id)
    expect(r.find((t) => t.id === out2.id)!.transferWith).toBe(inn2.id)
  })

  it('keeps a category you chose yourself', () => {
    const out = tx('HSBC', '2026-11-13', -3000, 'Me Monzo BP', { category: 'Bills', categorisedBy: 'you' })
    const inn = tx('Monzo', '2026-11-13', 3000, 'Me · Monzo')
    expect(pairOwnTransfers([out, inn])[0]).toMatchObject({ category: 'Bills', transferWith: inn.id })
  })

  it('leaves own transfers out of All accounts totals, but not out of one account', () => {
    const rows = pairOwnTransfers([
      tx('HSBC', '2026-11-13', -3000, 'Me Monzo BP'),
      tx('Monzo', '2026-11-13', 3000, 'Me · Monzo'),
      tx('Monzo', '2026-11-13', -1200, 'Pasta Place', { category: 'Eating out' }),
    ])
    expect(summarise(rows, { excludeOwnTransfers: true })).toMatchObject({ moneyIn: 0, moneyOut: 1200 })
    const hsbcOnly = rows.filter((t) => t.accountName === 'HSBC')
    expect(summarise(hsbcOnly)).toMatchObject({ moneyIn: 0, moneyOut: 3000 })
  })
})
