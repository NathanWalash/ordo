// What each transaction really is, once your saved facts are applied: your spending, your income,
// a payback, money passing through, money held for someone else, or a transfer between your own
// accounts. Only confirmed facts change anything; suggestions never do.

import { aliasesFor, factsOf, involves, type MoneyFact } from './memory'
import type { Transaction } from './types'

export type LedgerRole =
  'spend' | 'income' | 'own-transfer' | 'payback' | 'pass-through' | 'held-in' | 'held-out' | 'ignored'

export interface LedgerEntry {
  role: LedgerRole
  /** Pence of this payment that is your own spending (positive). */
  spend: number
  /** Pence of this payment that is your own income (positive). */
  income: number
  /** For a payback: pence that came back to you. */
  reimbursed: number
  /** For `held-in` and `held-out`: the held fact's id. */
  factId?: string
}

export type Ledger = Map<string, LedgerEntry>

const entry = (role: LedgerRole, o: Partial<LedgerEntry> = {}): LedgerEntry => ({
  role,
  spend: 0,
  income: 0,
  reimbursed: 0,
  ...o,
})

const byDate = (a: Transaction, b: Transaction) =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : a.amount - b.amount

/**
 * Classify every transaction. Order of precedence: things you said to ignore, transfers between
 * your own accounts, pass-throughs, money held for someone, paybacks, then plain spending and income.
 * Held money is worked out in date order: paying the person it's for uses up what you hold first,
 * and only the rest of that payment is your spending.
 */
export function buildLedger(transactions: readonly Transaction[], facts: readonly MoneyFact[]): Ledger {
  const ledger: Ledger = new Map()
  const ignored = new Set(factsOf(facts, 'ignore').flatMap((f) => f.transactionIds))
  const passing = new Set(factsOf(facts, 'pass-through').flatMap((f) => [f.inId, f.outId]))
  const paybacks = new Set(factsOf(facts, 'payback').map((f) => f.inId))

  for (const t of transactions) {
    if (ignored.has(t.id)) ledger.set(t.id, entry('ignored'))
    else if (t.transferWith) ledger.set(t.id, entry('own-transfer'))
    else if (passing.has(t.id)) ledger.set(t.id, entry('pass-through'))
  }

  // Held money, oldest first so a payment out can only use what had already come in.
  const sorted = [...transactions].sort(byDate)
  for (const rule of factsOf(facts, 'held')) {
    const fromAliases = aliasesFor(facts, rule.from)
    const forAliases = aliasesFor(facts, rule.forPerson)
    let holding = 0
    for (const t of sorted) {
      if (ledger.has(t.id) || (rule.since && t.date < rule.since)) continue
      if (t.amount > 0 && involves(t, rule.from, fromAliases)) {
        holding += t.amount
        ledger.set(t.id, entry('held-in', { factId: rule.id }))
      } else if (t.amount < 0 && holding > 0 && involves(t, rule.forPerson, forAliases)) {
        const passed = Math.min(holding, -t.amount)
        holding -= passed
        ledger.set(t.id, entry('held-out', { factId: rule.id, spend: -t.amount - passed }))
      }
    }
  }

  for (const t of transactions) {
    if (ledger.has(t.id)) continue
    if (t.amount > 0 && paybacks.has(t.id)) ledger.set(t.id, entry('payback', { reimbursed: t.amount }))
    else if (t.amount < 0) ledger.set(t.id, entry('spend', { spend: -t.amount }))
    else ledger.set(t.id, entry('income', { income: t.amount }))
  }
  return ledger
}

/** Your own spending in a set of transactions, and what was paid back to you in it. */
export function totals(transactions: readonly Transaction[], ledger: Ledger) {
  let spend = 0
  let income = 0
  let reimbursed = 0
  for (const t of transactions) {
    const e = ledger.get(t.id)
    if (!e) continue
    spend += e.spend
    income += e.income
    reimbursed += e.reimbursed
  }
  return { spend, income, reimbursed }
}
