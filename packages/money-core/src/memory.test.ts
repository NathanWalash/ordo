import { describe, expect, it } from 'vitest'
import { accountCaveats, periodCaveats } from './caveats'
import { compareMonthToDate, spendBetween } from './compare'
import { describeFacts } from './describe'
import { allEventCosts, eventCost } from './events'
import {
  ALL_FACTS,
  AMELIE_PAYBACK,
  GABE_FOR_PATRICK,
  GENEST_PAYBACK,
  HALLOWEEN,
  IGNORE_PARTY,
  ITALY,
  LUCA_PAYBACK,
  SALARY,
  TICKET,
  TICKET_PASS,
  TODAY,
  TRANSACTIONS,
  fact,
} from './fixtures/money-memory'
import { buildLedger, totals } from './ledger'
import { counterparts, heldBalances, owedToYou, regularRuns } from './loose-ends'
import { MoneyFactInputSchema, involves, type MoneyFact } from './memory'
import { heldSettlements, withMemoryBills } from './memory-bills'
import { balances } from './split'
import { candidateKey, findMatches, shareAfterPaybacks } from './paybacks'
import { proposeQuestions } from './questions'
import type { DetectedBill, Transaction } from './types'

const byId = new Map(TRANSACTIONS.map((t) => [t.id, t]))
const ledgerWith = (facts: MoneyFact[]) => buildLedger(TRANSACTIONS, facts)

describe('fact schema', () => {
  it('accepts each kind and fills defaults', () => {
    const e = MoneyFactInputSchema.parse({
      kind: 'event',
      name: ' Italy ',
      from: '2026-08-28',
      to: '2026-09-04',
    })
    expect(e).toEqual({
      kind: 'event',
      name: 'Italy',
      from: '2026-08-28',
      to: '2026-09-04',
      include: [],
      exclude: [],
      excludeMerchants: [],
    })
    expect(MoneyFactInputSchema.parse({ kind: 'held', from: 'Gabe', forPerson: 'Patrick' })).toMatchObject({
      what: '',
    })
  })

  it('rejects events with no dates and no payments, or dates the wrong way round', () => {
    expect(MoneyFactInputSchema.safeParse({ kind: 'event', name: 'Nothing' }).success).toBe(false)
    expect(
      MoneyFactInputSchema.safeParse({ kind: 'event', name: 'Back', from: '2026-09-04', to: '2026-08-28' })
        .success,
    ).toBe(false)
  })

  it('rejects a payback that pays back nothing, unknown kinds and extra fields', () => {
    expect(MoneyFactInputSchema.safeParse({ kind: 'payback', inId: 'x' }).success).toBe(false)
    expect(MoneyFactInputSchema.safeParse({ kind: 'magic', text: 'x' }).success).toBe(false)
    expect(MoneyFactInputSchema.safeParse({ kind: 'note', text: 'hi', extra: 1 }).success).toBe(false)
    expect(
      MoneyFactInputSchema.safeParse({ kind: 'owed', person: 'A', amount: 0, date: '2026-11-01' }).success,
    ).toBe(false)
    expect(
      MoneyFactInputSchema.safeParse({ kind: 'owed', person: 'A', amount: 1.5, date: '2026-11-01' }).success,
    ).toBe(false)
  })
})

describe('involves', () => {
  const t = byId.get('m-gabe-sep')!
  it('matches a first name, the full name or every word in the description', () => {
    expect(involves(t, 'Gabe')).toBe(true)
    expect(involves(t, 'Gabe S')).toBe(true)
    expect(involves(t, 'gabe rent')).toBe(true)
    expect(involves(t, 'Patrick')).toBe(false)
    // Too short to be sure.
    expect(involves(t, 'Ga')).toBe(false)
  })
  it('uses aliases', () => {
    expect(involves(t, 'Gabriel', ['Gabe S'])).toBe(true)
  })
})

