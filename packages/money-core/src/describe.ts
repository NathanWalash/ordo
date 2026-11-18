// One plain sentence per saved fact, in Ordo's words, for "What Ordo knows" and for the model.

import { formatPence } from './amount'
import { counterpartName, shortDate, type MoneyFact, type MoneyFactData } from './memory'
import type { Transaction } from './types'

const ROLE: Record<string, string> = {
  flatmate: 'your flatmate',
  friend: 'a friend',
  family: 'family',
  partner: 'your partner',
  landlord: 'your landlord',
  other: 'someone you know',
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** Describe a fact. `byId` looks up the transactions it mentions; `events` names events by id. */
export function describeFact(
  f: MoneyFactData,
  byId: ReadonlyMap<string, Transaction>,
  events: ReadonlyMap<string, string> = new Map(),
): string {
  const tx = (id: string) => {
    const t = byId.get(id)
    return t
      ? `${counterpartName(t)} ${formatPence(Math.abs(t.amount))} on ${shortDate(t.date)}`
      : 'a payment no longer imported'
  }
  switch (f.kind) {
    case 'person':
      return `${f.name} is ${ROLE[f.role] ?? 'someone you know'}${f.aliases.length ? ` (also shows as ${f.aliases.join(', ')})` : ''}.`
    case 'event': {
      const when = f.from && f.to ? ` from ${shortDate(f.from)} to ${shortDate(f.to)}` : ''
      const extra = [
        f.include.length && `${plural(f.include.length, 'payment')} added`,
        f.exclude.length && `${f.exclude.length} left out`,
        f.excludeMerchants.length && `not counting ${f.excludeMerchants.join(', ')}`,
      ].filter(Boolean)
      return `${f.name}${when}${extra.length ? `: ${extra.join(', ')}` : ''}.`
    }
    case 'payback': {
      const what =
        f.eventId && events.has(f.eventId) ? events.get(f.eventId)! : f.outIds.map(tx).join(' and ')
      return `${tx(f.inId)} paid you back for ${what || 'an outgoing'}.`
    }
    case 'pass-through':
      return `${tx(f.inId)} passed straight through to ${tx(f.outId)}.`
    case 'held':
      return `Money from ${f.from} is ${f.what ? `${f.what} ` : ''}you hold for ${f.forPerson}, not your income.`
    case 'owed':
      return `${f.person} owes you ${formatPence(f.amount)}${f.note ? ` for ${f.note}` : ''} (since ${shortDate(f.date)}).`
    case 'ignore':
      return `Ignore ${plural(f.transactionIds.length, 'payment')}${f.reason ? `: ${f.reason}` : ''}.`
    case 'income':
      return `Payments from ${f.from} are your income.`
    case 'account':
      return f.dates === 'posting'
        ? `${f.account} shows the day payments cleared.`
        : `${f.account} shows the day you paid.`
    case 'note':
      return f.text
  }
}

/** Every fact with its sentence. */
export function describeFacts(facts: readonly MoneyFact[], transactions: readonly Transaction[]) {
  const byId = new Map(transactions.map((t) => [t.id, t]))
  const events = new Map(facts.flatMap((f) => (f.kind === 'event' ? [[f.id, f.name] as const] : [])))
  return facts.map((f) => ({ ...f, summary: describeFact(f, byId, events) }))
}
