// Start Bills from what you taught Ordo. A flatmate who pays you a similar amount each month that
// you pass on is a shared bill with a split: Ordo proposes it in Bills → Detected, and confirming it
// there saves the bill and the split. Nothing is saved without that confirm.

import { formatPence } from './amount'
import { addMonths, nextOnOrAfter, type ISODate } from './dates'
import type { Ledger } from './ledger'
import { onwardFor, regularRuns, type RegularRun } from './loose-ends'
import { aliasesFor, factsOf, involves, type MoneyFact } from './memory'
import { merchantKey, sameMerchant } from './merchant'
import {
  ME,
  type DetectedBill,
  type Person,
  type Settlement,
  type Split,
  type StoredBill,
  type SuggestedSplit,
  type Transaction,
} from './types'

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2)
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

interface Proposal {
  key: string
  out: RegularRun
  name: string
  split: SuggestedSplit | null
}

function split(payer: string, payerShare: number, total: number, reason: string): SuggestedSplit | null {
  if (payerShare <= 0 || payerShare > total) return null
  return {
    shares: [
      { name: 'Me', amount: total - payerShare },
      { name: payer, amount: payerShare },
    ],
    reason,
  }
}

/** Bills your facts point at: held money you pass on, and flatmates paying towards a regular payment. */
function proposals(
  transactions: readonly Transaction[],
  ledger: Ledger,
  facts: readonly MoneyFact[],
): Proposal[] {
  const out: Proposal[] = []
  const outRuns = regularRuns(transactions, ledger, 'out')
  const inRuns = regularRuns(transactions, ledger, 'in')

  for (const rule of factsOf(facts, 'held')) {
    const forAliases = aliasesFor(facts, rule.forPerson)
    const fromAliases = aliasesFor(facts, rule.from)
    const run = outRuns.find((r) =>
      r.transactionIds.every((id) => {
        const t = transactions.find((x) => x.id === id)
        return !!t && involves(t, rule.forPerson, forAliases)
      }),
    )
    if (!run) continue
    const ins = transactions
      .filter(
        (t) => t.amount > 0 && involves(t, rule.from, fromAliases) && ledger.get(t.id)?.factId === rule.id,
      )
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-3)
    const share = ins.length ? median(ins.map((t) => t.amount)) : 0
    out.push({
      key: `memory:${rule.id}`,
      out: run,
      name: rule.what ? `${capital(rule.what)} to ${rule.forPerson}` : `Paid to ${rule.forPerson}`,
      split: split(
        rule.from,
        share,
        run.amount,
        `You told Ordo ${rule.from}'s money is for ${rule.forPerson}. ${rule.from} pays you about ${formatPence(share)} of the ${formatPence(run.amount)}.`,
      ),
    })
  }

  for (const p of factsOf(facts, 'person')) {
    if (p.role !== 'flatmate') continue
    if (factsOf(facts, 'held').some((h) => h.from.toLowerCase() === p.name.toLowerCase())) continue
    const inRun = inRuns.find((r) =>
      r.transactionIds.some((id) => {
        const t = transactions.find((x) => x.id === id)
        return !!t && involves(t, p.name, p.aliases)
      }),
    )
    const onward = inRun && onwardFor(inRun, outRuns)
    if (!inRun || !onward) continue
    out.push({
      key: `memory:flatmate:${onward.key}`,
      out: onward,
      name: onward.name,
      split: split(
        p.name,
        inRun.amount,
        onward.amount,
        `${p.name} is your flatmate and pays you about ${formatPence(inRun.amount)} a month, around when this goes out.`,
      ),
    })
  }
  return out
}

/**
 * Detected bills with what your facts add: a suggested split on a payment Ordo already found, or
 * a new suggestion when the rules hadn't found it. Bills already saved are left to `resolveBills`.
 */
export function withMemoryBills(
  detected: readonly DetectedBill[],
  transactions: readonly Transaction[],
  ledger: Ledger,
  facts: readonly MoneyFact[],
  today: ISODate,
): DetectedBill[] {
  const result = [...detected]
  for (const p of proposals(transactions, ledger, facts)) {
    const i = result.findIndex(
      (d) => d.cadence === 'monthly' && sameMerchant(d.merchantKey, p.out.key) && d.amount !== null,
    )
    if (i >= 0) {
      const d = result[i]!
      const s = p.split && d.amount !== p.out.amount ? rescale(p.split, d.amount!) : p.split
      result[i] = { ...d, ...(s && { suggestedSplit: s }) }
      continue
    }
    if (result.some((d) => d.key === p.key)) continue
    result.push({
      key: p.key,
      merchantKey: p.out.key,
      name: p.name,
      amount: p.out.amount,
      cadence: 'monthly',
      nextDue: nextOnOrAfter(
        p.out.lastDate,
        'monthly',
        today > p.out.lastDate ? today : addMonths(p.out.lastDate, 1),
      ),
      lastPaid: p.out.lastDate,
      source: 'bank',
      confidence: 0.6,
      transactionIds: p.out.transactionIds,
      hints: [],
      ...(p.split && { suggestedSplit: p.split }),
    })
  }
  return result
}

/** Keep the payer's share and give the rest to you when the bill's latest amount differs. */
function rescale(s: SuggestedSplit, total: number): SuggestedSplit | null {
  const others = s.shares.filter((x) => x.name !== 'Me')
  const theirs = others.reduce((n, x) => n + x.amount, 0)
  if (theirs > total) return null
  return { ...s, shares: [{ name: 'Me', amount: total - theirs }, ...others] }
}

/**
 * Money a flatmate paid you that you hold for someone counts as them paying their share of the
 * shared bill to that someone, so Bills doesn't say they still owe it. One settlement per held
 * payment on or after the split started, for splits you pay that include them.
 */
export function heldSettlements(input: {
  transactions: readonly Transaction[]
  ledger: Ledger
  facts: readonly MoneyFact[]
  people: readonly Person[]
  bills: readonly StoredBill[]
  splits: readonly Split[]
}): Settlement[] {
  const out: Settlement[] = []
  for (const rule of factsOf(input.facts, 'held')) {
    const payer = input.people.find((p) => p.name.toLowerCase() === rule.from.toLowerCase())
    if (!payer || payer.id === ME) continue
    const forKey = merchantKey(rule.forPerson)
    const starts = input.splits
      .filter((s) => s.paidBy === ME && s.shares.some((x) => x.personId === payer.id && x.value > 0))
      .filter((s) => {
        const bill = input.bills.find((b) => b.id === s.billId)
        return !!bill?.merchantKey && sameMerchant(bill.merchantKey, forKey)
      })
      .map((s) => s.since)
      .sort()
    if (!starts.length) continue
    for (const t of input.transactions) {
      const e = input.ledger.get(t.id)
      if (e?.role !== 'held-in' || e.factId !== rule.id || t.date < starts[0]!) continue
      out.push({
        id: `held:${t.id}`,
        from: payer.id,
        to: ME,
        amount: t.amount,
        date: t.date,
        note: `Held for ${rule.forPerson}`,
      })
    }
  }
  return out
}
