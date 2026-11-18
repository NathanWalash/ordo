// The net cost of a "thing" across every account: an event or trip's outgoings, what came back
// (paybacks, resales), and what it cost you in the end. Whole pence throughout.

import type { Ledger } from './ledger'
import { aliasesFor, counterpartName, factsOf, involves, type FactOf, type MoneyFact } from './memory'
import type { Transaction } from './types'

export interface EventLine {
  id: string
  date: string
  account: string
  name: string
  /** Pence, positive. */
  amount: number
  category: string
}

export interface EventCost {
  id: string
  name: string
  from?: string
  to?: string
  /** Everything you paid out for it, in pence. */
  paidOut: number
  /** Everything that came back: paybacks and money in you added to it. */
  paidBack: number
  /** What it cost you: paid out minus paid back. */
  net: number
  byCategory: { category: string; amount: number }[]
  byAccount: { account: string; amount: number }[]
  outgoings: EventLine[]
  /** Money that came back, with who from when Ordo knows. */
  paybacks: (EventLine & { person?: string })[]
  /** Payments in the dates that were left out (other merchants you excluded, say). */
  excluded: number
}

/** Categories a date range doesn't pick up by itself. */
const NOT_EVENT_SPENDING = new Set(['Transfers', 'Bills', 'Subscriptions', 'Income'])

const line = (t: Transaction, amount: number): EventLine => ({
  id: t.id,
  date: t.date,
  account: t.accountName,
  name: counterpartName(t),
  amount,
  category: t.category ?? 'Other',
})

const sum = (lines: { amount: number }[]) => lines.reduce((n, l) => n + l.amount, 0)

function grouped(lines: EventLine[], key: (l: EventLine) => string) {
  const m = new Map<string, number>()
  for (const l of lines) m.set(key(l), (m.get(key(l)) ?? 0) + l.amount)
  return [...m]
    .map(([k, amount]) => ({ k, amount }))
    .sort((a, b) => b.amount - a.amount || a.k.localeCompare(b.k))
}

/**
 * Work out an event's cost. Outgoings are the payments you added, plus (with dates) every
 * outgoing in those dates that is your own spending, less the ones you excluded. Transfers to
 * people, bills and subscriptions in those dates aren't picked up unless you add them. Money back is
 * any money in you added, plus paybacks you confirmed for the event or for its outgoings (shared in
 * proportion when a payback covered other things too).
 */
export function eventCost(
  event: FactOf<'event'>,
  transactions: readonly Transaction[],
  ledger: Ledger,
  facts: readonly MoneyFact[] = [],
): EventCost {
  const include = new Set(event.include)
  const exclude = new Set(event.exclude)
  const merchants = event.excludeMerchants.map((m) => ({ m, aliases: aliasesFor(facts, m) }))
  const byId = new Map(transactions.map((t) => [t.id, t]))
  const inRange = (t: Transaction) => !!event.from && !!event.to && t.date >= event.from && t.date <= event.to

  const outgoings: EventLine[] = []
  const back: (EventLine & { person?: string })[] = []
  let excluded = 0
  for (const t of transactions) {
    if (exclude.has(t.id)) {
      if (inRange(t) || include.has(t.id)) excluded++
      continue
    }
    if (include.has(t.id)) {
      if (t.amount < 0) outgoings.push(line(t, -t.amount))
      else if (t.amount > 0) back.push(line(t, t.amount))
      continue
    }
    if (t.amount >= 0 || !inRange(t) || ledger.get(t.id)?.role !== 'spend') continue
    // Rent, bills and payments to people carry on whatever you're doing: add them by hand if they belong.
    if (NOT_EVENT_SPENDING.has(t.category ?? '')) continue
    if (merchants.some(({ m, aliases }) => involves(t, m, aliases))) {
      excluded++
      continue
    }
    outgoings.push(line(t, -t.amount))
  }

  const members = new Set(outgoings.map((l) => l.id))
  const counted = new Set(back.map((l) => l.id))
  for (const p of factsOf(facts, 'payback')) {
    const inn = byId.get(p.inId)
    if (!inn || counted.has(inn.id)) continue
    let amount: number
    if (p.eventId === event.id) amount = inn.amount
    else {
      const covered = p.outIds.filter((id) => members.has(id))
      if (!covered.length) continue
      const total = p.outIds.reduce((n, id) => n - (byId.get(id)?.amount ?? 0), 0)
      const part = covered.reduce((n, id) => n - (byId.get(id)?.amount ?? 0), 0)
      amount = total > 0 ? Math.round((inn.amount * part) / total) : 0
    }
    if (!amount) continue
    counted.add(inn.id)
    back.push({ ...line(inn, amount), ...(p.person && { person: p.person }) })
  }

  outgoings.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount)
  back.sort((a, b) => a.date.localeCompare(b.date))
  const paidOut = sum(outgoings)
  const paidBack = sum(back)
  return {
    id: event.id,
    name: event.name,
    ...(event.from && { from: event.from }),
    ...(event.to && { to: event.to }),
    paidOut,
    paidBack,
    net: paidOut - paidBack,
    byCategory: grouped(outgoings, (l) => l.category).map(({ k, amount }) => ({ category: k, amount })),
    byAccount: grouped(outgoings, (l) => l.account).map(({ k, amount }) => ({ account: k, amount })),
    outgoings,
    paybacks: back,
    excluded,
  }
}

/** Every saved event's cost, newest first. */
export function allEventCosts(
  transactions: readonly Transaction[],
  ledger: Ledger,
  facts: readonly MoneyFact[],
): EventCost[] {
  return factsOf(facts, 'event')
    .map((e) => eventCost(e, transactions, ledger, facts))
    .sort((a, b) =>
      (b.from ?? b.outgoings[0]?.date ?? '').localeCompare(a.from ?? a.outgoings[0]?.date ?? ''),
    )
}
