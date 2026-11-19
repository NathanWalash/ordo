// What Ordo has learned about how your money works: facts and rules you confirmed, by answering
// a question, teaching it, or saving a suggestion. Engines read these; nothing here is guessed.

import { z } from 'zod'
import { isISODate, type ISODate } from './dates'
import { merchantKey } from './merchant'
import type { Transaction } from './types'

export const PERSON_ROLES = ['flatmate', 'friend', 'family', 'partner', 'landlord', 'other'] as const
export type PersonRole = (typeof PERSON_ROLES)[number]

/** Where a fact came from. Every one of them was confirmed by you. */
export const FACT_SOURCES = ['you', 'question', 'onboarding', 'ask'] as const
export type FactSource = (typeof FACT_SOURCES)[number]

const txId = z.string().min(1).max(100)
const txIds = (max: number) => z.array(txId).max(max)
const name = z.string().trim().min(1, 'Enter a name.').max(60, 'That name is too long.')
const date = z.string().refine(isISODate, 'Choose a date.')
const pence = z.number().int().min(1).max(100_000_000_00)
const short = (max: number) => z.string().trim().max(max)

/** Someone who shows up in your statements. Flatmates also become people on Bills. */
const PersonFact = z.strictObject({
  kind: z.literal('person'),
  name,
  role: z.enum(PERSON_ROLES),
  /** Other ways their name appears in statements (`GENEST J`, `J Genest`). */
  aliases: z.array(name).max(10).default([]),
})

/**
 * An event or trip. Its outgoings are everything in `from`–`to` (when given) plus `include`, minus
 * `exclude` and any merchant in `excludeMerchants` (Ryanair for "excluding flights").
 */
const EventFact = z
  .strictObject({
    kind: z.literal('event'),
    name,
    from: date.optional(),
    to: date.optional(),
    include: txIds(500).default([]),
    exclude: txIds(500).default([]),
    excludeMerchants: z.array(name).max(20).default([]),
  })
  .refine((e) => !e.from || !e.to || e.from <= e.to, {
    message: 'The end is before the start.',
    path: ['to'],
  })
  .refine((e) => Boolean(e.from && e.to) || e.include.length > 0, {
    message: 'Give the event dates or choose its payments.',
    path: ['from'],
  })

/** Money in that paid you back for outgoings (or for an event). */
const PaybackFact = z
  .strictObject({
    kind: z.literal('payback'),
    inId: txId,
    outIds: txIds(50).default([]),
    eventId: z.string().min(1).max(100).optional(),
    person: name.optional(),
  })
  .refine((p) => p.outIds.length > 0 || p.eventId !== undefined, {
    message: 'Say what it paid back.',
    path: ['outIds'],
  })

/** Money that came in and went straight back out: neither income nor spending. */
const PassThroughFact = z.strictObject({ kind: z.literal('pass-through'), inId: txId, outId: txId })

/**
 * A rule: money from `from` is held for `forPerson` (Gabe's rent for Patrick) until you pass it on.
 * It isn't income, and paying `forPerson` uses it up before it counts as your spending.
 */
const HeldFact = z.strictObject({
  kind: z.literal('held'),
  from: name,
  forPerson: name,
  what: short(40).default(''),
  since: date.optional(),
})

/** Someone owes you money: an outlay you covered, or your share of something. */
const OwedFact = z.strictObject({
  kind: z.literal('owed'),
  person: name,
  amount: pence,
  date,
  outIds: txIds(50).default([]),
  eventId: z.string().min(1).max(100).optional(),
  note: short(80).default(''),
})

/** Leave these out of totals and comparisons ("ignore the four August party payments"). */
const IgnoreFact = z.strictObject({
  kind: z.literal('ignore'),
  transactionIds: z.array(txId).min(1).max(500),
  reason: short(80).default(''),
})

/** Payments from this payer are your income (salary, say), so Ordo stops asking. */
const IncomeFact = z.strictObject({ kind: z.literal('income'), from: name })

/** How an account dates its transactions. Overrides what Ordo assumes from the bank's name. */
const AccountFact = z.strictObject({
  kind: z.literal('account'),
  account: z.string().trim().min(1).max(60),
  dates: z.enum(['posting', 'transaction']),
})