describe('ledger', () => {
  it('without facts: outgoings are spending, money in is income, own transfers are neither', () => {
    const l = ledgerWith([])
    expect(l.get('h-ryanair')).toMatchObject({ role: 'spend', spend: 29777 })
    expect(l.get('m-gabe-sep')).toMatchObject({ role: 'income', income: 29850 })
    expect(l.get('h-to-monzo')).toMatchObject({ role: 'own-transfer', spend: 0 })
    expect(l.get('m-from-hsbc')).toMatchObject({ role: 'own-transfer', income: 0 })
  })

  it('money held for someone is not income, and passing it on is not spending', () => {
    const l = ledgerWith([GABE_FOR_PATRICK])
    expect(l.get('m-gabe-sep')).toMatchObject({ role: 'held-in', income: 0, factId: 'held-gabe' })
    // £597 to Patrick: £298.50 was Gabe's, the other £298.50 is the person's own rent.
    expect(l.get('m-patrick-sep')).toMatchObject({ role: 'held-out', spend: 29850 })
    expect(l.get('m-gabe-nov')).toMatchObject({ role: 'held-in' })
  })

  it('a payment out before any held money came in is all spending', () => {
    const early = fact({ kind: 'held', from: 'Gabe S', forPerson: 'Patrick O', since: '2026-10-01' })
    const l = ledgerWith([early])
    expect(l.get('m-patrick-sep')).toMatchObject({ role: 'spend', spend: 59700 })
    expect(l.get('m-gabe-sep')).toMatchObject({ role: 'income' })
    expect(l.get('m-patrick-oct')).toMatchObject({ role: 'held-out', spend: 29850 })
  })

  it('ignored, pass-through and payback facts', () => {
    const l = ledgerWith([IGNORE_PARTY, TICKET_PASS, GENEST_PAYBACK])
    expect(l.get('m-party-3')).toMatchObject({ role: 'ignored', spend: 0 })
    expect(l.get('m-bennie')).toMatchObject({ role: 'pass-through', income: 0 })
    expect(l.get('m-seller')).toMatchObject({ role: 'pass-through', spend: 0 })
    expect(l.get('m-genest')).toMatchObject({ role: 'payback', income: 0, reimbursed: 3000 })
  })

  it('ignore wins over everything else', () => {
    const l = ledgerWith([
      fact({ kind: 'ignore', transactionIds: ['h-to-monzo', 'm-genest'] }),
      GENEST_PAYBACK,
    ])
    expect(l.get('h-to-monzo')?.role).toBe('ignored')
    expect(l.get('m-genest')?.role).toBe('ignored')
  })

  it('totals add up spending, income and paybacks', () => {
    const l = ledgerWith([GENEST_PAYBACK])
    const halloween = ['m-halloween-1', 'h-halloween-2', 'm-genest'].map((id) => byId.get(id)!)
    expect(totals(halloween, l)).toEqual({ spend: 6000, income: 0, reimbursed: 3000 })
  })
})

