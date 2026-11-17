import { describe, expect, it } from 'vitest'
import type { MessageHeader } from '@ordo/mail-core'
import { emailHints, hintKind } from './email'

let uid = 0
const header = (from: string, subject: string, date = '2026-11-01T10:00:00Z'): MessageHeader => {
  const m = /^(?:(.*) )?<(.+)>$/.exec(from)
  return {
    uid: uid++,
    mailbox: 'INBOX',
    date: new Date(date),
    seen: true,
    from: m ? { name: m[1], address: m[2]! } : { address: from },
    subject,
  }
}

describe('hintKind', () => {
  it.each([
    ['Your free trial ends in 3 days', 'trial-ending'],
    ['Reminder: your Disney+ trial is ending soon', 'trial-ending'],
    ["We're changing the price of your plan", 'price-change'],
    ['An update to your plan price', 'price-change'],
    ['Price increase for your Spotify Premium', 'price-change'],
    ['Your membership renews on 3 December', 'renewal'],
    ['Your subscription will be charged tomorrow', 'renewal'],
    ['Your receipt from Apple', 'receipt'],
    ['Invoice #1234 for November', 'receipt'],
    ['Your monthly bill is ready', 'receipt'],
    ['Payment received - thank you', 'receipt'],
    ['Dinner on Friday?', null],
    ['20% off everything this weekend', null],
  ])('%s → %s', (subject, kind) => {
    expect(hintKind(subject)).toBe(kind)
  })
})

describe('emailHints', () => {
  it('names the merchant from the sender, without generic words', () => {
    const [h] = emailHints([
      header('Netflix Billing <info@account.netflix.com>', 'Your receipt from Netflix'),
    ])
    expect(h).toMatchObject({ merchant: 'Netflix', domain: 'account.netflix.com', kind: 'receipt' })
  })

  it('falls back to the domain when the sender name says nothing', () => {
    const [h] = emailHints([header('Billing Team <no-reply@spotify.co.uk>', 'Your Spotify Premium receipt')])
    expect(h!.merchant).toBe('Spotify')
    const [h2] = emailHints([header('noreply@thameswater.co.uk', 'Your bill is ready')])
    expect(h2!.merchant).toBe('Thameswater')
  })

  it('groups by merchant and kind, keeping the latest subject and a count', () => {
    const hints = emailHints([
      header('Netflix <info@netflix.com>', 'Your receipt for September', '2026-09-03T08:00:00Z'),
      header('Netflix <info@netflix.com>', 'Your receipt for November', '2026-11-03T08:00:00Z'),
      header('Netflix <info@netflix.com>', 'Your receipt for October', '2026-10-03T08:00:00Z'),
      header('Netflix <info@netflix.com>', 'Price increase coming in December', '2026-11-10T08:00:00Z'),
      header('Sam <sam@friend.example>', 'Dinner?'),
    ])
    expect(hints).toEqual([
      {
        merchant: 'Netflix',
        domain: 'netflix.com',
        kind: 'price-change',
        lastSeen: '2026-11-10',
        count: 1,
        subject: 'Price increase coming in December',
      },
      {
        merchant: 'Netflix',
        domain: 'netflix.com',
        kind: 'receipt',
        lastSeen: '2026-11-03',
        count: 3,
        subject: 'Your receipt for November',
      },
    ])
  })
})
