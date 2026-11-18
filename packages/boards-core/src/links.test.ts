import { describe, expect, it } from 'vitest'
import {
  billCandidate,
  emailCandidate,
  eventCandidate,
  keywords,
  pounds,
  relevance,
  resolveLinks,
  searchCandidates,
  targetKey,
  toCandidates,
  transactionCandidate,
} from './links'
import type { CardLink } from './types'

const event = {
  calendarId: 'https://cal.example/home/',
  calendarName: 'Home',
  uid: 'dentist-1',
  title: 'Dentist   check-up',
  start: new Date(2026, 10, 20, 9, 30),
  end: new Date(2026, 10, 20, 10, 0),
  allDay: false,
}

describe('candidates', () => {
  it('describes events, bills, transactions, emails and cards in one shape', () => {
    const c = toCandidates({
      events: [event, { ...event, uid: 'x', allDay: true, title: '' }],
      bills: [{ id: 'b1', name: 'Council tax', amount: 14_500, nextDue: '2026-12-01', cadence: 'monthly' }],
      transactions: [
        { id: 't1', date: '2026-11-10', description: 'TESCO 123', merchant: 'Tesco', amount: -4_210 },
      ],
      emails: [
        {
          mailbox: 'INBOX',
          uid: 42,
          subject: 'Your \n quote',
          from: { address: 'quotes@builder.example', name: 'Builder Ltd' },
          date: new Date(2026, 10, 15),
        },
      ],
      cards: [{ id: 'c1', title: 'Fix gate', boardName: 'Home', columnName: 'Doing', due: null }],
    })
    expect(c.event[0]).toMatchObject({
      title: 'Dentist check-up',
      detail: 'Home · 09:30',
      date: '2026-11-20',
    })
    expect(c.event[1]).toMatchObject({ title: 'Untitled event', detail: 'Home · All day' })
    expect(c.bill[0]).toMatchObject({ title: 'Council tax', detail: '£145 monthly', date: '2026-12-01' })
    expect(c.transaction[0]).toMatchObject({ title: 'Tesco', detail: '£42.10 out', date: '2026-11-10' })
    expect(c.email[0]).toMatchObject({ title: 'Your quote', detail: 'Builder Ltd', date: '2026-11-15' })
    expect(c.card[0]).toMatchObject({ title: 'Fix gate', detail: 'Home · Doing', date: null })
  })

  it('formats pounds', () => {
    expect(pounds(1299)).toBe('£12.99')
    expect(pounds(-4000)).toBe('£40')
    expect(pounds(123_400)).toBe('£1,234')
  })

  it('names an all-day occurrence by its day, so the link survives a change of time zone', () => {
    const allDay = eventCandidate({ ...event, allDay: true, start: new Date(2026, 10, 20) })
    expect(allDay.target).toMatchObject({ start: '2026-11-20' })
    expect(allDay.key).toBe(`event|${encodeURIComponent(event.calendarId)}|dentist-1|2026-11-20`)
    expect(eventCandidate(event).target).toMatchObject({ start: event.start.toISOString() })
  })

  it('shows a sender by name only, never by address', () => {
    const email = (name?: string) =>
      emailCandidate({
        mailbox: 'INBOX',
        uid: 1,
        subject: 's',
        from: { address: 'a@b.example', name },
        date: new Date(),
      })
    expect(email('Smiles Dental').detail).toBe('Smiles Dental')
    expect(email().detail).toBeNull()
    expect(email('a@b.example').detail).toBeNull()
  })

  it('gives each target one key', () => {
    const a = eventCandidate(event)
    expect(a.key).toBe(targetKey(a.target))
    expect(targetKey({ kind: 'email', mailbox: 'INBOX', uid: 1 })).toBe('email|INBOX|1')
    expect(targetKey({ kind: 'bill', billId: 'a|b' })).toBe('bill|a%7Cb')
    expect(new Set(['event', 'bill', 'card'].map((k) => targetKey({ kind: 'card', cardId: k }))).size).toBe(3)
  })
})

describe('resolveLinks', () => {
  it('uses what’s there now, and the snapshot when it’s gone', () => {
    const bill = billCandidate({ id: 'b1', name: 'Council Tax (new)', amount: 15_000, nextDue: '2027-01-01' })
    const links: CardLink[] = [
      {
        id: 'l1',
        cardId: 'c',
        target: { kind: 'bill', billId: 'b1' },
        title: 'Council tax',
        detail: null,
        date: null,
        createdAt: '',
      },
      {
        id: 'l2',
        cardId: 'c',
        target: { kind: 'transaction', transactionId: 'gone' },
        title: 'Tesco',
        detail: '£4 out',
        date: '2026-01-01',
        createdAt: '',
      },
    ]
    const out = resolveLinks(links, [
      bill,
      transactionCandidate({ id: 't', date: '2026-01-01', description: 'x', amount: 1 }),
    ])
    expect(out[0]).toMatchObject({ found: true, title: 'Council Tax (new)', date: '2027-01-01' })
    expect(out[1]).toMatchObject({ found: false, title: 'Tesco', detail: '£4 out' })
  })
})

describe('relevance', () => {
  it('scores shared distinctive words, plus nearby dates', () => {
    const words = keywords('Book the dentist appointments for the kids')
    expect(words.has('dentist')).toBe(true)
    expect(words.has('appointment')).toBe(true)
    expect(words.has('the')).toBe(false)
    const dentist = eventCandidate(event)
    expect(relevance(words, dentist, null)).toBe(1)
    expect(relevance(words, dentist, '2026-11-19')).toBe(1.5)
    const other = emailCandidate({
      mailbox: 'INBOX',
      uid: 1,
      subject: 'Your order confirmation',
      from: { address: 'shop@x.example' },
      date: new Date(),
    })
    expect(relevance(words, other, '2026-11-19')).toBe(0)
  })

  it('searches candidates by every word', () => {
    const list = [
      eventCandidate(event),
      billCandidate({ id: 'b', name: 'Dentist plan', amount: 1200, nextDue: null }),
    ]
    expect(searchCandidates(list, 'dentist').map((c) => c.title)).toEqual([
      'Dentist check-up',
      'Dentist plan',
    ])
    expect(searchCandidates(list, 'dentist home').map((c) => c.title)).toEqual(['Dentist check-up'])
    expect(searchCandidates(list, '', 1)).toHaveLength(1)
  })
})
