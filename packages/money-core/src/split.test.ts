import { describe, expect, it } from 'vitest'
import {
  WHOLE,
  allocate,
  balances,
  billCharges,
  netBalances,
  simplifyDebts,
  splitStartDate,
  validateSplit,
} from './split'
import type { Charge, Person, Settlement, Split, StoredBill, Transaction } from './types'

const people: Person[] = [
  { id: 'me', name: 'Me' },
  { id: 'sam', name: 'Sam' },
  { id: 'alex', name: 'Alex' },
  { id: 'jo', name: 'Jo' },
]

const equal = (paidBy: string, ...ids: string[]) => ({
  mode: 'equal' as const,
  paidBy,
  shares: ids.map((personId) => ({ personId, value: 0 })),
})

const sum = (xs: { amount: number }[]) => xs.reduce((n, x) => n + x.amount, 0)
const asMap = (xs: { personId: string; amount: number }[]) =>
  Object.fromEntries(xs.map((x) => [x.personId, x.amount]))

describe('allocate', () => {
  it('splits evenly when it divides', () => {
    expect(asMap(allocate(3000, equal('me', 'me', 'sam', 'alex')))).toEqual({
      me: 1000,
      sam: 1000,
      alex: 1000,
    })
  })

  it('gives remainder pennies to the payer first, then by id', () => {
    // £10.00 / 3 = 333.33…: one spare penny, kept by the payer.
    expect(asMap(allocate(1000, equal('sam', 'me', 'sam', 'alex')))).toEqual({ me: 333, sam: 334, alex: 333 })
    // £10.01 / 3: two spare pennies, payer then the lowest id ('alex' < 'me').
    expect(asMap(allocate(1001, equal('sam', 'me', 'sam', 'alex')))).toEqual({ me: 333, sam: 334, alex: 334 })
    // Payer not sharing: spare pennies go by id.
    expect(asMap(allocate(1001, equal('jo', 'me', 'sam', 'alex')))).toEqual({ alex: 334, me: 334, sam: 333 })
  })

  it('does not depend on the order shares are listed in', () => {
    const a = allocate(1099, equal('me', 'me', 'sam', 'alex', 'jo'))
    const b = allocate(1099, equal('me', 'jo', 'alex', 'sam', 'me'))
    expect(asMap(a)).toEqual(asMap(b))
  })

  it('always adds up to the total', () => {
    for (let total = 0; total <= 2000; total += 7)
      for (let n = 1; n <= 4; n++) {
        const ids = people.slice(0, n).map((p) => p.id)
        const shares = allocate(total, equal('sam', ...ids))
        expect(sum(shares)).toBe(total)
        const amounts = shares.map((s) => s.amount)
        expect(Math.max(...amounts) - Math.min(...amounts)).toBeLessThanOrEqual(1)
      }
  })

  it('uses fixed amounts as given when they match the total', () => {
    const split = {
      mode: 'fixed' as const,
      paidBy: 'me',
      shares: [
        { personId: 'me', value: 80000 },
        { personId: 'sam', value: 65000 },
      ],
    }
    expect(asMap(allocate(145000, split))).toEqual({ me: 80000, sam: 65000 })
  })

  it('scales fixed amounts when the bill changes, still adding up', () => {
    const split = {
      mode: 'fixed' as const,
      paidBy: 'me',
      shares: [
        { personId: 'me', value: 600 },
        { personId: 'sam', value: 499 },
      ],
    }
    const shares = allocate(1299, split)
    expect(sum(shares)).toBe(1299)
    expect(asMap(shares)).toEqual({ me: 709, sam: 590 })
  })

  it('splits by percentage with the largest remainders getting the spare pennies', () => {
    const split = {
      mode: 'percent' as const,
      paidBy: 'me',
      shares: [
        { personId: 'me', value: 5000 },
        { personId: 'sam', value: 3000 },
        { personId: 'alex', value: 2000 },
      ],
    }
    // 4999.5 / 2999.7 / 1999.8: the two spare pennies go to the largest fractions.
    expect(asMap(allocate(9999, split))).toEqual({ me: 4999, sam: 3000, alex: 2000 })
    // 33.33% each of £1.00 leaves 1p; ties go to the payer first.
    const thirds = {
      mode: 'percent' as const,
      paidBy: 'sam',
      shares: [
        { personId: 'me', value: 3333 },
        { personId: 'sam', value: 3334 },
        { personId: 'alex', value: 3333 },
      ],
    }
    expect(asMap(allocate(100, thirds))).toEqual({ me: 33, sam: 34, alex: 33 })
  })

  it('handles zero and rejects fractions of a penny', () => {
    expect(allocate(0, equal('me', 'me', 'sam')).map((s) => s.amount)).toEqual([0, 0])
    expect(() => allocate(10.5, equal('me', 'me'))).toThrow()
    expect(() => allocate(-100, equal('me', 'me'))).toThrow()
    expect(allocate(100, equal('me'))).toEqual([])
  })
})

