import { describe, expect, it } from 'vitest'
import type { CategorisedSender } from './analyse'
import { buildCleanupPlan } from './cleanup-plan'

const sender = (address: string, o: Partial<CategorisedSender> = {}): CategorisedSender => ({
  address,
  domain: address.split('@')[1]!,
  count: 10,
  unread: 5,
  firstSeen: new Date(0),
  lastSeen: new Date(0),
  sampleSubjects: [],
  unsubscribe: { kind: 'one-click', url: 'https://x.example/u' },
  bulk: true,
  automated: false,
  category: 'promotions',
  ...o,
})

const senders = [
  sender('deals@shop.example', { name: 'Shop' }),
  sender('news@paper.example', { category: 'newsletters', unsubscribe: { kind: 'none' } }),
  sender('sam@friend.example', { category: 'people' }),
  sender('alerts@bank.example', { category: 'notifications' }),
  sender('old@http.example', { unsubscribe: { kind: 'link', url: 'http://http.example/u' } }),
  sender('list@club.example', {
    category: 'newsletters',
    unsubscribe: {
      kind: 'mailto',
      address: 'leave@club.example',
      url: 'mailto:leave@club.example?subject=stop',
    },
  }),
  sender('promo@brand.example', {
    unsubscribe: { kind: 'mailto', address: 'optout@y.com', url: 'mailto:optout@y.com' },
  }),
]

describe('buildCleanupPlan', () => {
  it('plans the requested actions for known senders', () => {
    const plan = buildCleanupPlan(senders, new Set(), [
      { address: 'Deals@Shop.example ', unsubscribe: true, trash: true },
    ])
    expect(plan.rejected).toEqual([])
    expect(plan.senders).toEqual([
      {
        address: 'deals@shop.example',
        name: 'Shop',
        category: 'promotions',
        count: 10,
        unsubscribe: { kind: 'one-click', url: 'https://x.example/u' },
        insecureLinkConfirmed: false,
        mailto: null,
        trash: true,
      },
    ])
  })

  it('refuses people, whether categorised or replied to', () => {
    const plan = buildCleanupPlan(senders, new Set(['alerts@bank.example']), [
      { address: 'sam@friend.example', unsubscribe: true, trash: true },
      { address: 'alerts@bank.example', unsubscribe: false, trash: true },
    ])
    expect(plan.senders).toEqual([])
    expect(plan.rejected.map((r) => r.address)).toEqual(['sam@friend.example', 'alerts@bank.example'])
    expect(plan.rejected[0]!.reason).toMatch(/written to/)
  })

  it('refuses unknown senders and requests with nothing to do', () => {
    const plan = buildCleanupPlan(senders, new Set(), [
      { address: 'ghost@nowhere.example', unsubscribe: true, trash: true },
      { address: 'deals@shop.example', unsubscribe: false, trash: false },
      { address: 'news@paper.example', unsubscribe: true, trash: false },
    ])
    expect(plan.senders).toEqual([])
    expect(plan.rejected.map((r) => r.reason)).toEqual([
      'Not in your scanned inbox',
      'Nothing to do',
      'Nothing to do',
    ])
  })

  it('drops the unsubscribe when there is no method but still moves mail', () => {
    const plan = buildCleanupPlan(senders, new Set(), [
      { address: 'news@paper.example', unsubscribe: true, trash: true },
    ])
    expect(plan.senders[0]).toMatchObject({ unsubscribe: null, trash: true })
  })

  it('needs the plain http link echoed back before opening it', () => {
    const req = { address: 'old@http.example', unsubscribe: true, trash: true }
    expect(buildCleanupPlan(senders, new Set(), [req]).rejected).toHaveLength(1)
    const ok = buildCleanupPlan(senders, new Set(), [{ ...req, confirmedUrl: 'http://http.example/u' }])
    expect(ok.senders[0]).toMatchObject({ insecureLinkConfirmed: true, unsubscribe: { kind: 'link' } })
  })

  it('ignores duplicate requests', () => {
    const plan = buildCleanupPlan(senders, new Set(), [
      { address: 'deals@shop.example', unsubscribe: true, trash: true },
      { address: 'DEALS@shop.example', unsubscribe: false, trash: true },
    ])
    expect(plan.senders).toHaveLength(1)
  })

  it('plans the exact unsubscribe email for an on-domain mailto', () => {
    const plan = buildCleanupPlan(senders, new Set(), [
      { address: 'list@club.example', unsubscribe: true, trash: false },
    ])
    expect(plan.senders[0]!.mailto).toEqual({
      to: 'leave@club.example',
      subject: 'stop',
      body: 'unsubscribe',
    })
  })

  it('refuses an email unsubscribe to a different domain without the user’s tick', () => {
    const req = { address: 'promo@brand.example', unsubscribe: true, trash: true }
    const refused = buildCleanupPlan(senders, new Set(), [req])
    expect(refused.senders).toEqual([])
    expect(refused.rejected[0]!.reason).toMatch(/different domain \(optout@y\.com\)/)
    const wrongTick = buildCleanupPlan(senders, new Set(), [{ ...req, confirmedRecipient: 'other@y.com' }])
    expect(wrongTick.senders).toEqual([])
  })

  it('allows an email unsubscribe to a different domain once ticked', () => {
    const plan = buildCleanupPlan(senders, new Set(), [
      { address: 'promo@brand.example', unsubscribe: true, trash: true, confirmedRecipient: 'OptOut@y.com' },
    ])
    expect(plan.senders[0]!.mailto).toEqual({
      to: 'optout@y.com',
      subject: 'unsubscribe',
      body: 'unsubscribe',
    })
  })

  it('caps unsubscribe emails at 50 per clean-up', () => {
    const many = Array.from({ length: 52 }, (_, i) =>
      sender(`n${i}@club.example`, {
        unsubscribe: {
          kind: 'mailto',
          address: `leave${i}@club.example`,
          url: `mailto:leave${i}@club.example`,
        },
      }),
    )
    const plan = buildCleanupPlan(
      many,
      new Set(),
      many.map((s) => ({ address: s.address, unsubscribe: true, trash: false })),
    )
    expect(plan.senders.filter((s) => s.mailto)).toHaveLength(50)
    expect(plan.rejected).toHaveLength(2)
    expect(plan.rejected[0]!.reason).toMatch(/At most 50/)
  })
})
