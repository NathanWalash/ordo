// Suggest which money in paid you back for which money out, and which money only passed through.
// All of it is arithmetic on whole pence: exact fractions, dates and a few words in descriptions.
// A suggestion changes nothing until you confirm it, when it becomes a fact.

import { formatPence } from './amount'
import { daysBetween } from './dates'
import { merchantKey } from './merchant'
import type { Ledger } from './ledger'
import { counterpartKey, counterpartName, factsOf, shortDate, type MoneyFact } from './memory'
import type { Transaction } from './types'

/** How sure Ordo is: an exact fraction soon after, a near one, or one to check. */
export type MatchConfidence = 'exact' | 'likely' | 'check'
export const CONFIDENCE_ORDER: Record<MatchConfidence, number> = { exact: 0, likely: 1, check: 2 }

export interface MatchCandidate {
  kind: 'payback' | 'pass-through'
  inId: string
  /** For a payback, the outgoings it covers; for a pass-through, the one payment out. */
  outIds: string[]
  confidence: MatchConfidence
  /** Days from the (last) outgoing to the money in; for a pass-through, from in to out. */
  days: number
  /** 2 for half, 3 for a third…; 1 for all of it. */
  parts: number
  /** Ordo's own words, e.g. "exactly half, 2 days later". */
  reason: string
}

/** Words that say money in is someone paying you back. */
const PAYBACK_WORDS = /\b(splitwise|pay ?back|paid back|repay|owe[ds]?|half|share|split|thanks|cheers)\b/i
/** Words that say money in is income, not a person paying you back. */
const INCOME_WORDS = /\b(salary|payroll|wages|pension|hmrc|dwp|interest|cashback|dividend|refund)\b/i

const MAX_PAYBACK_DAYS = 60
const MAX_PASS_DAYS = 3

/** Pence that `out` splits into `parts` equal shares, allowing for the odd penny. */
const shareOf = (out: number, parts: number, x: number) =>
  Math.abs(x * parts - out) <= parts - 1 || x === Math.floor(out / parts) || x === Math.ceil(out / parts)

const NICE_PARTS = [1, 2, 3, 4, 5, 6] as const
const PART_WORD: Record<number, string> = {
  1: 'all of',
  2: 'half of',
  3: 'a third of',
  4: 'a quarter of',
  5: 'a fifth of',
  6: 'a sixth of',
}

interface Options {
  /** Never suggest these (already answered "no"). Keys are `inId>outId,outId`. */
  rejected?: ReadonlySet<string>
}

/** The key a dismissed suggestion is remembered by. */
export const candidateKey = (c: Pick<MatchCandidate, 'kind' | 'inId' | 'outIds'>) =>
  `${c.kind}:${c.inId}>${[...c.outIds].sort().join(',')}`

/** Is this money in eligible to be a payback or pass-through suggestion? */
function openIn(t: Transaction, ledger: Ledger, incomeFrom: string[]): boolean {
  if (t.amount <= 0) return false
  const role = ledger.get(t.id)?.role
  if (role && role !== 'income') return false
  if (INCOME_WORDS.test(t.description)) return false
  const key = counterpartKey(t)
  return !incomeFrom.some((k) => k && key.startsWith(k))
}

/** Outgoings that are still plain spending (not transfers, held money, pass-throughs or ignored). */
const openOut = (t: Transaction, ledger: Ledger) => t.amount < 0 && ledger.get(t.id)?.role === 'spend'

const better = (a: MatchCandidate, b: MatchCandidate) =>
  CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence] ||
  a.days - b.days ||
  a.outIds.length - b.outIds.length

/**
 * Candidate matches, one per money-in at most, best first. A pass-through is money in followed
 * within 3 days by the same amount out to someone else. A payback is money in that is exactly all,
 * half, a third… of one outgoing (or of two or three close together) from up to 60 days before.
 * Confidence: `exact` for an exact share within two weeks with a payback word or a known person,
 * or a same-day pass-through; `likely` for an exact share within a month; `check` for the rest.
 */
