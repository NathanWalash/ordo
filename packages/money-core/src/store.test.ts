import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MoneyStore } from './store'
import { summarise } from './summary'
import type { Transaction } from './types'

let dir: string
let store: MoneyStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'money-store-'))
  store = new MoneyStore(join(dir, 'money.sqlite'))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const tx = (id: string, date: string, amount: number, extra: Partial<Transaction> = {}): Transaction => ({
  id,
  accountName: 'Monzo',
  date,
  description: id,
  amount,
  ...extra,
})

describe('MoneyStore', () => {
  it('imports transactions once, newest first', () => {
    expect(store.addTransactions([tx('a', '2026-11-01', -100), tx('b', '2026-11-03', 200)])).toEqual({
      added: 2,
      duplicates: 0,
    })
    expect(store.addTransactions([tx('a', '2026-11-01', -100), tx('c', '2026-10-01', -5)])).toEqual({
      added: 1,
      duplicates: 1,
    })
    expect(store.transactions().map((t) => t.id)).toEqual(['b', 'a', 'c'])
    expect(store.accounts()).toEqual(['Monzo'])
  })

  it('keeps optional fields optional', () => {
    store.addTransactions([tx('a', '2026-11-01', -100, { merchant: 'Netflix', category: 'Subscriptions' })])
    store.addTransactions([tx('b', '2026-11-02', -100)])
    const [b, a] = store.transactions()
    expect(a).toEqual(tx('a', '2026-11-01', -100, { merchant: 'Netflix', category: 'Subscriptions' }))
    expect(b).toEqual(tx('b', '2026-11-02', -100))
  })

  it('always has Me, and keeps people in the order added', () => {
    expect(store.people()).toEqual([{ id: 'me', name: 'Me' }])
    const sam = store.savePerson({ name: 'Sam' })
    store.savePerson({ name: 'Alex' })
    store.savePerson({ id: sam.id, name: 'Samantha' })
    expect(store.people().map((p) => p.name)).toEqual(['Me', 'Samantha', 'Alex'])
    expect(() => store.deletePerson('me')).toThrow()
    store.deletePerson(sam.id)
    expect(store.people().map((p) => p.name)).toEqual(['Me', 'Alex'])
  })

  it('saves bills, splits and settlements, and deleting a bill drops its split', () => {
    const bill = store.saveBill({
      name: 'Netflix',
      amount: 1099,
      cadence: 'monthly',
      anchorDate: '2026-12-03',
      source: 'bank',
      status: 'active',
      merchantKey: 'netflix',
    })
    expect(store.bills()).toEqual([bill])
    store.saveBill({ ...bill, status: 'cancelled', cancelledOn: '2026-11-20' })
    expect(store.bill(bill.id)).toMatchObject({ status: 'cancelled', cancelledOn: '2026-11-20' })

    const split = {
      billId: bill.id,
      paidBy: 'me',
      mode: 'equal' as const,
      shares: [
        { personId: 'me', value: 0 },
        { personId: 'sam', value: 0 },
      ],
      since: '2026-11-03',
    }
    store.saveSplit(split)
    expect(store.splits()).toEqual([split])

    const s = store.addSettlement({ from: 'sam', to: 'me', amount: 549, date: '2026-11-17' })
    expect(store.settlements()).toEqual([s])
    store.deleteSettlement(s.id)
    expect(store.settlements()).toEqual([])

    store.deleteBill(bill.id)
    expect(store.bills()).toEqual([])
    expect(store.splits()).toEqual([])
  })

  it('remembers dismissed suggestions and can forget everything', () => {
    store.dismiss('spotify')
    store.dismiss('spotify')
    expect([...store.dismissed()]).toEqual(['spotify'])
    store.addTransactions([tx('a', '2026-11-01', -100)])
    store.savePerson({ name: 'Sam' })
    store.clear()
    expect(store.transactions()).toEqual([])
    expect(store.dismissed().size).toBe(0)
    expect(store.people()).toEqual([{ id: 'me', name: 'Me' }])
  })

  it('removes one account', () => {
    store.addTransactions([
      tx('a', '2026-11-01', -100),
      { ...tx('b', '2026-11-01', -100), accountName: 'Joint' },
    ])
    store.removeAccount('Monzo')
    expect(store.accounts()).toEqual(['Joint'])
  })
})

describe('summarise', () => {
  it('totals money in and out, by month and by category, leaving transfers out of spending', () => {
    const s = summarise([
      tx('a', '2026-11-01', -1099, { category: 'Subscriptions' }),
      tx('b', '2026-11-02', -4217, { category: 'Groceries' }),
      tx('c', '2026-10-28', 245000, { category: 'Income' }),
      tx('d', '2026-10-30', -10000, { category: 'Transfers' }),
      tx('e', '2026-10-30', -500),
    ])
    expect(s.moneyIn).toBe(245000)
    expect(s.moneyOut).toBe(1099 + 4217 + 10000 + 500)
    expect(s.byCategory).toEqual([
      { category: 'Groceries', amount: 4217 },
      { category: 'Subscriptions', amount: 1099 },
      { category: 'Other', amount: 500 },
    ])
    expect(s.byMonth).toEqual([
      { month: '2026-11', moneyIn: 0, moneyOut: 5316 },
      { month: '2026-10', moneyIn: 245000, moneyOut: 10500 },
    ])
  })
})