/** Anything else, in your words. Shown to the model as something you told Ordo, never as instructions. */
const NoteFact = z.strictObject({ kind: z.literal('note'), text: z.string().trim().min(1).max(200) })

export const MoneyFactInputSchema = z.discriminatedUnion('kind', [
  PersonFact,
  EventFact,
  PaybackFact,
  PassThroughFact,
  HeldFact,
  OwedFact,
  IgnoreFact,
  IncomeFact,
  AccountFact,
  NoteFact,
])
export type MoneyFactInput = z.input<typeof MoneyFactInputSchema>
export type MoneyFactData = z.output<typeof MoneyFactInputSchema>
export type MoneyFactKind = MoneyFactData['kind']

export const FACT_KINDS = [
  'person',
  'event',
  'payback',
  'pass-through',
  'held',
  'owed',
  'ignore',
  'income',
  'account',
  'note',
] as const satisfies readonly MoneyFactKind[]

/** A saved fact. */
export type MoneyFact = MoneyFactData & { id: string; createdAt: string; source: FactSource }
export type FactOf<K extends MoneyFactKind> = Extract<MoneyFact, { kind: K }>

export const factsOf = <K extends MoneyFactKind>(facts: readonly MoneyFact[], kind: K): FactOf<K>[] =>
  facts.filter((f): f is FactOf<K> => f.kind === kind)

/**
 * Payback facts, one per payment in: if the same money in was saved twice (a double click, an old
 * file), only the first counts, so a £30 payback never takes £60 off.
 */
export function paybackFacts(facts: readonly MoneyFact[]): FactOf<'payback'>[] {
  const seen = new Set<string>()
  return factsOf(facts, 'payback').filter((p) => !seen.has(p.inId) && seen.add(p.inId))
}

/** Is this money in already a payback or a pass-through? (`except` skips the fact being replaced.) */
export function inIdTaken(facts: readonly MoneyFact[], inId: string, except?: string): boolean {
  return facts.some(
    (f) => f.id !== except && (f.kind === 'payback' || f.kind === 'pass-through') && f.inId === inId,
  )
}

/** Every transaction id a fact points at, to check they exist. */
export function factTransactionIds(f: MoneyFactData): string[] {
  switch (f.kind) {
    case 'event':
      return [...f.include, ...f.exclude]
    case 'payback':
      return [f.inId, ...f.outIds]
    case 'pass-through':
      return [f.inId, f.outId]
    case 'owed':
      return f.outIds
    case 'ignore':
      return f.transactionIds
    default:
      return []
  }
}

// Who's on the other side of a payment

/** The other party's name as Ordo shows it: the cleaned merchant, or the description. */
export const counterpartName = (t: Transaction) => t.merchant ?? t.description

/** A key for the other party: `Genest J` → `genestj`. */
export const counterpartKey = (t: Transaction) => merchantKey(counterpartName(t))

/** Words in lower case, initials kept: `Patrick O` → `patrick`, `o`. */
const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

/**
 * Does this payment come from (or go to) `name`? Either the counterpart is exactly that name, or
 * every word of the name, initials included, is a whole word of the description or merchant:
 * `Gabe` matches `GABE S RENT`, and `Patrick O` matches `PATRICK O RENT` but not `PATRICK SMITH`
 * or `PATRICK OBRIEN PLUMBING`. Names shorter than three letters never match by themselves.
 */
export function involves(t: Transaction, name: string, aliases: readonly string[] = []): boolean {
  const key = counterpartKey(t)
  const text = new Set(words(`${t.description} ${t.merchant ?? ''}`))
  for (const n of [name, ...aliases]) {
    const k = merchantKey(n)
    if (k.length < 3) continue
    if (key === k) return true
    const ws = words(n)
    if (ws.length && ws.every((w) => text.has(w))) return true
  }
  return false
}

/** Aliases saved for a person, by lower-case name. */
export function aliasesFor(facts: readonly MoneyFact[], person: string): string[] {
  const p = factsOf(facts, 'person').find((f) => f.name.toLowerCase() === person.toLowerCase())
  return p?.aliases ?? []
}

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

/** `3 Nov` for `2026-11-03`, in UTC so it never shifts. */
export function shortDate(d: ISODate): string {
  const [y, m, dd] = d.split('-').map(Number) as [number, number, number]
  return dateFmt.format(new Date(Date.UTC(y, m - 1, dd)))
}
