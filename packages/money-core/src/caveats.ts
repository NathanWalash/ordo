// What the numbers can't see. Some banks list the day a payment cleared (posting date), not the
// day you paid, so the last few days of a period can be missing or land in the next one.

import { daysBetween, type ISODate } from './dates'
import { factsOf, shortDate, type MoneyFact } from './memory'
import type { Transaction } from './types'

export type DateKind = 'posting' | 'transaction' | 'unknown'

export interface AccountCaveat {
  account: string
  dates: DateKind
  /** Whether you told Ordo, or it assumed from the bank's name. */
  from: 'you' | 'bank'
  text: string
  /** The latest transaction imported for this account. */
  lastDate?: ISODate
}

/** Banks whose exports show when a payment cleared. */
const POSTING = /\b(hsbc|barclays|lloyds|natwest|nationwide|santander|halifax|tsb|rbs|first direct|co-?op)\b/i
/** Banks whose exports show when you actually paid. */
const REAL = /\b(monzo|starling|revolut|chase|kroo|curve)\b/i

function bankName(account: string): string {
  return (POSTING.exec(account) ?? REAL.exec(account))?.[1] ?? account
}

/** How each account dates its payments, and what that means for totals. */
export function accountCaveats(
  transactions: readonly Transaction[],
  facts: readonly MoneyFact[],
): AccountCaveat[] {
  const accounts = new Map<string, ISODate>()
  for (const t of transactions)
    if (!accounts.has(t.accountName) || t.date > accounts.get(t.accountName)!)
      accounts.set(t.accountName, t.date)
  const told = new Map(factsOf(facts, 'account').map((f) => [f.account.toLowerCase(), f.dates]))
  return [...accounts]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([account, lastDate]) => {
      const mine = told.get(account.toLowerCase())
      const dates: DateKind =
        mine ?? (POSTING.test(account) ? 'posting' : REAL.test(account) ? 'transaction' : 'unknown')
      const name = bankName(account)
      const text =
        dates === 'posting'
          ? `${name} shows the day a payment cleared, often a day or three after you paid.`
          : dates === 'transaction'
            ? `${name} shows the day you actually paid.`
            : `Ordo doesn't know whether ${name} shows the day you paid or the day it cleared.`
      return { account, dates, from: mine ? ('you' as const) : ('bank' as const), text, lastDate }
    })
}

/**
 * Notes for a period ending on `to`: posting-date accounts may not have caught up with the last
 * few days, and an account whose statement stops before `to` is missing the rest.
 */
export function periodCaveats(caveats: readonly AccountCaveat[], to: ISODate, account?: string): string[] {
  const notes: string[] = []
  for (const c of caveats) {
    if (account && c.account !== account) continue
    const name = bankName(c.account)
    if (c.lastDate && c.lastDate < to && daysBetween(c.lastDate, to) > 3)
      notes.push(
        `${c.account}'s statement stops on ${shortDate(c.lastDate)}, so anything after that isn't counted.`,
      )
    else if (c.dates === 'posting')
      notes.push(`${name} shows posting dates, so the last few days may not be in yet.`)
  }
  return notes
}