describe('event net cost', () => {
  it('Halloween: £60 out across both banks, Genest paid £30 back, £30 net', () => {
    const facts = [HALLOWEEN, GENEST_PAYBACK]
    const e = eventCost(HALLOWEEN as never, TRANSACTIONS, ledgerWith(facts), facts)
    expect(e).toMatchObject({ paidOut: 6000, paidBack: 3000, net: 3000 })
    expect(e.byAccount).toEqual([
      { account: 'Monzo', amount: 3500 },
      { account: 'HSBC', amount: 2500 },
    ])
    expect(e.paybacks).toEqual([
      expect.objectContaining({ id: 'm-genest', amount: 3000, person: 'Genest J' }),
    ])
  })

  it('a resold ticket where the money went straight out again nets to £0', () => {
    const facts = [TICKET, TICKET_PASS]
    const e = eventCost(TICKET as never, TRANSACTIONS, ledgerWith(facts), facts)
    expect(e).toMatchObject({ paidOut: 5000, paidBack: 5000, net: 0 })
  })

  it('Italy: £423.99 excluding flights, by type, minus Luca’s £5', () => {
    const facts = [ITALY, LUCA_PAYBACK]
    const e = eventCost(ITALY as never, TRANSACTIONS, ledgerWith(facts), facts)
    expect(e.paidOut).toBe(42399)
    expect(e.paidBack).toBe(500)
    expect(e.net).toBe(41899)
    expect(e.excluded).toBe(1)
    expect(e.byCategory).toEqual([
      { category: 'Other', amount: 25000 },
      { category: 'Eating out', amount: 13149 },
      { category: 'Transport', amount: 4250 },
    ])
    expect(e.outgoings.map((o) => o.id)).not.toContain('m-italy-ryanair')
  })

  it('leaves out own transfers, ignored payments and payments you excluded', () => {
    const trip = fact({
      id: 'ev-nov',
      kind: 'event',
      name: 'Early November',
      from: '2026-11-01',
      to: '2026-11-05',
      exclude: ['h-sains-nov'],
    })
    const e = eventCost(trip as never, TRANSACTIONS, ledgerWith([trip]), [trip])
    expect(e.outgoings).toEqual([])
    expect(e.excluded).toBe(1)
  })

  it('a payback for several outgoings counts only the part for the event’s outgoings', () => {
    const one = fact({ id: 'ev-one', kind: 'event', name: 'Shop', include: ['m-halloween-1'] })
    const p = fact({ kind: 'payback', inId: 'm-genest', outIds: ['m-halloween-1', 'h-halloween-2'] })
    const e = eventCost(one as never, TRANSACTIONS, ledgerWith([one, p]), [one, p])
    // £30 back for £35 + £25: £17.50 of it was for the £35.
    expect(e).toMatchObject({ paidOut: 3500, paidBack: 1750, net: 1750 })
  })

  it('lists every event, newest first', () => {
    const list = allEventCosts(TRANSACTIONS, ledgerWith(ALL_FACTS), ALL_FACTS)
    expect(list.map((e) => e.name)).toEqual(['Halloween', 'Concert ticket', 'Italy'])
  })
})

