// Money moved between your own accounts shows up twice once both are imported: out of one,
// into the other. Pair those rows so "All accounts" doesn't count them as spending or income.

import type { ISODate } from './dates'
import type { Transaction } from './types'

const DAY_MS = 86_400_000
const toMs = (d: ISODate) =>
  Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)))

/** Words in account names that say nothing about which bank it is. */
const GENERIC = new Set([
  'current',
  'account',
  'savings',
  'saver',
  'joint',
  'main',
  'bank',
  'personal',
  'card',
])

/** The distinctive words of an account name: `HSBC current` → `hsbc`, `Monzo` → `monzo`. */
function accountWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !GENERIC.has(w))
}

/** Does this row's text name the other account (`Nathan Walsh Monzo BP` names Monzo)? */
function mentions(t: Transaction, account: string): boolean {
  const text = ` ${`${t.description} ${t.merchant ?? ''}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `
  return accountWords(account).some((w) => text.includes(` ${w} `))
}

/**
 * Mark transfers between your own accounts: an amount out of one account and the same amount
 * into another within `maxDays`, where one side names the other account or both are already
 * Transfers. Each row pairs at most once, with the closest date. Paired rows get `transferWith`,
 * `transferAccount` and the Transfers category, unless you chose their category yourself.
 */
export function pairOwnTransfers(transactions: Transaction[], maxDays = 3): Transaction[] {
  const used = new Set<string>()
  const pairs = new Map<string, Transaction>()
  // Money in, by amount: only the same amount can pair, so don't look at the rest (comparing
  // every payment out with every payment in made big statements slow on every page load).
  const insByAmount = new Map<number, Transaction[]>()
  for (const t of transactions)
    if (t.amount > 0) {
      const list = insByAmount.get(t.amount)
      if (list) list.push(t)
      else insByAmount.set(t.amount, [t])
    }
  const outs = transactions.filter((t) => t.amount < 0).sort((a, b) => a.date.localeCompare(b.date))
  for (const out of outs) {
    let best: Transaction | undefined
    let bestGap = Infinity
    for (const inn of insByAmount.get(-out.amount) ?? []) {
      if (used.has(inn.id) || inn.accountName === out.accountName) continue
      const gap = Math.abs(toMs(inn.date) - toMs(out.date)) / DAY_MS
      if (gap > maxDays || gap >= bestGap) continue
      const evidence =
        mentions(out, inn.accountName) ||
        mentions(inn, out.accountName) ||
        (out.category === 'Transfers' && inn.category === 'Transfers')
      if (!evidence) continue
      best = inn
      bestGap = gap
    }
    if (!best) continue
    used.add(best.id)
    pairs.set(out.id, best)
    pairs.set(best.id, out)
  }
  if (!pairs.size) return transactions
  return transactions.map((t) => {
    const other = pairs.get(t.id)
    if (!other) return t
    return {
      ...t,
      transferWith: other.id,
      transferAccount: other.accountName,
      ...(t.categorisedBy !== 'you' && {
        category: 'Transfers',
        categorisedBy: undefined,
        confidence: undefined,
      }),
    }
  })
}
