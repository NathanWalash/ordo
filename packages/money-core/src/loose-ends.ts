// Loose ends: money you're holding for someone that hasn't gone on yet, money people still owe
// you, and who you pay back and forth with. Worked out from saved facts and the ledger.

import { daysBetween } from './dates'
import type { Ledger } from './ledger'
import { aliasesFor, counterpartKey, counterpartName, factsOf, involves, type MoneyFact } from './memory'
import type { Transaction } from './types'

export interface HeldBalance {
  factId: string
  from: string
  forPerson: string
  what: string
  /** Pence received from `from`. */
  received: number
  /** Pence of that passed on to `forPerson`. */
  passedOn: number
  /** Pence still with you: received minus passed on. */
  holding: number
  lastIn?: string
  lastOut?: string
  ins: { id: string; date: string; amount: number }[]
  outs: { id: string; date: string; amount: number }[]
}

export interface OwedItem {
  factId: string
  person: string
  /** Pence they owe in all. */
  amount: number
  /** Pence of it they've paid back (confirmed paybacks from them for the same thing). */
  received: number
  outstanding: number
  date: string
  note: string
}

/** Someone you pay and who pays you, by the name in your statements. */
export interface Counterpart {
  key: string
  name: string
  /** Pence you sent them. */
  sent: number
  /** Pence they sent you. */
  received: number
  /** Received minus sent: positive means more came from them. */
  net: number
  payments: number
  lastDate: string
}

/** How much of each held rule's money you still have, in date order. */
export function heldBalances(
  transactions: readonly Transaction[],
  ledger: Ledger,
  facts: readonly MoneyFact[],
): HeldBalance[] {
  return factsOf(facts, 'held').map((rule) => {
    const ins: HeldBalance['ins'] = []
    const outs: HeldBalance['outs'] = []
    for (const t of transactions) {
      const e = ledger.get(t.id)
      if (e?.factId !== rule.id) continue
      if (e.role === 'held-in') ins.push({ id: t.id, date: t.date, amount: t.amount })
      if (e.role === 'held-out') outs.push({ id: t.id, date: t.date, amount: -t.amount - e.spend })
    }
    ins.sort((a, b) => a.date.localeCompare(b.date))
    outs.sort((a, b) => a.date.localeCompare(b.date))
    const received = ins.reduce((n, x) => n + x.amount, 0)
    const passedOn = outs.reduce((n, x) => n + x.amount, 0)
    return {
      factId: rule.id,
      from: rule.from,
      forPerson: rule.forPerson,
      what: rule.what,
      received,
      passedOn,
      holding: received - passedOn,
      ...(ins.length && { lastIn: ins[ins.length - 1]!.date }),
      ...(outs.length && { lastOut: outs[outs.length - 1]!.date }),
      ins,
      outs,
    }
  })
}

/**
 * What people still owe you. Each owed fact is paid down by confirmed paybacks from the same
 * person for the same outgoings or event.
 */
export function owedToYou(transactions: readonly Transaction[], facts: readonly MoneyFact[]): OwedItem[] {
  const byId = new Map(transactions.map((t) => [t.id, t]))
  const paybacks = factsOf(facts, 'payback')
  const used = new Set<string>()
  return factsOf(facts, 'owed')
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((o) => {
      const aliases = aliasesFor(facts, o.person)
      let received = 0
      for (const p of paybacks) {
        if (used.has(p.inId)) continue
        const inn = byId.get(p.inId)
        if (!inn) continue
        const same =
          (o.eventId !== undefined && p.eventId === o.eventId) || p.outIds.some((id) => o.outIds.includes(id))
        const fromThem =
          (p.person !== undefined && p.person.toLowerCase() === o.person.toLowerCase()) ||
          involves(inn, o.person, aliases)
        if (!same || !fromThem) continue
        used.add(p.inId)
        received += inn.amount
      }
      return {
        factId: o.id,
        person: o.person,
        amount: o.amount,
        received: Math.min(received, o.amount),
        outstanding: Math.max(0, o.amount - received),
        date: o.date,
        note: o.note,
      }
    })
}

/** Payment rails that mean the other side is a person or an account, not a shop. */
const PERSON_RAIL =
  /\b(bp|fpo|fpi|so|obp|faster payments?|transfer|tfr|splitwise|monzo|bank transfer|standing order)\b/i

/** Does this payment look like it went to (or came from) a person rather than a shop? */
export const personLike = (t: Transaction) =>
  t.amount > 0 ? true : t.category === 'Transfers' || PERSON_RAIL.test(t.description)