export function findMatches(
  transactions: readonly Transaction[],
  ledger: Ledger,
  facts: readonly MoneyFact[],
  opts: Options = {},
): MatchCandidate[] {
  const confirmed = new Set([
    ...factsOf(facts, 'payback').map((f) => f.inId),
    ...factsOf(facts, 'pass-through').map((f) => f.inId),
  ])
  const incomeFrom = factsOf(facts, 'income').map((f) => merchantKey(f.from))
  const people = factsOf(facts, 'person').flatMap((p) => [p.name, ...p.aliases])
  const known = (t: Transaction) => {
    const key = counterpartKey(t)
    return people.some((n) => {
      const k = merchantKey(n)
      return k.length >= 3 && key.startsWith(k)
    })
  }
  const ins = transactions.filter((t) => !confirmed.has(t.id) && openIn(t, ledger, incomeFrom))
  const outs = transactions.filter((t) => openOut(t, ledger)).sort((a, b) => a.date.localeCompare(b.date))
  const rejected = opts.rejected ?? new Set<string>()
  const usedPassOuts = new Set<string>()
  const out: MatchCandidate[] = []

  for (const inn of [...ins].sort((a, b) => a.date.localeCompare(b.date))) {
    const options: MatchCandidate[] = []
    const keep = (c: MatchCandidate) => {
      if (!rejected.has(candidateKey(c))) options.push(c)
    }

    // Passing through: the same amount straight back out to someone else.
    for (const o of outs) {
      if (usedPassOuts.has(o.id) || -o.amount !== inn.amount) continue
      const days = daysBetween(inn.date, o.date)
      if (days < 0 || days > MAX_PASS_DAYS || counterpartKey(o) === counterpartKey(inn)) continue
      keep({
        kind: 'pass-through',
        inId: inn.id,
        outIds: [o.id],
        confidence: days === 0 ? 'exact' : days === 1 ? 'likely' : 'check',
        days,
        parts: 1,
        reason:
          days === 0
            ? `went out again the same day to ${counterpartName(o)}`
            : `went out again ${days} day${days === 1 ? '' : 's'} later to ${counterpartName(o)}`,
      })
    }

    // Paying you back: a clean share of one outgoing, or of two or three close together.
    const before = outs.filter((o) => {
      const d = daysBetween(o.date, inn.date)
      return d >= 0 && d <= MAX_PAYBACK_DAYS && counterpartKey(o) !== counterpartKey(inn)
    })
    const cue = PAYBACK_WORDS.test(inn.description) || known(inn)
    const groups: Transaction[][] = before.map((o) => [o])
    // Small groups of outgoings within 3 days of each other (Halloween supplies from two shops).
    const recent = before.slice(-12)
    for (let i = 0; i < recent.length; i++)
      for (let j = i + 1; j < recent.length; j++) {
        if (daysBetween(recent[i]!.date, recent[j]!.date) > 3) continue
        groups.push([recent[i]!, recent[j]!])
        for (let k = j + 1; k < recent.length; k++)
          if (daysBetween(recent[i]!.date, recent[k]!.date) <= 3)
            groups.push([recent[i]!, recent[j]!, recent[k]!])
      }
    for (const g of groups) {
      const total = g.reduce((n, o) => n - o.amount, 0)
      const last = g[g.length - 1]!
      const days = daysBetween(last.date, inn.date)
      for (const parts of NICE_PARTS) {
        // Paying back all of one payment from someone else is common; all of a group much less so.
        if (parts === 1 && (g.length > 1 || !cue)) continue
        // Thirds and quarters are common; fifths and sixths need a reason to believe them.
        if (parts >= 3 && parts <= 4 && days > 30 && !cue) continue
        if (parts >= 5 && (days > 30 || !cue)) continue
        if (!shareOf(total, parts, inn.amount)) continue
        const confidence: MatchConfidence =
          days <= 14 && cue && g.length === 1
            ? 'exact'
            : days <= 30 && (cue || g.length === 1)
              ? 'likely'
              : 'check'
        const what =
          g.length === 1
            ? `${counterpartName(last)} (${formatPence(total)}, ${shortDate(last.date)})`
            : `${g.length} payments totalling ${formatPence(total)}`
        keep({
          kind: 'payback',
          inId: inn.id,
          outIds: g.map((o) => o.id),
          confidence,
          days,
          parts,
          reason: `${PART_WORD[parts]} ${what}, ${days === 0 ? 'the same day' : `${days} day${days === 1 ? '' : 's'} later`}`,
        })
        break
      }
    }
    // Roughly half (within 1%) of one payment: split costs that didn't divide evenly (Ryanair).
    if (!options.some((c) => c.kind === 'payback'))
      for (const o of before) {
        const half = -o.amount / 2
        if (Math.abs(inn.amount - half) > half * 0.01) continue
        const days = daysBetween(o.date, inn.date)
        keep({
          kind: 'payback',
          inId: inn.id,
          outIds: [o.id],
          confidence: days <= 14 || (days <= 30 && cue) ? 'likely' : 'check',
          days,
          parts: 2,
          reason: `about half of ${counterpartName(o)} (${formatPence(-o.amount)}, ${shortDate(o.date)})`,
        })
      }

    const best = options.sort(better)[0]
    if (!best) continue
    if (best.kind === 'pass-through') usedPassOuts.add(best.outIds[0]!)
    out.push(best)
  }
  return out.sort(better)
}

/** Your share of one outgoing once paybacks are taken off: Ryanair £297.77, Amelie paid £148.80, yours £148.97. */
export function shareAfterPaybacks(
  outId: string,
  transactions: readonly Transaction[],
  facts: readonly MoneyFact[],
): { paid: number; paidBack: number; yours: number } | null {
  const byId = new Map(transactions.map((t) => [t.id, t]))
  const o = byId.get(outId)
  if (!o || o.amount >= 0) return null
  let paidBack = 0
  for (const p of factsOf(facts, 'payback')) {
    if (!p.outIds.includes(outId)) continue
    const inn = byId.get(p.inId)
    if (!inn) continue
    // A payback for several outgoings is shared between them in proportion to their size.
    const total = p.outIds.reduce((n, id) => n - (byId.get(id)?.amount ?? 0), 0)
    paidBack += total > 0 ? Math.round((inn.amount * -o.amount) / total) : 0
  }
  return { paid: -o.amount, paidBack, yours: -o.amount - paidBack }
}
