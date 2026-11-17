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
})