describe('payback and pass-through matching', () => {
  const matches = (facts: MoneyFact[] = [SALARY], rejected?: Set<string>) =>
    findMatches(TRANSACTIONS, ledgerWith(facts), facts, { rejected })
  const forIn = (id: string, facts?: MoneyFact[], rejected?: Set<string>) =>
    matches(facts, rejected).find((m) => m.inId === id)

  it('a ticket resale: same amount straight back out the same day is an exact pass-through', () => {
    expect(forIn('m-bennie')).toMatchObject({
      kind: 'pass-through',
      outIds: ['m-seller'],
      confidence: 'exact',
      days: 0,
    })
  })

  it('Genest’s £30 via Splitwise is exactly half of the two Halloween payments', () => {
    expect(forIn('m-genest')).toMatchObject({
      kind: 'payback',
      outIds: ['m-halloween-1', 'h-halloween-2'],
      parts: 2,
    })
    expect(forIn('m-genest')!.reason).toMatch(/^half of 2 payments totalling £60\.00, 2 days later$/)
  })

  it('Amelie’s £148.80 is about half of Ryanair’s £297.77: likely, not exact', () => {
    expect(forIn('m-amelie')).toMatchObject({
      kind: 'payback',
      outIds: ['h-ryanair'],
      parts: 2,
      confidence: 'likely',
    })
  })

  it('salary is never a payback', () => {
    expect(forIn('h-salary-sep', [])).toBeUndefined()
    expect(forIn('h-salary-sep', [SALARY])).toBeUndefined()
  })

  it('confirmed and rejected matches are not suggested again', () => {
    expect(forIn('m-genest', [GENEST_PAYBACK])).toBeUndefined()
    expect(forIn('m-bennie', [TICKET_PASS])).toBeUndefined()
    const key = candidateKey(forIn('m-bennie')!)
    expect(forIn('m-bennie', [SALARY], new Set([key]))).toBeUndefined()
  })

  it('held money is not a payback', () => {
    expect(forIn('m-gabe-oct', [GABE_FOR_PATRICK])).toBeUndefined()
  })

  it('an exact share needs a cue to be exact; without one, or after a month, it’s less sure', () => {
    const txs: Transaction[] = [
      {
        id: 'o',
        accountName: 'Monzo',
        date: '2026-10-01',
        description: 'CINEMA',
        amount: -3000,
        merchant: 'Cinema',
      },
      {
        id: 'a',
        accountName: 'Monzo',
        date: '2026-10-03',
        description: 'ALEX SPLITWISE',
        amount: 1000,
        merchant: 'Alex',
      },
      {
        id: 'b',
        accountName: 'Monzo',
        date: '2026-10-04',
        description: 'BEA',
        amount: 1000,
        merchant: 'Bea',
      },
      {
        id: 'c',
        accountName: 'Monzo',
        date: '2026-11-20',
        description: 'CAL',
        amount: 1000,
        merchant: 'Cal',
      },
      {
        id: 'd',
        accountName: 'Monzo',
        date: '2026-11-21',
        description: 'DEE',
        amount: 1500,
        merchant: 'Dee',
      },
    ]
    const m = findMatches(txs, buildLedger(txs, []), [])
    expect(m.find((x) => x.inId === 'a')).toMatchObject({ confidence: 'exact', parts: 3 })
    expect(m.find((x) => x.inId === 'b')).toMatchObject({ confidence: 'likely', parts: 3 })
    // A third seven weeks later, with nothing to say it's a payback, is too much of a stretch.
    expect(m.find((x) => x.inId === 'c')).toBeUndefined()
    // Half is still worth checking.
    expect(m.find((x) => x.inId === 'd')).toMatchObject({ confidence: 'check', parts: 2 })
  })

  it('shares that don’t divide evenly allow the odd penny', () => {
    const txs: Transaction[] = [
      {
        id: 'o',
        accountName: 'Monzo',
        date: '2026-10-01',
        description: 'PIZZA',
        amount: -1001,
        merchant: 'Pizza',
      },
      {
        id: 'a',
        accountName: 'Monzo',
        date: '2026-10-02',
        description: 'ALEX',
        amount: 334,
        merchant: 'Alex',
      },
    ]
    expect(findMatches(txs, buildLedger(txs, []), [])[0]).toMatchObject({ parts: 3 })
  })

  it('your share after paybacks: Ryanair £297.77 less Amelie’s £148.80 is £148.97', () => {
    expect(shareAfterPaybacks('h-ryanair', TRANSACTIONS, [AMELIE_PAYBACK])).toEqual({
      paid: 29777,
      paidBack: 14880,
      yours: 14897,
    })
    expect(shareAfterPaybacks('m-genest', TRANSACTIONS, [])).toBeNull()
  })
})

