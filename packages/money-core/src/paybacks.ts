// Suggest which money in paid you back for which money out, and which money only passed through.
// All of it is arithmetic on whole pence: exact fractions, dates and a few words in descriptions.
// A suggestion changes nothing until you confirm it, when it becomes a fact.

import { formatPence } from './amount'
import { merchantKey } from './merchant'
import type { Ledger } from './ledger'
import { counterpartKey, counterpartName, factsOf, paybackFacts, shortDate, type MoneyFact } from './memory'
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
function openIn(t: Transaction, ledger: Ledger, key: string, incomeFrom: string[]): boolean {
  if (t.amount <= 0) return false
  const role = ledger.get(t.id)?.role
  if (role && role !== 'income') return false
  if (INCOME_WORDS.test(t.description)) return false
  return !incomeFrom.some((k) => k && key.startsWith(k))
}

/** Outgoings that are still plain spending (not transfers, held money, pass-throughs or ignored). */
const openOut = (t: Transaction, ledger: Ledger) => t.amount < 0 && ledger.get(t.id)?.role === 'spend'

const better = (a: MatchCandidate, b: MatchCandidate) =>
  CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence] ||
  a.days - b.days ||
  a.outIds.length - b.outIds.length

/** Days since 1970 for a `YYYY-MM-DD` date: cheap to compare and subtract. */
const dayNumber = (d: string) =>
  Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86_400_000

interface Out {
  t: Transaction
  day: number
  key: string
  /** Pence, positive. */
  amount: number
}

