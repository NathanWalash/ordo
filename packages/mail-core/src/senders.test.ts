import { describe, expect, it } from 'vitest'
import { groupBySender } from './senders'
import type { MessageHeader } from './types'

const h = (o: Partial<MessageHeader> & { from: MessageHeader['from'] }): MessageHeader => ({
  uid: 1,
  mailbox: 'INBOX',
  date: new Date('2026-01-01'),
  seen: true,
  subject: 's',
  ...o,
})

describe('groupBySender', () => {
  it('groups case-insensitively, counts unread and sorts by volume', () => {
    const out = groupBySender([
      h({
        from: { address: 'Deals@Shop.example' },
        seen: false,
        subject: 'old',
        date: new Date('2026-01-01'),
      }),
      h({
        from: { address: 'deals@shop.example', name: 'Shop' },
        subject: 'new',
        date: new Date('2026-02-01'),
        listUnsubscribe: '<https://shop.example/u>',
        listUnsubscribePost: 'List-Unsubscribe=One-Click',
      }),
      h({ from: { address: 'friend@icloud.com' } }),
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      address: 'deals@shop.example',
      name: 'Shop',
      domain: 'shop.example',
      count: 2,
      unread: 1,
      sampleSubjects: ['new', 'old'],
      unsubscribe: { kind: 'one-click' },
    })
  })
})
