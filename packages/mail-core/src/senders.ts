import type { MessageHeader, SenderSummary, UnsubscribeMethod } from './types'
import { parseUnsubscribe } from './unsubscribe'

const RANK: Record<UnsubscribeMethod['kind'], number> = { 'one-click': 3, link: 2, mailto: 1, none: 0 }

/** Group scanned headers by normalised sender address, newest-first samples. */
export function groupBySender(headers: Iterable<MessageHeader>, sampleSize = 5): SenderSummary[] {
  const map = new Map<string, SenderSummary & { _samples: { date: Date; subject: string }[] }>()
  for (const h of headers) {
    const address = h.from.address.trim().toLowerCase()
    let s = map.get(address)
    if (!s) {
      s = {
        address,
        name: h.from.name,
        domain: address.split('@')[1] ?? '',
        listId: h.listId,
        count: 0,
        unread: 0,
        firstSeen: h.date,
        lastSeen: h.date,
        sampleSubjects: [],
        unsubscribe: { kind: 'none' },
        _samples: [],
      }
      map.set(address, s)
    }
    s.count++
    if (!h.seen) s.unread++
    if (h.date < s.firstSeen) s.firstSeen = h.date
    if (h.date >= s.lastSeen) {
      s.lastSeen = h.date
      if (h.from.name) s.name = h.from.name
    }
    s.listId ??= h.listId
    const unsub = parseUnsubscribe(h.listUnsubscribe, h.listUnsubscribePost)
    if (RANK[unsub.kind] > RANK[s.unsubscribe.kind]) s.unsubscribe = unsub
    s._samples.push({ date: h.date, subject: h.subject })
  }
  return [...map.values()]
    .map(({ _samples, ...s }) => ({
      ...s,
      sampleSubjects: _samples
        .sort((a, b) => b.date.getTime() - a.date.getTime())
        .slice(0, sampleSize)
        .map((x) => x.subject),
    }))
    .sort((a, b) => b.count - a.count)
}
