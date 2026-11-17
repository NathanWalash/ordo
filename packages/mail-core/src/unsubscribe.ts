import { getDomain } from 'tldts'
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
    const address = parseMailto(mailto)?.to
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

/** The unsubscribe email Ordo will send: one recipient, a one-line subject, a short plain body. */
export interface MailtoMessage {
  to: string
  subject: string
  body: string
}

/** A mailto: URL taken apart, before any of it is trusted. */
export interface ParsedMailto {
  to: string
  subject?: string
  body?: string
}

export const MAILTO_SUBJECT_MAX = 200
export const MAILTO_BODY_MAX = 500
/** At most this many unsubscribe emails go out in one clean-up. */
export const MAILTO_PER_CLEANUP_MAX = 50

const ADDRESS =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/
/** Any C0 control character or DEL, including CR and LF. */
export function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}

/**
 * Parse a mailto: URL (RFC 6068) from an untrusted List-Unsubscribe header.
 * Strict: exactly one valid address in the path, and no `to`, `cc` or `bcc`
 * fields, so an unsubscribe can never reach anyone else. Returns null otherwise.
 */
export function parseMailto(url: string): ParsedMailto | null {
  const m = /^mailto:([^?#]*)(?:\?([^#]*))?$/i.exec(url.trim())
  if (!m) return null
  // RFC 6068 is percent-encoding only: '+' is a literal plus (unsub+id@list.example).
  const decode = (v: string) => {
    try {
      return decodeURIComponent(v)
    } catch {
      return null
    }
  }
  const to = decode(m[1] ?? '')
  if (!to || to.includes(',') || hasControlChars(to) || !ADDRESS.test(to)) return null
  const out: ParsedMailto = { to: to.toLowerCase() }
  for (const pair of (m[2] ?? '').split('&')) {
    if (!pair) continue
    const [rawKey = '', ...rest] = pair.split('=')
    const key = decode(rawKey)?.toLowerCase()
    const value = decode(rest.join('='))
    if (key === undefined || value === null) return null
    if (key === 'to' || key === 'cc' || key === 'bcc') return null
    if (key === 'subject' || key === 'body') {
      if (out[key] !== undefined) return null
      out[key] = value
    }
    // Any other header field is dropped: Ordo only ever sets From, To, Subject, Date and Message-ID.
  }
  return out
}

/** Registrable domain (public-suffix aware), e.g. mail.shop.co.uk -> shop.co.uk. */
export function registrableDomain(host: string): string {
  const h = host.trim().toLowerCase().replace(/\.$/, '')
  return getDomain(h, { allowPrivateDomains: true }) ?? h
}

/** The host-like part of a List-Id header: `Weekly <weekly.news.example>` -> weekly.news.example. */
export function listIdHost(listId?: string): string | null {
  if (!listId) return null
  const id = (/<([^>]+)>/.exec(listId)?.[1] ?? listId).trim().toLowerCase()
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(id) ? id : null
}

export interface MailtoPlan {
  message: MailtoMessage
  /**
   * The recipient isn't on the sender's or the list's registrable domain. Ordo
   * won't send it unless the user ticks it in the review sheet.
   */
  offDomain: boolean
}

const URLISH = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)([^\s/?#<>"'()]+)/gi

/**
 * Decide exactly what the unsubscribe email would say, for a sender (whose From
 * domain and List-Id identify the list). Subject and body come from the header
 * only when they are short, single-purpose plain text; otherwise "unsubscribe".
 */
export function planMailto(url: string, sender: { domain: string; listId?: string }): MailtoPlan | null {
  const parsed = parseMailto(url)
  if (!parsed) return null
  const own = new Set(
    [sender.domain, listIdHost(sender.listId)].filter((d): d is string => Boolean(d)).map(registrableDomain),
  )
  const subject = parsed.subject?.trim()
  const body = parsed.body?.trim()
  const subjectOk = subject && subject.length <= MAILTO_SUBJECT_MAX && !hasControlChars(subject)
  const bodyOk =
    body &&
    body.length <= MAILTO_BODY_MAX &&
    !hasControlChars(body) &&
    !/<[a-z!/?]/i.test(body) &&
    [...body.matchAll(URLISH)].every((u) =>
      own.has(registrableDomain(u[1]!.replace(/:\d+$/, '').split('@').pop()!)),
    )
  return {
    message: {
      to: parsed.to,
      subject: subjectOk ? subject : 'unsubscribe',
      body: bodyOk ? body : 'unsubscribe',
    },
    offDomain: !own.has(registrableDomain(parsed.to.split('@')[1]!)),
  }
}
