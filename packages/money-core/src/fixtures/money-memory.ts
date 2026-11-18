// A made-up few months of two bank accounts, modelled on real questions people ask about their
// money: Halloween paid back through Splitwise, a resold ticket, an Italy trip, Ryanair flights
// shared with a friend, a flatmate's rent passed on to another, and four party payments to ignore.
// Every name, amount and description is invented.

import type { MoneyFact, MoneyFactInput } from '../memory'
import type { Transaction } from '../types'

const tx = (
  id: string,
  accountName: 'Monzo' | 'HSBC',
  date: string,
  merchant: string,
  pounds: number,
  category: string,
  description = merchant.toUpperCase(),
): Transaction => ({
  id,
  accountName,
  date,
  description,
  amount: Math.round(pounds * 100),
  merchant,
  category,
})

export const TODAY = '2026-11-18'

export const TRANSACTIONS: Transaction[] = [
  // Salary into HSBC, every month.
  tx('h-salary-aug', 'HSBC', '2026-08-28', 'Acme Ltd', 2000, 'Income', 'ACME LTD SALARY BGC'),
  tx('h-salary-sep', 'HSBC', '2026-09-28', 'Acme Ltd', 2000, 'Income', 'ACME LTD SALARY BGC'),
  tx('h-salary-oct', 'HSBC', '2026-10-28', 'Acme Ltd', 2000, 'Income', 'ACME LTD SALARY BGC'),

  // Ryanair flights on HSBC; Amelie paid her half (it didn't split evenly).
  tx('h-ryanair', 'HSBC', '2026-08-15', 'Ryanair', -297.77, 'Transport', 'RYANAIR DAC DUBLIN )))'),
  tx('m-amelie', 'Monzo', '2026-08-20', 'Amelie R', 148.8, 'Income', 'AMELIE R FLIGHTS'),

  // Four August party payments the person wants left out of comparisons.
  tx('m-party-1', 'Monzo', '2026-08-08', 'Party Hire Co', -120, 'Entertainment'),
  tx('m-party-2', 'Monzo', '2026-08-08', 'Balloon Barn', -24.5, 'Shopping'),
  tx('m-party-3', 'Monzo', '2026-08-09', 'Cake Corner', -36, 'Eating out'),
  tx('m-party-4', 'Monzo', '2026-08-09', 'Party Hire Co', -15, 'Entertainment'),

  // Italy, 28 August to 4 September, flights excluded: £423.99 in all, then Luca's £5 back.
  tx('m-italy-train', 'Monzo', '2026-08-28', 'Trenitalia', -42.5, 'Transport'),
  tx('m-italy-food', 'Monzo', '2026-08-29', 'Ristorante Roma', -86, 'Eating out'),
  tx('h-italy-hotel', 'HSBC', '2026-08-31', 'Hotel Firenze', -250, 'Other', 'HOTEL FIRENZE )))'),
  tx('m-italy-gelato', 'Monzo', '2026-09-02', 'Gelateria Blu', -45.49, 'Eating out'),
  tx('m-italy-ryanair', 'Monzo', '2026-09-03', 'Ryanair', -61.2, 'Transport', 'RYANAIR BAGS'),
  tx('m-luca', 'Monzo', '2026-09-05', 'Luca B', 5, 'Income', 'LUCA B GELATO'),

  // Gabe's rent share comes in; the person pays Patrick the whole rent. November's not gone on yet.
  tx('m-gabe-sep', 'Monzo', '2026-09-01', 'Gabe S', 298.5, 'Income', 'GABE S RENT'),
  tx('m-patrick-sep', 'Monzo', '2026-09-02', 'Patrick O', -597, 'Transfers', 'PATRICK O RENT'),
  tx('m-gabe-oct', 'Monzo', '2026-10-01', 'Gabe S', 298.5, 'Income', 'GABE S RENT'),
  tx('m-patrick-oct', 'Monzo', '2026-10-02', 'Patrick O', -597, 'Transfers', 'PATRICK O RENT'),
  tx('m-gabe-nov', 'Monzo', '2026-11-01', 'Gabe S', 298.5, 'Income', 'GABE S RENT'),

  // A ticket resold: H Bennie's £50 came in and went straight back out to the seller.
  tx('m-bennie', 'Monzo', '2026-10-05', 'H Bennie', 50, 'Income', 'H BENNIE TICKET'),
  tx('m-seller', 'Monzo', '2026-10-05', 'Sam Seller', -50, 'Transfers', 'SAM SELLER'),

  // Halloween supplies from two shops, £60; Genest paid £30 back through Splitwise.
  tx('m-halloween-1', 'Monzo', '2026-10-30', 'Party Shop', -35, 'Shopping'),
  tx('h-halloween-2', 'HSBC', '2026-10-31', 'Tesco', -25, 'Groceries', 'TESCO STORES 3021 )))'),
  tx('m-genest', 'Monzo', '2026-11-02', 'Genest J', 30, 'Income', 'GENEST J SPLITWISE'),

  // Ordinary spending for month-to-date comparisons.
  tx('h-sains-oct', 'HSBC', '2026-10-05', 'Sainsburys', -40, 'Groceries', 'SAINSBURYS S/MKTS )))'),
  tx('h-sains-nov', 'HSBC', '2026-11-05', 'Sainsburys', -55, 'Groceries', 'SAINSBURYS S/MKTS )))'),
  tx('m-ikea-oct', 'Monzo', '2026-10-10', 'Ikea', -80, 'Home'),
  tx('m-ikea-nov', 'Monzo', '2026-11-12', 'Ikea', -30, 'Home'),
  tx('m-dunelm-nov', 'Monzo', '2026-11-16', 'Dunelm', -20, 'Home'),
  // After the 18th, so not part of "last month to the same day".
  tx('m-ikea-late-oct', 'Monzo', '2026-10-25', 'Ikea', -99, 'Home'),

  // Money between the person's own accounts: never spending or income.
  {
    ...tx('h-to-monzo', 'HSBC', '2026-11-03', 'N W Monzo', -200, 'Transfers', 'N W MONZO BP'),
    transferWith: 'm-from-hsbc',
    transferAccount: 'Monzo',
  },
  {
    ...tx('m-from-hsbc', 'Monzo', '2026-11-03', 'N W', 200, 'Transfers', 'N W HSBC'),
    transferWith: 'h-to-monzo',
    transferAccount: 'HSBC',
  },
]