/**
 * People you pay back and forth with: at least one payment each way, or `min` payments to someone
 * who looks like a person. Transfers between your own accounts and ignored payments don't count.
 */
export function counterparts(
  transactions: readonly Transaction[],
  ledger: Ledger,
  opts: { min?: number } = {},
): Counterpart[] {
  const min = opts.min ?? 3
  const map = new Map<string, Counterpart & { ins: number; outs: number; personish: number }>()
  for (const t of transactions) {
    const role = ledger.get(t.id)?.role
    if (role === 'own-transfer' || role === 'ignored') continue
    const key = counterpartKey(t)
    if (key.length < 3) continue
    const c = map.get(key) ?? {
      key,
      name: counterpartName(t),
      sent: 0,
      received: 0,
      net: 0,
      payments: 0,
      lastDate: t.date,
      ins: 0,
      outs: 0,
      personish: 0,
    }
    if (t.amount > 0) {
      c.received += t.amount
      c.ins++
    } else {
      c.sent -= t.amount
      c.outs++
      if (personLike(t)) c.personish++
    }
    c.payments++
    if (t.date > c.lastDate) c.lastDate = t.date
    map.set(key, c)
  }
  return [...map.values()]
    .filter((c) => (c.ins > 0 && c.outs > 0) || (c.ins >= 2 && !c.outs) || (c.personish >= min && !c.ins))
    .map(({ ins: _i, outs: _o, personish: _p, ...c }) => ({ ...c, net: c.received - c.sent }))
    .sort((a, b) => b.payments - a.payments || a.name.localeCompare(b.name))
}

/** A regular run of similar payments from (or to) one counterpart, roughly monthly. */
export interface RegularRun {
  key: string
  name: string
  direction: 'in' | 'out'
  /** Median pence. */
  amount: number
  /** Day of the month it usually lands on. */
  day: number
  transactionIds: string[]
  lastDate: string
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2)
}

/**
 * Monthly-ish payments in or out with one counterpart: at least two, 25–36 days apart, amounts
 * within 10% of the median. Finds Gabe's rent share coming in, and rent going out to Patrick.
 */
export function regularRuns(
  transactions: readonly Transaction[],
  ledger: Ledger,
  direction: 'in' | 'out',
): RegularRun[] {
  const groups = new Map<string, Transaction[]>()
  for (const t of transactions) {
    if (direction === 'in' ? t.amount <= 0 : t.amount >= 0) continue
    const role = ledger.get(t.id)?.role
    if (role === 'own-transfer' || role === 'ignored' || role === 'pass-through') continue
    const key = counterpartKey(t)
    if (key.length < 3) continue
    groups.set(key, [...(groups.get(key) ?? []), t])
  }
  const runs: RegularRun[] = []
  for (const [key, txs] of groups) {
    if (txs.length < 2) continue
    const amounts = txs.map((t) => Math.abs(t.amount))
    const m = median(amounts)
    const similar = txs
      .filter((t) => Math.abs(Math.abs(t.amount) - m) <= m * 0.1)
      .sort((a, b) => a.date.localeCompare(b.date))
    if (similar.length < 2) continue
    const gaps = similar.slice(1).map((t, i) => daysBetween(similar[i]!.date, t.date))
    const monthly = gaps.filter((g) => g >= 25 && g <= 36).length
    if (monthly < Math.max(1, Math.ceil(gaps.length * 0.6))) continue
    const last = similar[similar.length - 1]!
    runs.push({
      key,
      name: counterpartName(last),
      direction,
      amount: median(similar.map((t) => Math.abs(t.amount))),
      day: median(similar.map((t) => Number(t.date.slice(8, 10)))),
      transactionIds: similar.map((t) => t.id),
      lastDate: last.date,
    })
  }
  return runs.sort((a, b) => b.transactionIds.length - a.transactionIds.length || a.key.localeCompare(b.key))
}

/** A monthly payment out that regular money in could be for: as big or bigger, around the same day. */
export function onwardFor(inRun: RegularRun, outRuns: readonly RegularRun[]): RegularRun | undefined {
  return outRuns
    .filter(
      (o) =>
        o.key !== inRun.key &&
        o.amount >= inRun.amount &&
        Math.min(Math.abs(o.day - inRun.day), 31 - Math.abs(o.day - inRun.day)) <= 10 &&
        Math.abs(daysBetween(o.lastDate, inRun.lastDate)) <= 40,
    )
    .sort((a, b) => a.amount - b.amount)[0]
}
