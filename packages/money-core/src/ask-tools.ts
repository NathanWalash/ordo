// The query functions a model may call when you Ask Ordo about your money. Each takes checked
// arguments and returns plain JSON worked out by Ordo: every total, share and difference is
// computed here, in whole pence, so the model never does the maths. Amount fields end in `Pence`.

import { z } from 'zod'
import { accountCaveats, periodCaveats } from './caveats'
import { compareMonthToDate, spendBetween, type PeriodSpend } from './compare'
import { isISODate, toISODate, type ISODate } from './dates'
import { describeFacts } from './describe'
import { allEventCosts, eventCost, type EventCost } from './events'
import { buildLedger, type Ledger } from './ledger'
import { counterparts, heldBalances, owedToYou } from './loose-ends'
import { counterpartName, factsOf, involves, paybackFacts, type MoneyFact } from './memory'
import { findMatches, shareAfterPaybacks } from './paybacks'
import type { Transaction } from './types'

export interface ToolContext {
  transactions: readonly Transaction[]
  facts: readonly MoneyFact[]
  today?: ISODate
  /** Questions answered "no", so their matches aren't suggested again. */
  dismissed?: ReadonlySet<string>
}

const date = z.string().refine(isISODate, 'Use YYYY-MM-DD')
/** Any category, including a bank's own (Monzo's Home). */
const category = z.string().trim().min(1).max(40)
const account = z.string().max(60)
const shortText = z.string().max(60)