let n = 0
const DEFAULTS: Record<string, Record<string, unknown>> = {
  person: { aliases: [] },
  event: { include: [], exclude: [], excludeMerchants: [] },
  payback: { outIds: [] },
  held: { what: '' },
  owed: { outIds: [], note: '' },
  ignore: { reason: '' },
}

/** A saved fact, as the store would return it (schema defaults filled in). */
export function fact(input: MoneyFactInput & { id?: string }): MoneyFact {
  const { id, ...rest } = input
  return {
    ...DEFAULTS[rest.kind],
    ...rest,
    id: id ?? `f${++n}`,
    createdAt: '2026-11-18T10:00:00.000Z',
    source: 'you',
  } as MoneyFact
}

// What the person would teach Ordo by answering its questions.
export const HALLOWEEN = fact({
  id: 'ev-halloween',
  kind: 'event',
  name: 'Halloween',
  include: ['m-halloween-1', 'h-halloween-2'],
})
export const ITALY = fact({
  id: 'ev-italy',
  kind: 'event',
  name: 'Italy',
  from: '2026-08-28',
  to: '2026-09-04',
  excludeMerchants: ['Ryanair'],
})
export const TICKET = fact({
  id: 'ev-ticket',
  kind: 'event',
  name: 'Concert ticket',
  include: ['m-bennie', 'm-seller'],
})
export const GABE_FOR_PATRICK = fact({
  id: 'held-gabe',
  kind: 'held',
  from: 'Gabe S',
  forPerson: 'Patrick O',
  what: 'rent',
})
export const GENEST_PAYBACK = fact({
  kind: 'payback',
  inId: 'm-genest',
  eventId: 'ev-halloween',
  person: 'Genest J',
})
export const LUCA_PAYBACK = fact({ kind: 'payback', inId: 'm-luca', eventId: 'ev-italy', person: 'Luca B' })
export const AMELIE_PAYBACK = fact({
  kind: 'payback',
  inId: 'm-amelie',
  outIds: ['h-ryanair'],
  person: 'Amelie R',
})
export const TICKET_PASS = fact({ kind: 'pass-through', inId: 'm-bennie', outId: 'm-seller' })
export const IGNORE_PARTY = fact({
  kind: 'ignore',
  transactionIds: ['m-party-1', 'm-party-2', 'm-party-3', 'm-party-4'],
  reason: 'August party',
})
export const SALARY = fact({ kind: 'income', from: 'Acme Ltd' })

/** Everything above. */
export const ALL_FACTS: MoneyFact[] = [
  HALLOWEEN,
  ITALY,
  TICKET,
  GABE_FOR_PATRICK,
  GENEST_PAYBACK,
  LUCA_PAYBACK,
  AMELIE_PAYBACK,
  TICKET_PASS,
  IGNORE_PARTY,
  SALARY,
]
