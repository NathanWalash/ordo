// Things a card can link to, gathered from the other modules into one shape, and links looked
// up again when a card is shown. Pure: the main process passes in what it read.

import { daysBetween, toISODate } from './dates'
import type { CardLink, ISODate, LinkCandidate, LinkKind, LinkTarget, ResolvedLink } from './types'

export interface EventSource {
  calendarId: string
  calendarName?: string
  uid: string
  title: string
  start: Date
  end: Date
  allDay: boolean
}

export interface BillSource {
  id: string
  name: string
  /** Pence. */
  amount: number | null
  nextDue: ISODate | null
  cadence?: string
}

export interface TransactionSource {
  id: string
  date: ISODate
  description: string
  merchant?: string
  /** Pence: negative is money out. */
  amount: number
}

export interface EmailSource {
  mailbox: string
  uid: number
  subject: string
  from: { address: string; name?: string }
  date: Date
  messageId?: string
}

export interface CardSource {
  id: string
  title: string
  boardName: string
  columnName: string
  due: ISODate | null
}

/** What the other modules have, as far as linking goes. Missing kinds just aren't offered. */
export interface LinkSources {
  events?: EventSource[]
  bills?: BillSource[]
  transactions?: TransactionSource[]
  emails?: EmailSource[]
  cards?: CardSource[]
}

/** One string per target, the same whether it came from a link or a candidate. */
export function targetKey(t: LinkTarget): string {
  const e = encodeURIComponent
  switch (t.kind) {
    case 'event':
      return `event|${e(t.calendarId)}|${e(t.uid)}|${t.start}`
    case 'email':
      return `email|${e(t.mailbox)}|${t.uid}`
    case 'bill':
      return `bill|${e(t.billId)}`
    case 'transaction':
      return `transaction|${e(t.transactionId)}`
    case 'card':
      return `card|${e(t.cardId)}`
  }
}

const pad = (n: number) => String(n).padStart(2, '0')
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

/** `£12.99`, without pennies when whole: `£40`. */
export function pounds(pence: number): string {
  const abs = Math.abs(pence)
  return `£${abs % 100 === 0 ? (abs / 100).toLocaleString('en-GB') : (abs / 100).toFixed(2)}`
}

const oneLine = (s: string, max = 200) => s.replace(/\s+/g, ' ').trim().slice(0, max)

/**
 * How a link names one occurrence of an event: the instant for a timed event, the day for an
 * all-day one, so an all-day link survives a change of time zone.
 */
export const occurrenceStart = (e: Pick<EventSource, 'start' | 'allDay'>): string =>
  e.allDay ? toISODate(e.start) : e.start.toISOString()

export function eventCandidate(e: EventSource): LinkCandidate {
  const target: LinkTarget = {
    kind: 'event',
    calendarId: e.calendarId,
    uid: e.uid,
    start: occurrenceStart(e),
  }
  const when = e.allDay ? 'All day' : clock(e.start)
  return {
    key: targetKey(target),
    target,
    title: oneLine(e.title) || 'Untitled event',
    detail: [e.calendarName, when].filter(Boolean).join(' · '),
    date: toISODate(e.start),
  }
}

export function billCandidate(b: BillSource): LinkCandidate {
  const target: LinkTarget = { kind: 'bill', billId: b.id }
  return {
    key: targetKey(target),
    target,
    title: oneLine(b.name) || 'Bill',
    detail: [b.amount !== null ? pounds(b.amount) : null, b.cadence].filter(Boolean).join(' ') || null,
    date: b.nextDue,
  }
}

export function transactionCandidate(t: TransactionSource): LinkCandidate {
  const target: LinkTarget = { kind: 'transaction', transactionId: t.id }
  return {
    key: targetKey(target),
    target,
    title: oneLine(t.merchant || t.description) || 'Transaction',
    detail: `${pounds(t.amount)} ${t.amount < 0 ? 'out' : 'in'}`,
    date: t.date,
  }
}

export function emailCandidate(m: EmailSource): LinkCandidate {
  const target: LinkTarget = {
    kind: 'email',
    mailbox: m.mailbox,
    uid: m.uid,
    ...(m.messageId && { messageId: m.messageId }),
  }
  return {
    key: targetKey(target),
    target,
    title: oneLine(m.subject) || '(no subject)',
    // The sender's display name only: an address is never shown to a model, so it isn't here.
    detail: m.from.name && !m.from.name.includes('@') ? oneLine(m.from.name, 120) : null,
    date: toISODate(m.date),
  }
}

export function cardCandidate(c: CardSource): LinkCandidate {
  const target: LinkTarget = { kind: 'card', cardId: c.id }
  return {
    key: targetKey(target),
    target,
    title: oneLine(c.title) || 'Untitled card',
    detail: `${oneLine(c.boardName, 60)} · ${oneLine(c.columnName, 60)}`,
    date: c.due,
  }
}

/** Every candidate in the sources, by kind. */
export function toCandidates(s: LinkSources): Record<LinkKind, LinkCandidate[]> {
  return {
    event: (s.events ?? []).map(eventCandidate),
    email: (s.emails ?? []).map(emailCandidate),
    bill: (s.bills ?? []).map(billCandidate),
    transaction: (s.transactions ?? []).map(transactionCandidate),
    card: (s.cards ?? []).map(cardCandidate),
  }
}

/** Look each link up in what the other modules have now; fall back to the snapshot when it's gone. */
export function resolveLinks(
  links: readonly CardLink[],
  candidates: readonly LinkCandidate[],
): ResolvedLink[] {
  const byKey = new Map(candidates.map((c) => [c.key, c]))
  return links.map((l) => {
    const c = byKey.get(targetKey(l.target))
    return c ? { ...l, title: c.title, detail: c.detail, date: c.date, found: true } : { ...l, found: false }
  })
}

const STOP = new Set(
  (
    'the and for with from this that your you are our was were will have has had not but all any can ' +
    'get got out new now via per off its into onto over about after before then than them they their ' +
    'his her she him who what when where which why how just also more most some such only own same ' +
    'too very via re fwd fw reminder update updates order confirmation receipt'
  ).split(' '),
)

/** Distinctive words: lower-case, three letters or more, without common words or plural s. */
export function keywords(text: string): Set<string> {
  const words = text
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w))
    .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
  return new Set(words)
}

/**
 * How related a candidate looks to a card: shared distinctive words, plus a little for falling
 * within three days of the card's date. Zero means nothing in common.
 */
export function relevance(
  cardWords: ReadonlySet<string>,
  candidate: LinkCandidate,
  cardDue: ISODate | null,
): number {
  let score = 0
  for (const w of keywords(`${candidate.title} ${candidate.detail ?? ''}`)) if (cardWords.has(w)) score += 1
  if (score > 0 && cardDue && candidate.date && Math.abs(daysBetween(cardDue, candidate.date)) <= 3)
    score += 0.5
  return score
}

/** Candidates whose title, detail or kind contain every word of `query`, soonest first. */
export function searchCandidates(
  candidates: readonly LinkCandidate[],
  query: string,
  limit = 50,
): LinkCandidate[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const hits = candidates.filter((c) => {
    const text = `${c.title} ${c.detail ?? ''}`.toLocaleLowerCase()
    return words.every((w) => text.includes(w))
  })
  return hits.slice(0, limit)
}
