// Splitting bills between flatmates, all in whole pence. Every allocation adds up to
// exactly the total; leftover pennies are handed out in a fixed order.

import { formatPence } from './amount'
import { cyclesBetween, lastOnOrBefore, toISODate, type ISODate } from './dates'
import { merchantKey, sameMerchant } from './merchant'
import type {
  Allocation,
  Charge,
  Debt,
  Person,
  Settlement,
  Split,
  SplitShare,
  StoredBill,
  Transaction,
} from './types'

/** 100% in basis points. */
export const WHOLE = 10_000

/**
 * The order leftover pennies are handed out in: whoever paid first (they've already
 * covered the total, so the odd penny stays with them), then everyone else by id.
 * Independent of the order shares are listed in.
 */
function pennyOrder(shares: SplitShare[], paidBy: string): SplitShare[] {
  return [...shares].sort((a, b) =>
    a.personId === paidBy
      ? -1
      : b.personId === paidBy
        ? 1
        : a.personId < b.personId
          ? -1
          : a.personId > b.personId
            ? 1
            : 0,
  )
}

/** Share `total` in proportion to `weights` (largest remainder method, integer maths only). */
function proportional(total: number, ordered: SplitShare[], weight: (s: SplitShare) => number): Allocation[] {
  const sum = ordered.reduce((n, s) => n + weight(s), 0)
  if (sum <= 0) return proportional(total, ordered, () => 1)
  const rows = ordered.map((s, i) => {
    const exact = total * weight(s)
    return { personId: s.personId, amount: Math.floor(exact / sum), rem: exact % sum, i }
  })
  let left = total - rows.reduce((n, r) => n + r.amount, 0)
  for (const r of [...rows].sort((a, b) => b.rem - a.rem || a.i - b.i)) {
    if (left <= 0) break
    r.amount++
    left--
  }
  return rows.map(({ personId, amount }) => ({ personId, amount }))
}

/**
 * Each person's share of `total` pence. Equal splits give the remainder pennies to the
 * payer first, then by person id. Fixed amounts that don't match `total` (the price
 * went up since the split was set) are scaled in proportion.
 */
export function allocate(total: number, split: Pick<Split, 'mode' | 'shares' | 'paidBy'>): Allocation[] {
  if (!Number.isInteger(total) || total < 0)
    throw new Error('Total must be a whole number of pence, 0 or more')
  if (!split.shares.length) return []
  const ordered = pennyOrder(split.shares, split.paidBy)
  if (split.mode === 'equal') return proportional(total, ordered, () => 1)
  if (split.mode === 'fixed') {
    const sum = ordered.reduce((n, s) => n + s.value, 0)
    if (sum === total) return ordered.map((s) => ({ personId: s.personId, amount: s.value }))
  }
  return proportional(total, ordered, (s) => s.value)
}

/** Why a split can't be saved, or null when it's fine. */
export function validateSplit(
  split: Pick<Split, 'mode' | 'shares' | 'paidBy'>,
  total: number,
  people: Person[],
): string | null {
  const known = new Set(people.map((p) => p.id))
  if (!known.has(split.paidBy)) return 'Choose who pays this bill.'
  if (!split.shares.length) return 'Choose at least one person to share this bill.'
  const ids = split.shares.map((s) => s.personId)
  if (new Set(ids).size !== ids.length) return 'Each person can only appear once.'
  if (ids.some((id) => !known.has(id))) return 'That person no longer exists.'
  if (split.mode === 'equal') return null
  if (split.shares.some((s) => !Number.isInteger(s.value) || s.value < 0))
    return split.mode === 'fixed'
      ? 'Amounts must be whole pence, 0 or more.'
      : 'Percentages must be 0 or more.'
  const sum = split.shares.reduce((n, s) => n + s.value, 0)
  if (split.mode === 'fixed' && sum !== total)
    return `Shares add up to ${formatPence(sum)}, but the bill is ${formatPence(total)}.`
  if (split.mode === 'percent' && sum !== WHOLE) return `Percentages add up to ${sum / 100}%, not 100%.`
  return null
}

/**
 * When a new split starts counting. For bills paid from the bank: the latest matching
 * payment. For other bills: the latest due date that has passed, or the first due date
 * when that's still to come.
 */