describe('validateSplit', () => {
  it('accepts a good equal split', () => {
    expect(validateSplit(equal('me', 'me', 'sam'), 1099, people)).toBeNull()
  })

  it('needs a known payer and at least one sharer, each once', () => {
    expect(validateSplit(equal('ghost', 'me'), 100, people)).toMatch(/who pays/)
    expect(validateSplit(equal('me'), 100, people)).toMatch(/at least one/)
    expect(validateSplit(equal('me', 'sam', 'sam'), 100, people)).toMatch(/only appear once/)
    expect(validateSplit(equal('me', 'me', 'ghost'), 100, people)).toMatch(/no longer exists/)
  })

  it('checks fixed amounts add up to the bill', () => {
    const fixed = (a: number, b: number) => ({
      mode: 'fixed' as const,
      paidBy: 'me',
      shares: [
        { personId: 'me', value: a },
        { personId: 'sam', value: b },
      ],
    })
    expect(validateSplit(fixed(600, 499), 1099, people)).toBeNull()
    expect(validateSplit(fixed(600, 400), 1099, people)).toBe(
      'Shares add up to £10.00, but the bill is £10.99.',
    )
    expect(validateSplit(fixed(600, -1), 599, people)).toMatch(/whole pence/)
    expect(validateSplit(fixed(600.5, 498.5), 1099, people)).toMatch(/whole pence/)
  })

  it('checks percentages add up to 100%', () => {
    const pct = (a: number, b: number) => ({
      mode: 'percent' as const,
      paidBy: 'me',
      shares: [
        { personId: 'me', value: a },
        { personId: 'sam', value: b },
      ],
    })
    expect(validateSplit(pct(6000, 4000), 1099, people)).toBeNull()
    expect(validateSplit(pct(6000, 3950), 1099, people)).toBe('Percentages add up to 99.5%, not 100%.')
    expect(WHOLE).toBe(10000)
  })
})

describe('balances', () => {
  const charge = (paidBy: string, shares: Record<string, number>): Charge => ({
    billId: 'b',
    date: '2026-11-01',
    amount: Object.values(shares).reduce((a, b) => a + b, 0),
    paidBy,
    shares: Object.entries(shares).map(([personId, amount]) => ({ personId, amount })),
  })
  const settle = (from: string, to: string, amount: number): Settlement => ({
    id: `${from}-${to}`,
    from,
    to,
    amount,
    date: '2026-11-10',
  })

  it('credits the payer with everyone else’s share', () => {
    const net = netBalances([charge('me', { me: 550, sam: 549 })], [])
    expect(Object.fromEntries(net)).toEqual({ me: 549, sam: -549 })
  })

  it('nets out across bills and always sums to zero', () => {
    const net = netBalances(
      [
        charge('me', { me: 48334, sam: 48333, alex: 48333 }), // rent
        charge('sam', { me: 3400, sam: 3300, alex: 3300 }), // energy
        charge('alex', { me: 550, alex: 549 }), // netflix
      ],
      [],
    )
    expect(Object.fromEntries(net)).toEqual({
      me: 48333 + 48333 - 3400 - 550,
      sam: 3400 + 3300 - 48333,
      alex: 550 - 48333 - 3300,
    })
    expect([...net.values()].reduce((a, b) => a + b, 0)).toBe(0)
  })

  it('settlements reduce what is owed', () => {
    const net = netBalances([charge('me', { me: 550, sam: 549 })], [settle('sam', 'me', 549)])
    expect(simplifyDebts(net)).toEqual([])
    const part = netBalances([charge('me', { me: 550, sam: 549 })], [settle('sam', 'me', 500)])
    expect(simplifyDebts(part)).toEqual([{ from: 'sam', to: 'me', amount: 49 }])
  })

  it('simplifies a chain of debts to the fewest payments', () => {
    // Sam owes Me £10, Me owes Alex £10: Sam should just pay Alex.
    const net = netBalances([charge('me', { sam: 1000 }), charge('alex', { me: 1000 })], [])
    expect(simplifyDebts(net)).toEqual([{ from: 'sam', to: 'alex', amount: 1000 }])
  })

  it('simplifies a three-way loop to nothing', () => {
    const net = netBalances(
      [charge('me', { sam: 500 }), charge('sam', { alex: 500 }), charge('alex', { me: 500 })],
      [],
    )
    expect(simplifyDebts(net)).toEqual([])
  })

  it('needs at most one fewer payment than people, biggest first, ties by id', () => {
    const net = new Map([
      ['me', 3000],
      ['jo', 1000],
      ['sam', -2000],
      ['alex', -2000],
    ])
    expect(simplifyDebts(net)).toEqual([
      { from: 'alex', to: 'me', amount: 2000 },
      { from: 'sam', to: 'jo', amount: 1000 },
      { from: 'sam', to: 'me', amount: 1000 },
    ])
  })
})