describe('loose ends', () => {
  it('holding £298.50 of Gabe’s rent for Patrick: November hasn’t gone on yet', () => {
    const [h] = heldBalances(TRANSACTIONS, ledgerWith([GABE_FOR_PATRICK]), [GABE_FOR_PATRICK])
    expect(h).toMatchObject({
      from: 'Gabe S',
      forPerson: 'Patrick O',
      received: 89550,
      passedOn: 59700,
      holding: 29850,
      lastIn: '2026-11-01',
      lastOut: '2026-10-02',
    })
  })

  it('still owed £30 by someone, until a matching payback arrives', () => {
    const owed = fact({
      kind: 'owed',
      person: 'Someone',
      amount: 3000,
      date: '2026-10-31',
      outIds: ['m-halloween-1'],
    })
    expect(owedToYou(TRANSACTIONS, [owed])).toEqual([
      expect.objectContaining({ person: 'Someone', amount: 3000, received: 0, outstanding: 3000 }),
    ])
    const fromGenest = fact({
      kind: 'owed',
      person: 'Genest J',
      amount: 3000,
      date: '2026-10-31',
      eventId: 'ev-halloween',
    })
    expect(owedToYou(TRANSACTIONS, [fromGenest, GENEST_PAYBACK])[0]).toMatchObject({
      received: 3000,
      outstanding: 0,
    })
  })

  it('a payback only pays down one debt', () => {
    const a = fact({
      kind: 'owed',
      person: 'Genest J',
      amount: 3000,
      date: '2026-10-30',
      eventId: 'ev-halloween',
    })
    const b = fact({
      kind: 'owed',
      person: 'Genest J',
      amount: 3000,
      date: '2026-10-31',
      eventId: 'ev-halloween',
    })
    const r = owedToYou(TRANSACTIONS, [a, b, GENEST_PAYBACK])
    expect(r.map((o) => o.outstanding)).toEqual([0, 3000])
  })

  it('back-and-forth people, and regular runs in and out', () => {
    const l = ledgerWith([])
    const people = counterparts(TRANSACTIONS, l)
    expect(people.map((p) => p.name)).toContain('Gabe S')
    expect(people.find((p) => p.name === 'N W Monzo')).toBeUndefined()
    expect(regularRuns(TRANSACTIONS, l, 'in').map((r) => [r.name, r.amount])).toEqual([
      ['Acme Ltd', 200000],
      ['Gabe S', 29850],
    ])
    expect(regularRuns(TRANSACTIONS, l, 'out').map((r) => [r.name, r.amount, r.day])).toEqual([
      ['Patrick O', 59700, 2],
    ])
  })
})

describe('month to date', () => {
  it('compares 1–18 November with 1–18 October, leaving out transfers and held money', () => {
    const facts = [GABE_FOR_PATRICK]
    const c = compareMonthToDate(TRANSACTIONS, ledgerWith(facts), facts, { today: TODAY })
    expect(c.thisMonth).toMatchObject({ from: '2026-11-01', to: '2026-11-18', spent: 10500, paidBack: 0 })
    // October: Patrick £298.50 of own rent, Sainsbury’s £40, Ikea £80 (not the 25th), seller £50.
    expect(c.lastMonth).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-18',
      spent: 29850 + 4000 + 8000 + 5000,
    })
    expect(c.difference).toBe(10500 - 46850)
  })

  it('with a category (Home), case-insensitively', () => {
    const c = compareMonthToDate(TRANSACTIONS, ledgerWith([]), [], { today: TODAY, category: 'home' })
    expect(c.thisMonth.spent).toBe(5000)
    expect(c.lastMonth.spent).toBe(8000)
    expect(c.difference).toBe(-3000)
  })

  it('last month shorter: 31 March compares with the whole of February', () => {
    const c = compareMonthToDate([], new Map(), [], { today: '2027-03-31' })
    expect(c.lastMonth).toMatchObject({ from: '2027-02-01', to: '2027-02-28' })
  })

  it('a payback counts in the month of what it paid back, not the month it arrived', () => {
    // Genest paid on 2 Nov for Halloween shopping on 30 and 31 Oct.
    const p = fact({ kind: 'payback', inId: 'm-genest', outIds: ['m-halloween-1', 'h-halloween-2'] })
    const l = ledgerWith([p])
    expect(spendBetween(TRANSACTIONS, l, [p], '2026-11-01', '2026-11-18').paidBack).toBe(0)
    const oct = spendBetween(TRANSACTIONS, l, [p], '2026-10-01', '2026-10-31')
    expect(oct.paidBack).toBe(3000)
    // £35 Shopping and £25 Groceries: the £30 splits £17.50 / £12.50.
    expect(
      spendBetween(TRANSACTIONS, l, [p], '2026-10-01', '2026-10-31', { category: 'Groceries' }).paidBack,
    ).toBe(1250)
    // An event payback has no outgoings of its own: it counts when it came in.
    expect(
      spendBetween(TRANSACTIONS, ledgerWith([GENEST_PAYBACK]), [GENEST_PAYBACK], '2026-11-01', '2026-11-18')
        .paidBack,
    ).toBe(3000)
  })

  it('paybacks reduce spending in the right category', () => {
    const facts = [AMELIE_PAYBACK]
    const all = spendBetween(TRANSACTIONS, ledgerWith(facts), facts, '2026-08-01', '2026-08-31')
    expect(all.paidBack).toBe(14880)
    expect(all.net).toBe(all.spent - 14880)
    const food = spendBetween(TRANSACTIONS, ledgerWith(facts), facts, '2026-08-01', '2026-08-31', {
      category: 'Eating out',
    })
    expect(food.paidBack).toBe(0)
  })

  it('ignored party payments drop out of August', () => {
    const before = spendBetween(TRANSACTIONS, ledgerWith([]), [], '2026-08-01', '2026-08-10')
    const after = spendBetween(
      TRANSACTIONS,
      ledgerWith([IGNORE_PARTY]),
      [IGNORE_PARTY],
      '2026-08-01',
      '2026-08-10',
    )
    expect(before.spent - after.spent).toBe(12000 + 2450 + 3600 + 1500)
  })
})

