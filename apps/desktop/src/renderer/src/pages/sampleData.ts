import type { Category, MessageHeader } from '@ordo/mail-core'

// Fictional senders used to preview Unclutter before an account is connected.
const SENDERS: {
  address: string
  name: string
  category: Category
  count: number
  unreadPct: number
  unsub?: 'one-click' | 'link'
}[] = [
  {
    address: 'deals@mail.northwind.example',
    name: 'Northwind Outlet',
    category: 'promotions',
    count: 642,
    unreadPct: 98,
    unsub: 'one-click',
  },
  {
    address: 'hello@morningbrief.example',
    name: 'The Morning Brief',
    category: 'newsletters',
    count: 511,
    unreadPct: 91,
    unsub: 'one-click',
  },
  {
    address: 'noreply@fittrack.example',
    name: 'FitTrack',
    category: 'notifications',
    count: 388,
    unreadPct: 100,
    unsub: 'link',
  },
  {
    address: 'style@lumen.example',
    name: 'Lumen Fashion',
    category: 'promotions',
    count: 354,
    unreadPct: 96,
    unsub: 'one-click',
  },
  {
    address: 'updates@parcelwise.example',
    name: 'Parcelwise',
    category: 'notifications',
    count: 290,
    unreadPct: 64,
  },
  {
    address: 'issues@designweekly.example',
    name: 'Design Weekly',
    category: 'newsletters',
    count: 233,
    unreadPct: 40,
    unsub: 'link',
  },
  {
    address: 'statements@cornerbank.example',
    name: 'Corner Bank',
    category: 'receipts',
    count: 118,
    unreadPct: 12,
  },
  { address: 'sam.patel@icloud.example', name: 'Sam Patel', category: 'people', count: 87, unreadPct: 0 },
]

export const SAMPLE_CATEGORY = new Map(SENDERS.map((s) => [s.address, s.category]))

export function sampleHeaders(): MessageHeader[] {
  const out: MessageHeader[] = []
  let uid = 1
  for (const s of SENDERS) {
    const host = s.address.split('@')[1]
    for (let i = 0; i < s.count; i++) {
      out.push({
        uid: uid++,
        mailbox: 'INBOX',
        date: new Date(Date.UTC(2026, 10, 15) - i * 86_400_000 * 0.7),
        seen: i >= Math.round((s.count * s.unreadPct) / 100),
        from: { address: s.address, name: s.name },
        subject: `${s.name} update ${s.count - i}`,
        listUnsubscribe: s.unsub ? `<https://${host}/unsubscribe>` : undefined,
        listUnsubscribePost: s.unsub === 'one-click' ? 'List-Unsubscribe=One-Click' : undefined,
      })
    }
  }
  return out
}