describe('charges from bills', () => {
  const bankBill: StoredBill = {
    id: 'netflix',
    name: 'Netflix',
    amount: 1099,
    cadence: 'monthly',
    anchorDate: '2026-12-03',
    source: 'bank',
    status: 'active',
    merchantKey: 'netflix',
  }
  const manualBill: StoredBill = {
    id: 'rent',
    name: 'Rent',
    amount: 145000,
    cadence: 'monthly',
    anchorDate: '2026-09-01',
    source: 'manual',
    status: 'active',
  }
  const tx = (date: string, amount: number, merchant = 'Netflix'): Transaction => ({
    id: `${merchant}-${date}`,
    accountName: 'Monzo',
    date,
    description: merchant,
    amount,
    merchant,
  })
  const payments = [
    tx('2026-09-03', -1099),
    tx('2026-10-03', -1099),
    tx('2026-11-03', -1299),
    tx('2026-11-05', -2349, 'Tesco'),
    tx('2026-11-06', -5, 'Netflix'), // card check, not the bill
  ]
  const split = (billId: string, since: string): Split => ({ billId, since, ...equal('me', 'me', 'sam') })

  it('starts a bank bill at its latest payment, a manual one at its latest due date', () => {
    expect(splitStartDate(bankBill, payments, '2026-11-17')).toBe('2026-11-03')
    expect(splitStartDate(manualBill, [], '2026-11-17')).toBe('2026-11-01')
    expect(splitStartDate({ ...manualBill, anchorDate: '2026-12-01' }, [], '2026-11-17')).toBe('2026-12-01')
  })

  it('charges each bank payment since the split started, at what was actually paid', () => {
    const charges = billCharges(bankBill, split('netflix', '2026-10-01'), payments, '2026-11-17')
    expect(charges.map((c) => [c.date, c.amount, c.transactionId])).toEqual([
      ['2026-10-03', 1099, 'Netflix-2026-10-03'],
      ['2026-11-03', 1299, 'Netflix-2026-11-03'],
    ])
    expect(asMap(charges[1]!.shares)).toEqual({ me: 650, sam: 649 })
  })

  it('charges each due date for bills without bank payments, up to today', () => {
    const charges = billCharges(manualBill, split('rent', '2026-10-01'), [], '2026-11-17')
    expect(charges.map((c) => c.date)).toEqual(['2026-10-01', '2026-11-01'])
    expect(charges.every((c) => c.amount === 145000)).toBe(true)
  })

  it('stops charging once a bill is cancelled', () => {
    const cancelled = { ...manualBill, status: 'cancelled' as const, cancelledOn: '2026-10-15' }
    expect(billCharges(cancelled, split('rent', '2026-09-01'), [], '2026-11-17').map((c) => c.date)).toEqual([
      '2026-09-01',
      '2026-10-01',
    ])
  })

  it('adds everything up into who owes whom', () => {
    const r = balances({
      bills: [bankBill, manualBill],
      splits: [split('netflix', '2026-11-03'), { ...split('rent', '2026-11-01'), paidBy: 'sam' }],
      transactions: payments,
      settlements: [],
      today: '2026-11-17',
    })
    // Netflix: Sam owes me 649. Rent: I owe Sam 72500. Net: I owe Sam 71851.
    expect(r.debts).toEqual([{ from: 'me', to: 'sam', amount: 72500 - 649 }])
    expect(r.charges).toHaveLength(2)
  })

  it('ignores splits for bills that no longer exist', () => {
    const r = balances({
      bills: [],
      splits: [split('gone', '2026-01-01')],
      transactions: [],
      settlements: [],
    })
    expect(r.debts).toEqual([])
  })
})
