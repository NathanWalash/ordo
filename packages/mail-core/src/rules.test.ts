import { describe, expect, it } from 'vitest'
import { categorise } from './rules'
import type { SenderSummary } from './types'

const s = (o: Partial<SenderSummary>): SenderSummary => ({
  address: 'x@x.example',
  domain: 'x.example',
  count: 1,
  unread: 0,
  firstSeen: new Date(0),
  lastSeen: new Date(0),
  sampleSubjects: [],
  unsubscribe: { kind: 'none' },
  bulk: false,
  automated: false,
  ...o,
})

describe('categorise', () => {
  it('always treats people you have written to as people', () => {
    const shop = s({ address: 'sam@shop.example', bulk: true, sampleSubjects: ['50% off today'] })
    expect(categorise(shop, new Set(['sam@shop.example']))).toBe('people')
  })

  it('spots receipts', () => {
    expect(
      categorise(
        s({ automated: true, sampleSubjects: ['Your receipt from Cafe', 'Order #123 confirmed'] }),
        new Set(),
      ),
    ).toBe('receipts')
  })

  it('splits bulk mail into promotions and newsletters', () => {
    expect(
      categorise(
        s({ bulk: true, sampleSubjects: ['Sale ends tonight', 'New arrivals', 'Hello'] }),
        new Set(),
      ),
    ).toBe('promotions')
    expect(categorise(s({ bulk: true, sampleSubjects: ['Issue 42: weekly links'] }), new Set())).toBe(
      'newsletters',
    )
  })

  it('files other machine-sent mail as notifications', () => {
    expect(
      categorise(s({ automated: true, sampleSubjects: ['New sign-in to your account'] }), new Set()),
    ).toBe('notifications')
  })

  it('leaves unclear senders uncategorised', () => {
    expect(categorise(s({ sampleSubjects: ['Hi'] }), new Set())).toBe('uncategorised')
  })
})
