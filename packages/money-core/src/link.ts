// Join bank evidence and email evidence into bills, and merge them with what the
// person has already confirmed, added or dismissed.

import { CADENCE_DAYS, nextOnOrAfter, toISODate, type Cadence, type ISODate } from './dates'
import { hintKeys } from './email'
import { merchantKey, sameMerchant } from './merchant'
import type { Bill, DetectedBill, EmailHint, RecurringCandidate, StoredBill } from './types'

const matches = (key: string, h: EmailHint) => hintKeys(h).some((k) => sameMerchant(k, key))

/** Email alone only suggests a bill when it talks about a renewal, a trial ending or a price change. */
const STRONG = new Set<EmailHint['kind']>(['renewal', 'trial-ending', 'price-change'])

/**
 * Match email hints to recurring bank payments by merchant name or sender domain.
 * Bank payments with matching email become `both`; strong email hints with no bank
 * payment become `email`-only suggestions with an unknown amount.
 */
export function linkBills(candidates: RecurringCandidate[], hints: EmailHint[]): DetectedBill[] {
  const used = new Set<EmailHint>()
  const out: DetectedBill[] = candidates.map((c) => {
    const linked = hints.filter((h) => matches(c.key, h))
    linked.forEach((h) => used.add(h))
    return {
      key: c.id,
      merchantKey: c.key,
      name: c.merchant,
      amount: c.typicalAmount,
      cadence: c.cadence,
      nextDue: c.nextDue,
      lastPaid: c.lastDate,
      source: linked.length ? 'both' : 'bank',
      confidence: Math.min(1, Math.round((c.confidence + (linked.length ? 0.1 : 0)) * 100) / 100),
      transactionIds: c.transactionIds,
      hints: linked,
      ...(c.priceIncrease && { priceIncrease: c.priceIncrease }),
    }
  })

  const emailOnly = new Map<string, EmailHint[]>()
  for (const h of hints) {
    if (used.has(h)) continue
    const key = merchantKey(h.merchant)
    emailOnly.set(key, [...(emailOnly.get(key) ?? []), h])
  }
  for (const [key, group] of emailOnly) {
    if (!key || !group.some((h) => STRONG.has(h.kind))) continue
    const yearly = group.some((h) => /\b(annual|yearly|year)\b/i.test(h.subject))
    out.push({
      key: `email:${key}`,
      merchantKey: key,
      name: group[0]!.merchant,
      amount: null,
      cadence: yearly ? 'yearly' : 'monthly',
      nextDue: null,
      source: 'email',
      confidence: 0.4,
      transactionIds: [],
      hints: group,
    })
  }
  return out
}

/** What a bill costs per month on average, in pence. */
export function monthlyCost(amount: number, cadence: Cadence): number {
  if (cadence === 'monthly') return amount
  return Math.round((amount * 30.44) / CADENCE_DAYS[cadence])
}

const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * 0.3

function emailFlags(bill: Pick<StoredBill, 'name' | 'merchantKey'>, hints: EmailHint[]) {
  const keys = [bill.merchantKey, merchantKey(bill.name)].filter((k): k is string => !!k)
  const mine = hints.filter((h) => keys.some((k) => matches(k, h)))
  const latest = (kind: EmailHint['kind']) =>
    mine
      .filter((h) => h.kind === kind)
      .reduce<ISODate | undefined>((d, h) => (!d || h.lastSeen > d ? h.lastSeen : d), undefined)
  return { trialEnding: latest('trial-ending'), priceChangeEmail: latest('price-change') }
}

/**
 * Bills to show, and detected ones still waiting for review. Saved bills take their
 * latest amount and due date from the bank when a matching payment run exists.
 */
export function resolveBills(input: {
  stored: StoredBill[]
  detected: DetectedBill[]
  hints: EmailHint[]
  dismissed: ReadonlySet<string>
  today?: ISODate
}): { bills: Bill[]; review: DetectedBill[] } {
  const today = input.today ?? toISODate()
  const claimed = new Set<DetectedBill>()

  const bills = input.stored.map((s): Bill => {
    const run =
      s.merchantKey && s.source !== 'manual'
        ? input.detected
            .filter((d) => d.amount !== null && d.merchantKey === s.merchantKey && near(d.amount, s.amount))
            .sort((a, b) => Math.abs(a.amount! - s.amount) - Math.abs(b.amount! - s.amount))[0]
        : undefined
    if (run) claimed.add(run)
    if (s.merchantKey)
      for (const d of input.detected) if (d.amount === null && d.merchantKey === s.merchantKey) claimed.add(d)
    const flags = emailFlags(s, input.hints)
    return {
      id: s.id,
      name: s.name,
      amount: run?.amount ?? s.amount,
      cadence: run?.cadence ?? s.cadence,
      // A first due date still to come is the next one; otherwise roll the anchor forward.
      nextDue:
        run?.nextDue ??
        (s.anchorDate >= today ? s.anchorDate : nextOnOrAfter(s.anchorDate, s.cadence, today)),
      source: s.source,
      status: s.status,
      ...(s.merchantKey && { merchantKey: s.merchantKey }),
      ...(run?.lastPaid && { lastPaid: run.lastPaid }),
      ...(run?.priceIncrease && { priceIncrease: run.priceIncrease }),
      ...(flags.trialEnding && { trialEnding: flags.trialEnding }),
      ...(flags.priceChangeEmail && { priceChangeEmail: flags.priceChangeEmail }),
    }
  })

  const review = input.detected.filter((d) => !claimed.has(d) && !input.dismissed.has(d.key))
  bills.sort((a, b) =>
    a.status !== b.status ? (a.status === 'active' ? -1 : 1) : a.nextDue.localeCompare(b.nextDue),
  )
  return { bills, review }
}
