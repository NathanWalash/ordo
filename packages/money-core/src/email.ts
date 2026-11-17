// Subscription signals from email headers. Sender and subject only, rules only;
// a local model may refine these later through a MatchAdvisor.

import type { MessageHeader } from '@ordo/mail-core'
import { toISODate } from './dates'
import { domainKey, merchantKey } from './merchant'
import type { EmailHint, EmailHintKind } from './types'

/** Checked in order: the first match decides the kind. */
const KINDS: [EmailHintKind, RegExp][] = [
  [
    'trial-ending',
    /\b(free )?trial\b.*\b(end|ends|ending|expires?|expiring|over|last day|almost up|reminder)\b|\b(end|ending|expires?) of (your )?(free )?trial\b|\btrial (period )?reminder\b/i,
  ],
  [
    'price-change',
    /\bprice (change|changes|increase|increases|update|updates|rise)\b|\b(new|updated) (price|pricing|plan price)\b|\b(updates?|changes?) to your (plan |subscription |membership )?(price|pricing)\b|\bprices? (is|are) (changing|going up|increasing)\b|\bchang\w* (the |your )?(price|pricing)\b/i,
  ],
  [
    'renewal',
    /\b(renew(s|al|ed|ing)?|auto-?renew\w*|upcoming (payment|charge|renewal)|will be (charged|billed)|subscription (confirmed|renewed|is active)|membership (renew\w*|payment))\b/i,
  ],
  [
    'receipt',
    /\b(receipt|invoice|your (monthly )?(bill|statement) is ready|payment (received|confirmation|successful|processed)|thanks for your payment|billing (statement|update)|your subscription|subscription payment)\b/i,
  ],
]

/** Words in sender names that say nothing about the business. */
const GENERIC =
  /\b(billing|payments?|receipts?|invoices?|team|support|accounts?|notifications?|no-?reply|do not reply|customer( service| care)?|info|hello|via|the|uk|members(hip)?|subscriptions?)\b/gi

function merchantFrom(h: MessageHeader): { merchant: string; domain: string } {
  const domain = h.from.address.split('@')[1]?.toLowerCase() ?? ''
  const name = (h.from.name ?? '')
    .replace(GENERIC, ' ')
    .replace(/[^\p{L}\p{N}&+' ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (name && merchantKey(name).length >= 2) return { merchant: name, domain }
  const label = domainKey(domain)
  return { merchant: label.charAt(0).toUpperCase() + label.slice(1), domain }
}

/** Classify one subject line, or null when it isn't about a subscription. */
export function hintKind(subject: string): EmailHintKind | null {
  for (const [kind, re] of KINDS) if (re.test(subject)) return kind
  return null
}

/**
 * Subscription hints from message headers, one per merchant and kind, newest first.
 * Typically fed the inbox headers Mail has already cached.
 */
export function emailHints(headers: Iterable<MessageHeader>): EmailHint[] {
  const byKey = new Map<string, EmailHint>()
  for (const h of headers) {
    const kind = hintKind(h.subject)
    if (!kind) continue
    const { merchant, domain } = merchantFrom(h)
    const key = `${merchantKey(merchant)}|${kind}`
    const seen = toISODate(h.date)
    const prev = byKey.get(key)
    if (!prev) byKey.set(key, { merchant, domain, kind, lastSeen: seen, count: 1, subject: h.subject })
    else {
      prev.count++
      if (seen >= prev.lastSeen) Object.assign(prev, { lastSeen: seen, subject: h.subject })
    }
  }
  return [...byKey.values()].sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0))
}

/** The keys an email hint can match a bank merchant by: its name and its domain. */
export function hintKeys(h: EmailHint): string[] {
  return [merchantKey(h.merchant), domainKey(h.domain)].filter(Boolean)
}