describe('caveats', () => {
  it('HSBC shows posting dates, Monzo real dates', () => {
    const c = accountCaveats(TRANSACTIONS, [])
    expect(c.map((x) => [x.account, x.dates, x.from])).toEqual([
      ['HSBC', 'posting', 'bank'],
      ['Monzo', 'transaction', 'bank'],
    ])
    expect(c[0]!.text).toBe('HSBC shows the day a payment cleared, often a day or three after you paid.')
  })

  it('what you told Ordo wins', () => {
    const c = accountCaveats(TRANSACTIONS, [fact({ kind: 'account', account: 'hsbc', dates: 'transaction' })])
    expect(c[0]).toMatchObject({ dates: 'transaction', from: 'you' })
  })

  it('warns about posting dates and statements that stop early', () => {
    const notes = periodCaveats(accountCaveats(TRANSACTIONS, []), TODAY)
    expect(notes).toEqual(["HSBC's statement stops on 5 Nov, so anything after that isn't counted."])
    expect(periodCaveats(accountCaveats(TRANSACTIONS, []), '2026-11-06')).toEqual([
      'HSBC shows posting dates, so the last few days may not be in yet.',
    ])
  })
})

describe('questions', () => {
  const ask = (facts: MoneyFact[] = [], dismissed = new Set<string>()) =>
    proposeQuestions({ transactions: TRANSACTIONS, ledger: ledgerWith(facts), facts, dismissed })

  it('asks what Gabe’s regular money is, suggesting it’s for Patrick', () => {
    const q = ask().find((x) => x.id === 'regular-in:gabes>patricko')!
    expect(q.text).toBe(
      "Gabe S pays you about £298.50 a month, and you pay Patrick O about £597.00 a month. Is Gabe S's money for Patrick O?",
    )
    expect(q.answers.map((a) => a.id)).toEqual(['pass-on', 'income', 'later'])
    expect(q.answers[0]!.facts).toEqual([{ kind: 'held', from: 'Gabe S', forPerson: 'Patrick O', what: '' }])
  })

  it('asks about salary until told it’s income', () => {
    expect(ask().some((q) => q.id === 'regular-in:acmeltd')).toBe(false) // the description says SALARY
    const odd = TRANSACTIONS.map((t) =>
      t.id.startsWith('h-salary') ? { ...t, description: 'ACME LTD BGC' } : t,
    )
    const qs = proposeQuestions({
      transactions: odd,
      ledger: buildLedger(odd, []),
      facts: [],
      dismissed: new Set(),
    })
    expect(qs.find((q) => q.id === 'regular-in:acmeltd')?.text).toBe(
      'Acme Ltd pays you about £2,000.00 a month. What is it?',
    )
    const told = proposeQuestions({
      transactions: odd,
      ledger: buildLedger(odd, [SALARY]),
      facts: [SALARY],
      dismissed: new Set(),
    })
    expect(told.some((q) => q.id === 'regular-in:acmeltd')).toBe(false)
  })

  it('asks about the pass-through and the paybacks, with ready-made facts', () => {
    const qs = ask([GABE_FOR_PATRICK, SALARY])
    const pass = qs.find((q) => q.kind === 'pass-through')!
    expect(pass.text).toBe(
      "H Bennie's £50.00 on 5 Oct went out again the same day to Sam Seller. Was it just passing through?",
    )
    expect(pass.answers[0]!.facts).toEqual([{ kind: 'pass-through', inId: 'm-bennie', outId: 'm-seller' }])
    const genest = qs.find((q) => q.kind === 'payback' && q.transactionIds[0] === 'm-genest')!
    expect(genest.text).toBe(
      "Was Genest J's £30.00 on 2 Nov paying you back? It's half of 2 payments totalling £60.00, 2 days later.",
    )
    expect(genest.answers[0]!.facts[0]).toMatchObject({
      kind: 'payback',
      inId: 'm-genest',
      person: 'Genest J',
    })
  })

  it('links a payback to an event that holds its outgoings', () => {
    const qs = ask([HALLOWEEN, SALARY])
    const genest = qs.find((q) => q.kind === 'payback' && q.transactionIds[0] === 'm-genest')!
    expect(genest.answers[0]!.facts[0]).toMatchObject({ eventId: 'ev-halloween' })
  })

  it('asks who people are, then stops once told', () => {
    const qs = ask([GABE_FOR_PATRICK])
    const who = qs.find((q) => q.kind === 'person')
    expect(who).toBeDefined()
    const name = who!.answers[0]!.facts[0] as { name: string }
    const after = ask([GABE_FOR_PATRICK, fact({ kind: 'person', name: name.name, role: 'friend' })])
    expect(after.some((q) => q.id === who!.id)).toBe(false)
  })

  it('never brings back a dismissed question, and orders people, regular, then matches', () => {
    const qs = ask()
    const dismissed = new Set([qs[0]!.id])
    expect(ask([], dismissed).some((q) => q.id === qs[0]!.id)).toBe(false)
    const steps = qs.map((q) => q.step)
    expect(
      [...steps].sort(
        (a, b) => ['people', 'regular', 'matches'].indexOf(a) - ['people', 'regular', 'matches'].indexOf(b),
      ),
    ).toEqual(steps)
  })

  it('nothing to ask once everything is known', () => {
    const qs = ask(ALL_FACTS)
    expect(qs.filter((q) => q.kind !== 'person')).toEqual([])
  })
})

