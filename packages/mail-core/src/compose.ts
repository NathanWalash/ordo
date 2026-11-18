import { formatAddressList, parseAddressList } from './address'
import type { Address, MessageContent } from './types'
import { hasControlChars } from './unsubscribe'

/** Limits on a message written in Ordo, checked in the window and again in the main process. */
export const COMPOSE_LIMITS = {
  /** To, Cc and Bcc together. Ordo is for personal mail, not mailing lists. */
  recipients: 50,
  subject: 500,
  /** Characters of body text. */
  body: 1_000_000,
  attachments: 20,
  /** iCloud Mail refuses messages over 20 MB; attachments grow by a third when encoded. */
  attachmentBytes: 14 * 1024 * 1024,
  /** References kept when threading a reply. */
  references: 20,
} as const

const RE = /^\s*re\s*:/i
const FWD = /^\s*(fwd?|fw)\s*:/i

export const replySubject = (subject: string) => (RE.test(subject) ? subject.trim() : `Re: ${subject.trim()}`)
export const forwardSubject = (subject: string) =>
  FWD.test(subject) ? subject.trim() : `Fwd: ${subject.trim()}`

type Original = Pick<MessageContent, 'from' | 'to' | 'cc' | 'replyTo'>

/**
 * Who a reply goes to. Reply: the Reply-To address, or the sender. Reply all: also everyone else
 * the message went to, never yourself. Replying to your own message (in Sent) goes to its recipients.
 */
export function replyRecipients(
  m: Original,
  own: readonly string[],
  all: boolean,
): { to: Address[]; cc: Address[] } {
  const mine = new Set(own.map((a) => a.toLowerCase()))
  const isMine = (a: Address) => mine.has(a.address.toLowerCase())
  const seen = new Set<string>()
  const take = (list: readonly Address[]) =>
    list.filter((a) => {
      const k = a.address.toLowerCase()
      if (isMine(a) || seen.has(k)) return false
      seen.add(k)
      return true
    })

  const fromMe = m.from ? isMine(m.from) : false
  const base = fromMe ? m.to : m.replyTo.length ? m.replyTo : m.from ? [m.from] : []
  const to = take(base)
  if (!all) return { to: to.length || fromMe ? to : take(m.to), cc: [] }
  const more = take(fromMe ? [] : m.to)
  return { to: [...to, ...more], cc: take(m.cc) }
}

/** The thread a reply belongs to: the original's References plus its Message-ID, at most 20. */
export function referencesFor(m: Pick<MessageContent, 'references' | 'messageId'>): string[] {
  const all = [...m.references, ...(m.messageId ? [m.messageId] : [])].filter(
    (id) => /^<[^<>\s]+>$/.test(id) && !hasControlChars(id),
  )
  return [...new Set(all)].slice(-COMPOSE_LIMITS.references)
}

const quote = (text: string) =>
  text
    .split('\n')
    .map((l) => (l.startsWith('>') ? `>${l}` : `> ${l}`).trimEnd())
    .join('\n')

/** A reply's starting text: a blank line to write in, then the original quoted. */
export function replyBody(m: Pick<MessageContent, 'from' | 'date'>, text: string, when: string): string {
  const who = m.from ? (m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address) : 'Someone'
  return `\n\nOn ${when}, ${who} wrote:\n\n${quote(text.slice(0, COMPOSE_LIMITS.body / 2))}\n`
}

/** A forward's starting text: a blank line, then the original's headers and text. */
export function forwardBody(
  m: Pick<MessageContent, 'from' | 'to' | 'cc' | 'subject'>,
  text: string,
  when: string,
): string {
  const lines = [
    '---------- Forwarded message ----------',
    `From: ${m.from ? formatAddressList([m.from]) : ''}`,
    `Date: ${when}`,
    `Subject: ${m.subject}`,
    `To: ${formatAddressList(m.to)}`,
    ...(m.cc.length ? [`Cc: ${formatAddressList(m.cc)}`] : []),
  ]
  return `\n\n${lines.join('\n')}\n\n${text.slice(0, COMPOSE_LIMITS.body / 2)}\n`
}

/** What a mailto: link in an email may fill in. Never Bcc, never other headers. */
export interface MailtoDraft {
  to: string
  cc: string
  subject: string
  body: string
}

const MAILTO_LINK_RECIPIENTS = 10
const MAILTO_LINK_BODY = 10_000

/**
 * Parse a mailto: link someone clicked in an email, to start a new message the user then reads
 * and sends (or not). Unlike unsubscribe mailto: (parseMailto), several recipients are fine, but
 * only To, Cc, Subject and Body are taken, a Bcc is dropped so nobody is copied in unseen, and
 * everything is limited. Returns null for anything that isn't a usable mailto: link.
 */
export function parseMailtoLink(url: string): MailtoDraft | null {
  const m = /^mailto:([^?#]*)(?:\?([^#]*))?/i.exec(url.trim())
  if (!m) return null
  const decode = (v: string) => {
    try {
      return decodeURIComponent(v)
    } catch {
      return null
    }
  }
  const to: string[] = []
  const cc: string[] = []
  let subject = ''
  let body = ''
  const path = decode(m[1] ?? '')
  if (path === null) return null
  if (path) to.push(path)
  for (const pair of (m[2] ?? '').split('&')) {
    if (!pair) continue
    const [rawKey = '', ...rest] = pair.split('=')
    const key = decode(rawKey)?.toLowerCase()
    const value = decode(rest.join('='))
    if (key === undefined || value === null) return null
    if (key === 'to') to.push(value)
    else if (key === 'cc') cc.push(value)
    else if (key === 'subject') subject = value
    else if (key === 'body') body = value
  }
  const toList = parseAddressList(to.join(','))
  const ccList = parseAddressList(cc.join(','))
  if (toList.invalid.length || ccList.invalid.length) return null
  if (toList.addresses.length + ccList.addresses.length > MAILTO_LINK_RECIPIENTS) return null
  if (!toList.addresses.length && !ccList.addresses.length) return null
  return {
    to: formatAddressList(toList.addresses),
    cc: formatAddressList(ccList.addresses),
    // eslint-disable-next-line no-control-regex -- removing control characters is the point
    subject: subject.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, COMPOSE_LIMITS.subject),
    body: body.replace(/\r\n?/g, '\n').slice(0, MAILTO_LINK_BODY),
  }
}