export function splitStartDate(
  bill: StoredBill,
  transactions: Transaction[],
  today: ISODate = toISODate(),
): ISODate {
  const paid = bankPayments(bill, transactions)
  if (paid.length) return paid[paid.length - 1]!.date
  if (bill.anchorDate > today) return bill.anchorDate
  return lastOnOrBefore(bill.anchorDate, bill.cadence, today)
}

function bankPayments(bill: StoredBill, transactions: Transaction[]): Transaction[] {
  if (!bill.merchantKey || bill.source === 'manual' || bill.source === 'email') return []
  return transactions
    .filter(
      (t) =>
        t.amount < 0 &&
        sameMerchant(merchantKey(t.merchant ?? ''), bill.merchantKey!) &&
        Math.abs(-t.amount - bill.amount) <= Math.max(-t.amount, bill.amount) * 0.3,
    )
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

/**
 * Every cycle of a split bill up to `today`: each bank payment since the split started
 * (using what was actually paid), or each due date for bills without bank payments.
 * Stops at the date a bill was cancelled.
 */
export function billCharges(
  bill: StoredBill,
  split: Split,
  transactions: Transaction[],
  today: ISODate = toISODate(),
): Charge[] {
  const until = bill.cancelledOn && bill.cancelledOn < today ? bill.cancelledOn : today
  const charge = (date: ISODate, amount: number, transactionId?: string): Charge => ({
    billId: bill.id,
    date,
    amount,
    paidBy: split.paidBy,
    shares: allocate(amount, split),
    ...(transactionId && { transactionId }),
  })
  const paid = bankPayments(bill, transactions)
  if (paid.length)
    return paid
      .filter((t) => t.date >= split.since && t.date <= until)
      .map((t) => charge(t.date, -t.amount, t.id))
  if (split.since > until) return []
  return cyclesBetween(bill.anchorDate, bill.cadence, split.since, until).map((d) => charge(d, bill.amount))
}

/**
 * Net position per person: positive means others owe them, negative means they owe.
 * Settlements (`from` paid `to`) move money back the other way. Always sums to zero.
 */
export function netBalances(charges: Charge[], settlements: Settlement[]): Map<string, number> {
  const net = new Map<string, number>()
  const add = (id: string, n: number) => net.set(id, (net.get(id) ?? 0) + n)
  for (const c of charges)
    for (const s of c.shares) {
      if (s.personId === c.paidBy || !s.amount) continue
      add(c.paidBy, s.amount)
      add(s.personId, -s.amount)
    }
  for (const s of settlements) {
    add(s.from, s.amount)
    add(s.to, -s.amount)
  }
  return net
}

/**
 * Who should pay whom to settle everything, in as few payments as practical: the
 * biggest debtor pays the biggest creditor, repeatedly. Ties break by person id.
 */
export function simplifyDebts(net: Map<string, number>): Debt[] {
  const byAmount = (a: [string, number], b: [string, number]) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)
  const creditors = [...net].filter(([, n]) => n > 0).sort(byAmount)
  const debtors = [...net]
    .filter(([, n]) => n < 0)
    .map(([id, n]): [string, number] => [id, -n])
    .sort(byAmount)
  const debts: Debt[] = []
  while (creditors.length && debtors.length) {
    const c = creditors[0]!
    const d = debtors[0]!
    const amount = Math.min(c[1], d[1])
    debts.push({ from: d[0], to: c[0], amount })
    c[1] -= amount
    d[1] -= amount
    if (!c[1]) creditors.shift()
    if (!d[1]) debtors.shift()
    creditors.sort(byAmount)
    debtors.sort(byAmount)
  }
  return debts
}

/** Everything owed between people across every split bill, simplified. */
export function balances(input: {
  bills: StoredBill[]
  splits: Split[]
  transactions: Transaction[]
  settlements: Settlement[]
  today?: ISODate
}): { charges: Charge[]; net: Map<string, number>; debts: Debt[] } {
  const bills = new Map(input.bills.map((b) => [b.id, b]))
  const charges = input.splits.flatMap((s) => {
    const bill = bills.get(s.billId)
    return bill ? billCharges(bill, s, input.transactions, input.today) : []
  })
  const net = netBalances(charges, input.settlements)
  return { charges, net, debts: simplifyDebts(net) }
}