describe('memory feeds Bills', () => {
  const detectedPatrick: DetectedBill = {
    key: 'patricko',
    merchantKey: 'patricko',
    name: 'Patrick O',
    amount: 59700,
    cadence: 'monthly',
    nextDue: '2026-12-02',
    source: 'bank',
    confidence: 0.6,
    transactionIds: ['m-patrick-sep', 'm-patrick-oct'],
    hints: [],
  }

  it('Gabe’s rent for Patrick becomes a split on the detected Patrick payment', () => {
    const r = withMemoryBills(
      [detectedPatrick],
      TRANSACTIONS,
      ledgerWith([GABE_FOR_PATRICK]),
      [GABE_FOR_PATRICK],
      TODAY,
    )
    expect(r).toHaveLength(1)
    expect(r[0]!.suggestedSplit).toEqual({
      shares: [
        { name: 'Me', amount: 29850 },
        { name: 'Gabe S', amount: 29850 },
      ],
      reason: "You told Ordo Gabe S's money is for Patrick O. Gabe S pays you about £298.50 of the £597.00.",
    })
  })

  it('proposes the bill itself when the rules hadn’t found it', () => {
    const r = withMemoryBills([], TRANSACTIONS, ledgerWith([GABE_FOR_PATRICK]), [GABE_FOR_PATRICK], TODAY)
    expect(r).toEqual([
      expect.objectContaining({
        key: 'memory:held-gabe',
        name: 'Rent to Patrick O',
        amount: 59700,
        cadence: 'monthly',
        nextDue: '2026-12-02',
        source: 'bank',
        suggestedSplit: expect.objectContaining({
          shares: [
            { name: 'Me', amount: 29850 },
            { name: 'Gabe S', amount: 29850 },
          ],
        }),
      }),
    ])
  })

  it('a flatmate paying towards a regular payment suggests a split too', () => {
    const gabe = fact({ kind: 'person', name: 'Gabe S', role: 'flatmate' })
    const r = withMemoryBills([detectedPatrick], TRANSACTIONS, ledgerWith([gabe]), [gabe], TODAY)
    expect(r[0]!.suggestedSplit?.reason).toBe(
      'Gabe S is your flatmate and pays you about £298.50 a month, around when this goes out.',
    )
  })

  it('no facts, no changes', () => {
    expect(withMemoryBills([detectedPatrick], TRANSACTIONS, ledgerWith([]), [], TODAY)).toEqual([
      detectedPatrick,
    ])
  })
})