export const TOOL_ARGS = {
  find_transactions: z.strictObject({
    text: shortText.optional(),
    from: date.optional(),
    to: date.optional(),
    account: account.optional(),
    direction: z.enum(['in', 'out']).optional(),
    category: category.optional(),
    minPence: z.number().int().min(0).optional(),
    maxPence: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  spending: z.strictObject({
    from: date,
    to: date,
    category: category.optional(),
    account: account.optional(),
  }),
  compare_months: z.strictObject({ category: category.optional(), account: account.optional() }),
  events: z.strictObject({}),
  event_cost: z.strictObject({ id: z.string().max(100).optional(), name: shortText.optional() }),
  matches: z.strictObject({ from: date.optional(), to: date.optional() }),
  share_of: z.strictObject({ id: z.string().max(100) }),
  loose_ends: z.strictObject({}),
  people: z.strictObject({}),
  facts: z.strictObject({}),
  caveats: z.strictObject({}),
} as const

export type ToolName = keyof typeof TOOL_ARGS
export const TOOL_NAMES = Object.keys(TOOL_ARGS) as ToolName[]

/** What each tool does, as shown to the model. */
export const TOOL_HELP: Record<ToolName, string> = {
  find_transactions:
    'Search transactions. Args: text (a name or word), from, to (YYYY-MM-DD), account, direction ("in"/"out"), category, minPence, maxPence, limit (≤50). Returns totals and the matching rows, newest first.',
  spending:
    'Your own spending between two days, net of paybacks, by category. Args: from, to, category?, account?. Excludes transfers between your accounts, money held for others, pass-throughs and ignored payments.',
  compare_months: 'This month so far against last month to the same day. Args: category?, account?.',
  events: 'Saved events and trips with paid out, paid back and net cost. No args.',
  event_cost:
    'One event or trip in full: outgoings, paybacks, net, by category and by account. Args: id or name.',
  matches:
    'Paybacks and pass-throughs: the confirmed ones, and suggestions with how sure Ordo is (exact, likely or check). Args: from?, to?.',
  share_of: 'Your share of one outgoing after confirmed paybacks. Args: id (a transaction id).',
  loose_ends: 'Money you hold for others that has not gone on yet, and money people still owe you. No args.',
  people: 'People you pay back and forth with: sent, received and net. No args.',
  facts: 'Everything the user has told Ordo, as sentences with ids. No args.',
  caveats: 'How each account dates its payments (posting date or real date). No args.',
}

/** Ordo's words for what a step looked at, shown under an answer. */
export const TOOL_LABEL: Record<ToolName, string> = {
  find_transactions: 'Searched transactions',
  spending: 'Added up spending',
  compare_months: 'Compared with last month',
  events: 'Listed events',
  event_cost: 'Worked out an event',
  matches: 'Checked paybacks',
  share_of: 'Worked out a share',
  loose_ends: 'Checked loose ends',
  people: 'Looked at people',
  facts: 'Read what you’ve told Ordo',
  caveats: 'Checked how banks date payments',
}

const period = (p: PeriodSpend) => ({
  from: p.from,
  to: p.to,
  spentPence: p.spent,
  paidBackPence: p.paidBack,
  netPence: p.net,
  byCategory: p.byCategory.map((c) => ({ category: c.category, amountPence: c.amount })),
})

function eventView(e: EventCost, full: boolean) {
  const base = {
    id: e.id,
    name: e.name,
    from: e.from ?? null,
    to: e.to ?? null,
    paidOutPence: e.paidOut,
    paidBackPence: e.paidBack,
    netPence: e.net,
  }
  if (!full) return base
  return {
    ...base,
    byCategory: e.byCategory.map((c) => ({ category: c.category, amountPence: c.amount })),
    byAccount: e.byAccount.map((a) => ({ account: a.account, amountPence: a.amount })),
    outgoings: e.outgoings.slice(0, 40).map((l) => ({
      id: l.id,
      date: l.date,
      account: l.account,
      name: l.name,
      amountPence: l.amount,
      category: l.category,
    })),
    paybacks: e.paybacks.map((l) => ({
      id: l.id,
      date: l.date,
      name: l.name,
      person: l.person ?? null,
      amountPence: l.amount,
    })),
    leftOut: e.excluded,
  }
}

/** The tools, bound to your data. Arguments are checked by the caller with TOOL_ARGS. */
export function moneyTools(ctx: ToolContext) {
  const today = ctx.today ?? toISODate()
  const { transactions, facts } = ctx
  const ledger: Ledger = buildLedger(transactions, facts)
  const byId = new Map(transactions.map((t) => [t.id, t]))
  const caveats = accountCaveats(transactions, facts)
  const row = (t: Transaction) => ({
    id: t.id,
    date: t.date,
    account: t.accountName,
    name: counterpartName(t),
    amountPence: t.amount,
    category: t.category ?? 'Other',
    role: ledger.get(t.id)?.role ?? 'spend',
  })
  const findEvent = (a: { id?: string; name?: string }) => {
    const events = factsOf(facts, 'event')
    return (
      events.find((e) => e.id === a.id) ??
      (a.name
        ? (events.find((e) => e.name.toLowerCase() === a.name!.toLowerCase()) ??
          events.find((e) => e.name.toLowerCase().includes(a.name!.toLowerCase())))
        : undefined)
    )
  }

  const tools: { [K in ToolName]: (args: z.output<(typeof TOOL_ARGS)[K]>) => unknown } = {
    find_transactions: (a) => {
      const text = a.text?.toLowerCase()
      const found = transactions
        .filter(
          (t) =>
            (!text ||
              t.description.toLowerCase().includes(text) ||
              (t.merchant ?? '').toLowerCase().includes(text) ||
              involves(t, a.text!)) &&
            (!a.from || t.date >= a.from) &&
            (!a.to || t.date <= a.to) &&
            (!a.account || t.accountName.toLowerCase() === a.account.toLowerCase()) &&
            (!a.direction || (a.direction === 'in' ? t.amount > 0 : t.amount < 0)) &&
            (!a.category || (t.category ?? 'Other').toLowerCase() === a.category.toLowerCase()) &&
            (a.minPence === undefined || Math.abs(t.amount) >= a.minPence) &&
            (a.maxPence === undefined || Math.abs(t.amount) <= a.maxPence),
        )
        .sort((x, y) => y.date.localeCompare(x.date))
      return {
        total: found.length,
        shown: Math.min(found.length, a.limit),
        totalInPence: found.reduce((n, t) => n + Math.max(0, t.amount), 0),
        totalOutPence: found.reduce((n, t) => n + Math.max(0, -t.amount), 0),
        items: found.slice(0, a.limit).map(row),
      }
    },
    spending: (a) => ({
      ...period(spendBetween(transactions, ledger, facts, a.from, a.to, a)),
      caveats: periodCaveats(caveats, a.to, a.account),
    }),
    compare_months: (a) => {
      const c = compareMonthToDate(transactions, ledger, facts, {
        ...a,
        today,
        caveats: periodCaveats(caveats, today, a.account),
      })
      return {
        category: c.category,
        account: c.account,
        thisMonth: period(c.thisMonth),
        lastMonth: period(c.lastMonth),
        differencePence: c.difference,
        caveats: c.caveats,
      }
    },
    events: () => ({ events: allEventCosts(transactions, ledger, facts).map((e) => eventView(e, false)) }),
    event_cost: (a) => {
      const e = findEvent(a)
      if (!e) return { error: 'No saved event has that id or name. Call events to list them.' }
      return eventView(eventCost(e, transactions, ledger, facts), true)
    },
    matches: (a) => {
      const inRange = (id: string) => {
        const t = byId.get(id)
        return !!t && (!a.from || t.date >= a.from) && (!a.to || t.date <= a.to)
      }
      const confirmed = [
        ...paybackFacts(facts).map((p) => ({
          kind: 'payback',
          inId: p.inId,
          outIds: p.outIds,
          eventId: p.eventId ?? null,
        })),
        ...factsOf(facts, 'pass-through').map((p) => ({
          kind: 'pass-through',
          inId: p.inId,
          outIds: [p.outId],
          eventId: null,
        })),
      ]
        .filter((m) => inRange(m.inId))
        .map((m) => ({
          ...m,
          inName: counterpartName(byId.get(m.inId)!),
          inDate: byId.get(m.inId)!.date,
          inPence: byId.get(m.inId)!.amount,
        }))
      const suggested = findMatches(transactions, ledger, facts, { rejected: ctx.dismissed })
        .filter((m) => inRange(m.inId))
        .slice(0, 30)
        .map((m) => ({
          kind: m.kind,
          confidence: m.confidence,
          inId: m.inId,
          inName: counterpartName(byId.get(m.inId)!),
          inDate: byId.get(m.inId)!.date,
          inPence: byId.get(m.inId)!.amount,
          outIds: m.outIds,
          outPence: m.outIds.reduce((n, id) => n - (byId.get(id)?.amount ?? 0), 0),
          reason: m.reason,
        }))
      return { confirmed, suggested }
    },
    share_of: (a) => {
      const s = shareAfterPaybacks(a.id, transactions, facts, ledger)
      if (!s) return { error: 'That is not an outgoing transaction id.' }
      const t = byId.get(a.id)!
      return {
        id: a.id,
        name: counterpartName(t),
        date: t.date,
        paidPence: s.paid,
        paidBackPence: s.paidBack,
        yoursPence: s.yours,
      }
    },
    loose_ends: () => ({
      held: heldBalances(transactions, ledger, facts).map((h) => ({
        from: h.from,
        forPerson: h.forPerson,
        what: h.what,
        receivedPence: h.received,
        passedOnPence: h.passedOn,
        holdingPence: h.holding,
        lastIn: h.lastIn ?? null,
        lastOut: h.lastOut ?? null,
      })),
      owed: owedToYou(transactions, facts, ledger).map((o) => ({
        person: o.person,
        amountPence: o.amount,
        receivedPence: o.received,
        outstandingPence: o.outstanding,
        date: o.date,
        note: o.note,
      })),
    }),
    people: () => {
      const roles = new Map(factsOf(facts, 'person').map((p) => [p.name.toLowerCase(), p.role]))
      return {
        people: counterparts(transactions, ledger)
          .slice(0, 40)
          .map((c) => ({
            name: c.name,
            role: roles.get(c.name.toLowerCase()) ?? null,
            sentPence: c.sent,
            receivedPence: c.received,
            netPence: c.net,
            payments: c.payments,
            lastDate: c.lastDate,
          })),
      }
    },
    facts: () => ({
      facts: describeFacts(facts, transactions).map((f) => ({ id: f.id, kind: f.kind, summary: f.summary })),
    }),
    caveats: () => ({
      accounts: caveats.map((c) => ({
        account: c.account,
        dates: c.dates,
        note: c.text,
        lastDate: c.lastDate ?? null,
      })),
    }),
  }

  /** Run a tool with unchecked arguments. Bad arguments come back as an error result, not a throw. */
  return function run(name: ToolName, rawArgs: unknown): unknown {
    const parsed = TOOL_ARGS[name].safeParse(rawArgs ?? {})
    if (!parsed.success)
      return {
        error: `Bad arguments: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.') || '(args)'} ${i.message}`)
          .join('; ')}`,
      }
    return (tools[name] as (a: unknown) => unknown)(parsed.data)
  }
}
