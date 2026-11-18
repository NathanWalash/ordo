import type { Address, MessageHeader } from './types'

/**
 * Parse a raw RFC 5322 header block into lower-cased name → value pairs.
 * Folded lines are unfolded; for repeated headers the first one wins.
 */
export function parseHeaderBlock(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  const unfolded = raw.replace(/\r?\n[ \t]+/g, ' ')
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const name = line.slice(0, i).trim().toLowerCase()
    if (!(name in out)) out[name] = line.slice(i + 1).trim()
  }
  return out
}

/** The subset of an IMAP FETCH response we use; matches imapflow's FetchMessageObject. */
export interface RawFetchedMessage {
  uid: number
  flags?: Set<string>
  internalDate?: Date | string
  envelope?: {
    date?: Date | string
    subject?: string
    messageId?: string
    from?: RawAddress[]
    to?: RawAddress[]
    cc?: RawAddress[]
  }
  headers?: Uint8Array | string
}

interface RawAddress {
  name?: string
  address?: string
}

/** Envelope addresses, without empty ones (group syntax) and with names trimmed. */
export function toAddresses(list: readonly RawAddress[] | undefined): Address[] {
  const out: Address[] = []
  for (const a of list ?? []) {
    const address = a.address?.trim()
    if (!address) continue
    const name = a.name?.trim()
    out.push(name ? { address, name } : { address })
  }
  return out
}

export const SCAN_HEADER_FIELDS = [
  'list-id',
  'list-unsubscribe',
  'list-unsubscribe-post',
  'precedence',
  'auto-submitted',
  'content-type',
] as const

/** Convert one fetched message to a MessageHeader, or null if it has no usable sender. */
export function toMessageHeader(msg: RawFetchedMessage, mailbox: string): MessageHeader | null {
  const from = msg.envelope?.from?.[0]
  const address = from?.address?.trim()
  if (!address) return null
  const raw =
    typeof msg.headers === 'string' ? msg.headers : msg.headers ? new TextDecoder().decode(msg.headers) : ''
  const h = parseHeaderBlock(raw)
  const when = msg.envelope?.date ?? msg.internalDate
  const date = when ? new Date(when) : new Date(0)
  return {
    uid: msg.uid,
    mailbox,
    date: Number.isNaN(date.getTime()) ? new Date(0) : date,
    seen: msg.flags?.has('\\Seen') ?? false,
    from: { address, name: from?.name?.trim() || undefined },
    subject: msg.envelope?.subject ?? '',
    listId: h['list-id'],
    listUnsubscribe: h['list-unsubscribe'],
    listUnsubscribePost: h['list-unsubscribe-post'],
    precedence: h['precedence'],
    autoSubmitted: h['auto-submitted'],
    flagged: msg.flags?.has('\\Flagged') ?? false,
    answered: msg.flags?.has('\\Answered') ?? false,
    to: toAddresses(msg.envelope?.to),
    cc: toAddresses(msg.envelope?.cc),
    messageId: msg.envelope?.messageId?.trim() || undefined,
    hasAttachments: /^\s*multipart\/mixed\b/i.test(h['content-type'] ?? '') || undefined,
  }
}