describe('held money settles a shared bill', () => {
  const people = [
    { id: 'me', name: 'Me' },
    { id: 'gabe', name: 'Gabe S' },
  ]
  const bill = {
    id: 'rent',
    name: 'Rent to Patrick O',
    amount: 59700,
    cadence: 'monthly' as const,
    anchorDate: '2026-12-02',
    source: 'bank' as const,
    status: 'active' as const,
    merchantKey: 'patricko',
  }
  const split = {
    billId: 'rent',
    paidBy: 'me',
    mode: 'fixed' as const,
    shares: [
      { personId: 'me', value: 29850 },
      { personId: 'gabe', value: 29850 },
    ],
    since: '2026-10-02',
  }
  const input = {
    transactions: TRANSACTIONS,
    ledger: ledgerWith([GABE_FOR_PATRICK]),
    facts: [GABE_FOR_PATRICK],
    people,
    bills: [bill],
    splits: [split],
  }

  it('counts Gabe’s held payments since the split started as him paying his share', () => {
    expect(heldSettlements(input)).toEqual([
      {
        id: 'held:m-gabe-nov',
        from: 'gabe',
        to: 'me',
        amount: 29850,
        date: '2026-11-01',
        note: 'Held for Patrick O',
      },
    ])
  })

  it('so Bills doesn’t also say he owes it', () => {
    const base = { bills: [bill], splits: [split], transactions: TRANSACTIONS, today: TODAY }
    expect(balances({ ...base, settlements: [] }).debts).toEqual([{ from: 'gabe', to: 'me', amount: 29850 }])
    expect(balances({ ...base, settlements: heldSettlements(input) }).debts).toEqual([])
  })

  it('nothing without the fact, the person or a split for that bill', () => {
    expect(heldSettlements({ ...input, facts: [], ledger: ledgerWith([]) })).toEqual([])
    expect(heldSettlements({ ...input, people: [people[0]!] })).toEqual([])
    expect(heldSettlements({ ...input, bills: [{ ...bill, merchantKey: 'netflix' }] })).toEqual([])
  })
})

describe('describing facts', () => {
  it('says each fact in a plain sentence', () => {
    const d = describeFacts(ALL_FACTS, TRANSACTIONS).map((f) => f.summary)
    expect(d).toEqual([
      'Halloween: 2 payments added.',
      'Italy from 28 Aug to 4 Sept: not counting Ryanair.',
      'Concert ticket: 2 payments added.',
      'Money from Gabe S is rent you hold for Patrick O, not your income.',
      'Genest J £30.00 on 2 Nov paid you back for Halloween.',
      'Luca B £5.00 on 5 Sept paid you back for Italy.',
      'Amelie R £148.80 on 20 Aug paid you back for Ryanair £297.77 on 15 Aug.',
      'H Bennie £50.00 on 5 Oct passed straight through to Sam Seller £50.00 on 5 Oct.',
      'Ignore 4 payments: August party.',
      'Payments from Acme Ltd are your income.',
    ])
  })
})
