import { describe, expect, it } from 'vitest'
import { billsToCalendarItems } from './calendar'
import { applySuggestions, noAdvisor } from './advisor'
import { linkBills, monthlyCost, resolveBills } from './link'
import type { Bill, EmailHint, RecurringCandidate, StoredBill } from './types'

const candidate = (
  merchant: string,
  amount: number,
  extra: Partial<RecurringCandidate> = {},
): RecurringCandidate => ({
  id: merchant.toLowerCase().replace(/[^a-z]/g, ''),
  key: merchant.toLowerCase().replace(/[^a-z]/g, ''),
  merchant,
  cadence: 'monthly',
  typicalAmount: amount,
  lastDate: '2026-11-03',
  nextDue: '2026-12-03',
  confidence: 0.8,
  transactionIds: ['t1', 't2'],
  ...extra,
})

const hint = (
  merchant: string,
  domain: string,
  kind: EmailHint['kind'],
  subject = 'Your receipt',
): EmailHint => ({
  merchant,
  domain,
  kind,
  lastSeen: '2026-11-03',
  count: 1,
  subject,
})

describe('linkBills', () => {
  it('marks bank payments with matching email as both', () => {
    const [netflix, sky] = linkBills(
      [candidate('Netflix', 1099), candidate('Sky Digital', 3500)],
      [hint('Netflix', 'account.netflix.com', 'receipt')],
    )
    expect(netflix).toMatchObject({ key: 'netflix', source: 'both', amount: 1099, confidence: 0.9 })
    expect(netflix!.hints).toHaveLength(1)
    expect(sky).toMatchObject({ source: 'bank', confidence: 0.8, hints: [] })
  })

  it('matches by sender domain when the name differs', () => {
    const [water] = linkBills(
      [candidate('Thames Water', 3800)],
      [hint('Your Water Account', 'thameswater.co.uk', 'receipt')],
    )
    expect(water!.source).toBe('both')
  })

  it('suggests email-only bills for renewals and trials, never for plain receipts', () => {
    const found = linkBills(
      [],
      [
        hint('Disney+', 'disneyplus.com', 'trial-ending', 'Your trial ends soon'),
        hint('Amazon', 'amazon.co.uk', 'receipt'),
        hint('Adobe', 'adobe.com', 'renewal', 'Your annual plan renews soon'),
      ],
    )
    expect(found.map((d) => [d.key, d.source, d.amount, d.cadence])).toEqual([
      ['email:disney', 'email', null, 'monthly'],
      ['email:adobe', 'email', null, 'yearly'],
    ])
  })
})

describe('resolveBills', () => {
  const stored: StoredBill = {
    id: 'b1',
    name: 'Netflix',
    amount: 1099,
    cadence: 'monthly',
    anchorDate: '2026-09-03',
    source: 'bank',
    status: 'active',
    merchantKey: 'netflix',
  }

  it('fills saved bills from the latest bank run and hides that run from review', () => {
    const detected = linkBills(
      [
        candidate('Netflix', 1299, { priceIncrease: { from: 1099, to: 1299, date: '2026-11-03' } }),
        candidate('Spotify', 1299),
      ],
      [],
    )
    const r = resolveBills({
      stored: [stored],
      detected,
      hints: [],
      dismissed: new Set(),
      today: '2026-11-17',
    })
    expect(r.bills[0]).toMatchObject({
      id: 'b1',
      amount: 1299,
      nextDue: '2026-12-03',
      lastPaid: '2026-11-03',
      priceIncrease: { from: 1099, to: 1299 },
    })
    expect(r.review.map((d) => d.key)).toEqual(['spotify'])
  })

  it('rolls manual due dates forward and leaves out dismissed suggestions', () => {
    const manual: StoredBill = { ...stored, id: 'b2', name: 'Rent', source: 'manual', merchantKey: undefined }
    const r = resolveBills({
      stored: [manual],
      detected: linkBills([candidate('Spotify', 1299)], []),
      hints: [],
      dismissed: new Set(['spotify']),
      today: '2026-11-17',
    })
    expect(r.bills[0]!.nextDue).toBe('2026-12-03')
    expect(r.review).toEqual([])
    const later = resolveBills({
      stored: [{ ...manual, anchorDate: '2027-06-01' }],
      detected: [],
      hints: [],
      dismissed: new Set(),
      today: '2026-11-17',
    })
    expect(later.bills[0]!.nextDue).toBe('2027-06-01')
  })

  it('flags trials ending and price-change emails on saved bills', () => {
    const r = resolveBills({
      stored: [{ ...stored, source: 'manual', merchantKey: undefined }],
      detected: [],
      hints: [hint('Netflix', 'netflix.com', 'price-change'), hint('Netflix', 'netflix.com', 'trial-ending')],
      dismissed: new Set(),
      today: '2026-11-17',
    })
    expect(r.bills[0]).toMatchObject({ trialEnding: '2026-11-03', priceChangeEmail: '2026-11-03' })
  })
})

