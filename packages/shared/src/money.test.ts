import { describe, expect, it } from 'vitest'
import { IPC, MODULES } from './index'
import {
  BillInputSchema,
  MONEY_IPC,
  PersonInputSchema,
  SetCategorySchema,
  SettleInputSchema,
  SplitInputSchema,
} from './money'

describe('Money IPC contract', () => {
  it('uses unique channel names that do not clash with the rest of the app', () => {
    const money = Object.values(MONEY_IPC)
    expect(new Set(money).size).toBe(money.length)
    const others = new Set<string>(Object.values(IPC))
    expect(money.filter((c) => others.has(c))).toEqual([])
  })

  it('only accepts a category from the list, or null to undo', () => {
    expect(SetCategorySchema.parse({ transactionId: 'abc', category: 'Groceries' })).toEqual({
      transactionId: 'abc',
      category: 'Groceries',
    })
    expect(SetCategorySchema.parse({ transactionId: 'abc', category: null }).category).toBeNull()
    expect(SetCategorySchema.safeParse({ transactionId: 'abc', category: 'Gambling' }).success).toBe(false)
    expect(SetCategorySchema.safeParse({ transactionId: '', category: 'Other' }).success).toBe(false)
  })

  it('registers Money as a live module', () => {
    expect(MODULES.find((m) => m.id === 'money')).toEqual({ id: 'money', name: 'Money' })
  })

  it('validates bills', () => {
    expect(
      BillInputSchema.parse({ name: ' Rent ', amount: 145000, cadence: 'monthly', nextDue: '2026-12-01' }),
    ).toEqual({ name: 'Rent', amount: 145000, cadence: 'monthly', nextDue: '2026-12-01' })
    expect(
      BillInputSchema.safeParse({ name: '', amount: 1, cadence: 'monthly', nextDue: '2026-12-01' }).success,
    ).toBe(false)
    expect(
      BillInputSchema.safeParse({ name: 'x', amount: 1.5, cadence: 'monthly', nextDue: '2026-12-01' })
        .success,
    ).toBe(false)
    expect(
      BillInputSchema.safeParse({ name: 'x', amount: 1, cadence: 'daily', nextDue: '2026-12-01' }).success,
    ).toBe(false)
    expect(
      BillInputSchema.safeParse({ name: 'x', amount: 1, cadence: 'monthly', nextDue: '2026-02-30' }).success,
    ).toBe(false)
  })

  it('validates people, splits and settlements', () => {
    expect(PersonInputSchema.safeParse({ name: '  ' }).success).toBe(false)
    expect(
      SplitInputSchema.safeParse({
        billId: 'b',
        paidBy: 'me',
        mode: 'fixed',
        shares: [{ personId: 'me', value: -1 }],
      }).success,
    ).toBe(false)
    expect(SettleInputSchema.safeParse({ from: 'sam', to: 'me', amount: 0 }).success).toBe(false)
    expect(SettleInputSchema.safeParse({ from: 'sam', to: 'me', amount: 4210 }).success).toBe(true)
  })
})