/** First index in `list` (sorted by day) whose day is on or after `day`. */
function firstOnOrAfter(list: readonly Out[], day: number): number {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid]!.day < day) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** "About half" may be off by at most this many pence (a split that didn't divide evenly). */
const ABOUT_HALF_PENCE = 50

/**
 * Candidate matches, one per money-in at most, best first. A pass-through is money in followed
 * within 3 days by the same amount out to someone else. A payback is money in that is exactly all,
 * half, a third… of one outgoing (or of two or three close together) from up to 60 days before.
 * Confidence: `exact` for an exact share within two weeks with a payback word or a known person,
 * or a same-day pass-through; `likely` for an exact share within a month; `check` for the rest.
 * "About half" (within 50p, for costs that didn't split evenly) is only `likely` with a payback
 * word or a known person, and `check` otherwise.
 *
 * Outgoings are indexed by amount and by date, so each money in only looks at the few outgoings
 * that could match: tens of thousands of transactions take well under a second.
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
  const people = factsOf(facts, 'person')
    .flatMap((p) => [p.name, ...p.aliases])
    .map(merchantKey)
    .filter((k) => k.length >= 3)
  const keyOf = new Map(transactions.map((t) => [t.id, counterpartKey(t)]))
  const known = (key: string) => people.some((k) => key.startsWith(k))

  const ins = transactions
    .filter((t) => !confirmed.has(t.id) && openIn(t, ledger, keyOf.get(t.id)!, incomeFrom))
    .map((t) => ({ t, day: dayNumber(t.date), key: keyOf.get(t.id)! }))
    .sort((a, b) => a.day - b.day)
  const outs: Out[] = transactions
    .filter((t) => openOut(t, ledger))
    .map((t) => ({ t, day: dayNumber(t.date), key: keyOf.get(t.id)!, amount: -t.amount }))
    .sort((a, b) => a.day - b.day)
  const byAmount = new Map<number, Out[]>()
  for (const o of outs) {
    const list = byAmount.get(o.amount)
    if (list) list.push(o)
    else byAmount.set(o.amount, [o])
  }
  /** Outgoings of exactly `amount` pence from `from` to `to` (days), oldest first. */
  function* withAmount(amount: number, from: number, to: number) {
    const list = byAmount.get(amount)
    if (!list) return
    for (let i = firstOnOrAfter(list, from); i < list.length && list[i]!.day <= to; i++) yield list[i]!
  }

  const rejected = opts.rejected ?? new Set<string>()
  const usedPassOuts = new Set<string>()
  const result: MatchCandidate[] = []

  for (const { t: inn, day, key } of ins) {
    const options: MatchCandidate[] = []
    const keep = (c: MatchCandidate) => {
      if (!rejected.has(candidateKey(c))) options.push(c)
    }
    const x = inn.amount
    const cue = PAYBACK_WORDS.test(inn.description) || known(key)
    const later = (days: number) =>
      days === 0 ? 'the same day' : `${days} day${days === 1 ? '' : 's'} later`

    // Passing through: the same amount straight back out to someone else.
    for (const o of withAmount(x, day, day + MAX_PASS_DAYS)) {
      if (usedPassOuts.has(o.t.id) || o.key === key) continue
      const days = o.day - day
      keep({
        kind: 'pass-through',
        inId: inn.id,
        outIds: [o.t.id],
        confidence: days === 0 ? 'exact' : days === 1 ? 'likely' : 'check',
        days,
        parts: 1,
        reason:
          days === 0
            ? `went out again the same day to ${counterpartName(o.t)}`
            : `went out again ${days} day${days === 1 ? '' : 's'} later to ${counterpartName(o.t)}`,
      })
    }

    /** Is a share of `parts` believable for a group of `size` outgoings `days` before? */
    const plausible = (parts: number, size: number, days: number) =>
      // Paying back all of one payment from someone else is common; all of a group much less so.
      !(parts === 1 && (size > 1 || !cue)) &&
      // Thirds and quarters are common; fifths and sixths need a reason to believe them.
      !(parts >= 3 && parts <= 4 && days > 30 && !cue) &&
      !(parts >= 5 && (days > 30 || !cue))

    const payback = (group: Out[], parts: number) => {
      const total = group.reduce((n, o) => n + o.amount, 0)
      const last = group[group.length - 1]!
      const days = day - last.day
      const confidence: MatchConfidence =
        days <= 14 && cue && group.length === 1
          ? 'exact'
          : days <= 30 && (cue || group.length === 1)
            ? 'likely'
            : 'check'
      const what =
        group.length === 1
          ? `${counterpartName(last.t)} (${formatPence(total)}, ${shortDate(last.t.date)})`
          : `${group.length} payments totalling ${formatPence(total)}`
      keep({
        kind: 'payback',
        inId: inn.id,
        outIds: group.map((o) => o.t.id),
        confidence,
        days,
        parts,
        reason: `${PART_WORD[parts]} ${what}, ${later(days)}`,
      })
    }

    // One outgoing that money in is a clean share of: only amounts within a penny or two of
    // x × parts are looked up. The smallest number of parts wins for each outgoing.
    const single = new Set<string>()
    for (const parts of NICE_PARTS)
      for (let amount = x * parts - (parts - 1); amount <= x * parts + (parts - 1); amount++)
        for (const o of withAmount(amount, day - MAX_PAYBACK_DAYS, day)) {
          if (o.key === key || single.has(o.t.id)) continue
          if (!shareOf(amount, parts, x) || !plausible(parts, 1, day - o.day)) continue
          single.add(o.t.id)
          payback([o], parts)
        }

    // Two or three outgoings within 3 days of each other (Halloween supplies from two shops),
    // among the last 12 before the money in.
    const recent: Out[] = []
    for (let i = firstOnOrAfter(outs, day + 1) - 1; i >= 0 && recent.length < 12; i--) {
      const o = outs[i]!
      if (o.day < day - MAX_PAYBACK_DAYS) break
      if (o.key !== key) recent.unshift(o)
    }
    const tryGroup = (group: Out[]) => {
      const total = group.reduce((n, o) => n + o.amount, 0)
      const days = day - group[group.length - 1]!.day
      for (const parts of NICE_PARTS) {
        if (!plausible(parts, group.length, days) || !shareOf(total, parts, x)) continue
        payback(group, parts)
        return
      }
    }
    for (let i = 0; i < recent.length; i++)
      for (let j = i + 1; j < recent.length; j++) {
        if (recent[j]!.day - recent[i]!.day > 3) continue
        tryGroup([recent[i]!, recent[j]!])
        for (let k = j + 1; k < recent.length; k++)
          if (recent[k]!.day - recent[i]!.day <= 3) tryGroup([recent[i]!, recent[j]!, recent[k]!])
      }

    // About half of one payment, within 50p: split costs that didn't divide evenly (Ryanair).
    if (!options.some((c) => c.kind === 'payback'))
      for (let amount = 2 * x - 2 * ABOUT_HALF_PENCE; amount <= 2 * x + 2 * ABOUT_HALF_PENCE; amount++)
        for (const o of withAmount(amount, day - MAX_PAYBACK_DAYS, day)) {
          if (o.key === key) continue
          const half = amount / 2
          if (Math.abs(x - half) > Math.min(ABOUT_HALF_PENCE, half * 0.01)) continue
          const days = day - o.day
          keep({
            kind: 'payback',
            inId: inn.id,
            outIds: [o.t.id],
            confidence: cue && days <= 30 ? 'likely' : 'check',
            days,
            parts: 2,
            reason: `about half of ${counterpartName(o.t)} (${formatPence(amount)}, ${shortDate(o.t.date)})`,
          })
        }

    const best = options.sort(better)[0]
    if (!best) continue
    if (best.kind === 'pass-through') usedPassOuts.add(best.outIds[0]!)
    result.push(best)
  }
  return result.sort(better)
}

/** Your share of one outgoing once paybacks are taken off: Ryanair £297.77, Amelie paid £148.80, yours £148.97. */
export function shareAfterPaybacks(
  outId: string,
  transactions: readonly Transaction[],
  facts: readonly MoneyFact[],
  ledger?: Ledger,
): { paid: number; paidBack: number; yours: number } | null {
  const byId = new Map(transactions.map((t) => [t.id, t]))
  const o = byId.get(outId)
  if (!o || o.amount >= 0) return null
  let paidBack = 0
  for (const p of paybackFacts(facts)) {
    if (!p.outIds.includes(outId)) continue
    const inn = byId.get(p.inId)
    if (!inn || (ledger && ledger.get(inn.id)?.role !== 'payback')) continue
    // A payback for several outgoings is shared between them in proportion to their size.
    const total = p.outIds.reduce((n, id) => n - (byId.get(id)?.amount ?? 0), 0)
    paidBack += total > 0 ? Math.round((inn.amount * -o.amount) / total) : 0
  }
  return { paid: -o.amount, paidBack, yours: -o.amount - paidBack }
}