describe('monthlyCost', () => {
  it('converts weekly and yearly costs to a monthly figure', () => {
    expect(monthlyCost(1099, 'monthly')).toBe(1099)
    expect(monthlyCost(1000, 'weekly')).toBe(4349)
    expect(monthlyCost(16950, 'yearly')).toBe(1413)
  })
})

describe('billsToCalendarItems', () => {
  const bill = (b: Partial<Bill>): Bill => ({
    id: 'x',
    name: 'X',
    amount: 100,
    cadence: 'monthly',
    nextDue: '2026-12-03',
    source: 'manual',
    status: 'active',
    ...b,
  })

  it('lists due dates, renewals and trial endings in range, skipping cancelled bills', () => {
    const items = billsToCalendarItems(
      [
        bill({ id: 'netflix', name: 'Netflix', amount: 1099 }),
        bill({ id: 'tv', name: 'TV Licence', cadence: 'yearly', nextDue: '2027-03-10', amount: 16950 }),
        bill({ id: 'disney', name: 'Disney+', trialEnding: '2026-12-10' }),
        bill({ id: 'gym', name: 'Gym', status: 'cancelled' }),
      ],
      { from: '2026-12-01', to: '2027-03-31' },
    )
    expect(items.filter((i) => i.title === 'Netflix').map((i) => i.date)).toEqual([
      '2026-12-03',
      '2027-01-03',
      '2027-02-03',
      '2027-03-03',
    ])
    expect(items.find((i) => i.title === 'TV Licence')).toEqual({
      id: 'tv:2027-03-10',
      date: '2027-03-10',
      title: 'TV Licence',
      kind: 'renewal',
      amount: 16950,
    })
    expect(items.find((i) => i.kind === 'trial')).toEqual({
      id: 'disney:trial',
      date: '2026-12-10',
      title: 'Disney+ trial ending',
      kind: 'trial',
    })
    expect(items.some((i) => i.title === 'Gym')).toBe(false)
    // Nothing before the next due date.
    expect(items.some((i) => i.title === 'TV Licence' && i.date < '2027-03-10')).toBe(false)
  })
})

describe('MatchAdvisor', () => {
  it('has a no-op default that suggests nothing', async () => {
    const detected = linkBills([candidate('Netflix', 1099)], [])
    const suggestions = await noAdvisor.suggest(detected)
    expect(applySuggestions(detected, suggestions)).toEqual(detected)
  })

  it('applies renames and drops what a model says is not a bill', () => {
    const detected = linkBills([candidate('Thames Wtr', 3800), candidate('Tesco', 2000)], [])
    const out = applySuggestions(detected, [
      { key: 'thameswtr', name: 'Thames Water', confidence: 0.9 },
      { key: 'tesco', isBill: false, confidence: 0.9 },
    ])
    expect(out.map((d) => d.name)).toEqual(['Thames Water'])
  })
})
