import type { UnsubscribeMethod } from './types'

export interface UnsubscribeParseOptions {
  /**
   * Treat `http://127.0.0.1` (and localhost) like https. Only for tests of an
   * unpackaged build, which point one-click unsubscribe at a local server.
   */
  allowLoopbackHttp?: boolean
}

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i

/** True for an https URL, or a loopback http URL when the test option allows it. */
export function isSecureUrl(url: string, opts: UnsubscribeParseOptions = {}): boolean {
  return /^https:\/\//i.test(url) || Boolean(opts.allowLoopbackHttp && LOOPBACK.test(url))
}

/**
 * Pick the best unsubscribe method from List-Unsubscribe headers (RFC 2369)
 * and List-Unsubscribe-Post (RFC 8058).
 *
 * Preference: one-click (https only) > https link > mailto > plain http link.
 * A plain http link is only ever opened after the review sheet has shown it.
 */
export function parseUnsubscribe(
  listUnsubscribe?: string,
  listUnsubscribePost?: string,
  opts: UnsubscribeParseOptions = {},
): UnsubscribeMethod {
  if (!listUnsubscribe) return { kind: 'none' }
  const targets = [...listUnsubscribe.matchAll(/<([^>]+)>/g)].map((m) => m[1]!.trim())
  const secure = targets.find((t) => isSecureUrl(t, opts))
  const http = targets.find((t) => /^http:\/\/\S+$/i.test(t))
  const mailto = targets.find((t) => /^mailto:/i.test(t))
  const oneClick = /List-Unsubscribe=One-Click/i.test(listUnsubscribePost ?? '')
  if (secure && oneClick) return { kind: 'one-click', url: secure }
  if (secure) return { kind: 'link', url: secure }
  if (mailto) {
    const address = parseMailto(mailto)?.to[0]
    if (address) return { kind: 'mailto', address, url: mailto }
  }
  if (http) return { kind: 'link', url: http }
  return { kind: 'none' }
}

/** How strongly to prefer a method when one sender's messages disagree. */
export function unsubscribeRank(m: UnsubscribeMethod): number {
  switch (m.kind) {
    case 'one-click':
      return 4
    case 'link':
      return /^https:/i.test(m.url) ? 3 : 1
    case 'mailto':
      return 2
    default:
      return 0
  }
}

export interface MailtoMessage {
  to: string[]
  subject: string
  body: string
}

const ADDRESS = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/

/**
 * Parse a mailto: URL (RFC 6068) into recipients, subject and body. Only `to`,
 * `subject` and `body` are honoured: cc, bcc and other headers are ignored so an
 * unsubscribe can't copy anyone else in. Returns null without a valid address.
 */
export function parseMailto(url: string): MailtoMessage | null {
  const m = /^mailto:([^?]*)(?:\?(.*))?$/i.exec(url.trim())
  if (!m) return null
  // RFC 6068 is percent-encoding only: '+' is a literal plus (unsub+id@list.example).
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  }
  const to = m[1] ? m[1].split(',').map((a) => decode(a).trim()) : []
  let subject = ''
  let body = ''
  for (const pair of (m[2] ?? '').split('&')) {
    if (!pair) continue
    const [rawKey = '', ...rest] = pair.split('=')
    const key = rawKey.toLowerCase()
    const value = decode(rest.join('='))
    if (key === 'to') to.push(...value.split(',').map((a) => a.trim()))
    else if (key === 'subject') subject = value
    else if (key === 'body') body = value
  }
  const valid = [...new Set(to.filter((a) => ADDRESS.test(a)).map((a) => a.toLowerCase()))].slice(0, 3)
  if (!valid.length) return null
  return { to: valid, subject: subject || 'unsubscribe', body: body || 'unsubscribe' }
}
