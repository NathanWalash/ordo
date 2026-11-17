// Find subscriptions and bills in bank transactions: the same merchant, a similar
// amount, on a weekly, monthly or yearly rhythm.

import { addDays, daysBetween, nextOnOrAfter, toISODate, type Cadence, type ISODate } from './dates'
import { merchantKey, normaliseMerchant } from './merchant'
import type { RecurringCandidate, Transaction } from './types'

/** Allowed gap between payments for each cadence, in days. */
const WINDOWS: Record<Cadence, [number, number]> = {
  weekly: [5, 9],
  monthly: [25, 36],
  yearly: [350, 380],
}

/** How many payments make a cadence convincing. */
const ENOUGH: Record<Cadence, number> = { weekly: 6, monthly: 4, yearly: 2 }
const MINIMUM: Record<Cadence, number> = { weekly: 3, monthly: 2, yearly: 2 }

/** Amounts within this fraction of each other count as "the same" (allows price rises). */
const AMOUNT_TOLERANCE = 0.25

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2)
}

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(AMOUNT_TOLERANCE * Math.max(a, b), 50)

/** Split one merchant's payments into groups of similar amounts (two Apple subscriptions, say). */
function clusterByAmount(txs: Transaction[]): Transaction[][] {
  const clusters: Transaction[][] = []
  for (const t of [...txs].sort((a, b) => -a.amount - -b.amount)) {
    const amt = -t.amount
    const home = clusters.find((c) => close(median(c.map((x) => -x.amount)), amt))
    if (home) home.push(t)
    else clusters.push([t])
  }
  return clusters
}

function cadenceOf(gaps: number[]): { cadence: Cadence; regular: number } | null {
  if (!gaps.length) return null
  const m = median(gaps)
  for (const cadence of ['weekly', 'monthly', 'yearly'] as const) {
    const [lo, hi] = WINDOWS[cadence]
    if (m < lo || m > hi) continue
    // A missed month shows up as a double gap; don't let it sink an otherwise regular run.
    const fits = gaps.filter((g) => (g >= lo && g <= hi) || (g >= 2 * lo && g <= 2 * hi)).length
    return { cadence, regular: fits / gaps.length }
  }
  return null
}

const maxDate = (a: ISODate, b: ISODate) => (a > b ? a : b)
const round2 = (x: number) => Math.round(x * 100) / 100

/**
 * Recurring outgoing payments, most confident first. `today` rolls `nextDue` forward
 * past dates that have already gone.
 */
export function detectRecurring(
  transactions: Transaction[],
  today: ISODate = toISODate(),
): RecurringCandidate[] {
  const byMerchant = new Map<string, Transaction[]>()
  for (const t of transactions) {
    if (t.amount >= 0) continue
    const key = merchantKey(t.merchant ?? normaliseMerchant(t.description))
    if (!key) continue
    const list = byMerchant.get(key) ?? []
    list.push(t)
    byMerchant.set(key, list)
  }

  const out: RecurringCandidate[] = []
  for (const [key, txs] of byMerchant) {
    const merchantRuns: RecurringCandidate[] = []
    for (const cluster of clusterByAmount(txs)) {
      // Several payments on one day (split orders) count once.
      const byDate = new Map<ISODate, Transaction>()
      for (const t of cluster.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)))
        byDate.set(t.date, t)
      const run = [...byDate.values()]
      if (run.length < 2) continue
      const gaps = run.slice(1).map((t, i) => daysBetween(run[i]!.date, t.date))
      const found = cadenceOf(gaps)
      if (!found || found.regular < 0.6 || run.length < MINIMUM[found.cadence]) continue

      const amounts = run.map((t) => -t.amount)
      const last = run[run.length - 1]!
      const latest = -last.amount
      // The last time the amount changed, if it went up.
      let change = run.length - 1
      while (change > 0 && -run[change - 1]!.amount === latest) change--
      const previous = change > 0 ? -run[change - 1]!.amount : latest
      const typical = median(amounts)
      const steady = amounts.filter((a) => Math.abs(a - typical) <= typical * 0.05).length / amounts.length
      const enough = Math.min(1, run.length / ENOUGH[found.cadence])
      const confidence = round2(found.regular * 0.5 + enough * 0.3 + steady * 0.2)

      merchantRuns.push({
        id: key,
        merchant: last.merchant ?? normaliseMerchant(last.description),
        key,
        cadence: found.cadence,
        typicalAmount: latest,
        lastDate: last.date,
        nextDue: nextOnOrAfter(last.date, found.cadence, maxDate(today, addDays(last.date, 1))),
        confidence,
        transactionIds: run.map((t) => t.id),
        ...(latest > previous && { priceIncrease: { from: previous, to: latest, date: run[change]!.date } }),
      })
    }
    // Two subscriptions with one merchant (Apple, say) need distinct ids.
    for (const c of merchantRuns)
      out.push(merchantRuns.length > 1 ? { ...c, id: `${key}~${c.typicalAmount}` } : c)
  }
  return out.sort((a, b) => b.confidence - a.confidence || a.merchant.localeCompare(b.merchant))
}
