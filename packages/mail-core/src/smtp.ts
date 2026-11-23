import { createTransport } from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'
import { isEmailAddress } from './address'
import { COMPOSE_LIMITS } from './compose'
import { authOf } from './imap'
import type { Address } from './types'
import { hasControlChars, MAILTO_PER_CLEANUP_MAX, type MailtoMessage } from './unsubscribe'

export interface SmtpConfig {
  host: string
  port: number
  /** TLS from the start (port 465). iCloud uses STARTTLS on 587 instead. */
  secure: boolean
  /** Refuse to send unless the server upgrades to TLS with STARTTLS. */
  requireTLS: boolean
  user: string
  /** A password. Leave out when signing in with `accessToken`. */
  pass?: string
  /** An OAuth 2 access token (XOAUTH2), instead of a password. */
  accessToken?: string
}

/** Nodemailer's auth for a config: OAuth 2 with an access token, or a plain login. */
function smtpAuth(cfg: SmtpConfig) {
  const a = authOf(cfg)
  return 'accessToken' in a
    ? { type: 'OAuth2' as const, user: a.user, accessToken: a.accessToken }
    : { user: a.user, pass: a.pass }
}

/** iCloud Mail's SMTP server: STARTTLS on 587, same app-specific password as IMAP. */
export const ICLOUD_SMTP = { host: 'smtp.mail.me.com', port: 587, secure: false, requireTLS: true } as const

const transportFor = (cfg: SmtpConfig, pool: boolean) =>
  createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: cfg.requireTLS,
    auth: smtpAuth(cfg),
    ...(pool && { pool: true, maxConnections: 1 }),
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: pool ? 30_000 : 60_000,
  })

/**
 * A sender for mailto: unsubscribes, checked by planMailto first. One SMTP
 * connection is reused until close(). Each message has one recipient, a plain
 * text body, no attachments and no headers beyond From, To, Subject, Date and
 * Message-ID (plus the MIME headers a text body needs). Refuses to send more
 * than `limit` messages.
 */
export function createMailtoSender(cfg: SmtpConfig, from: string, limit = MAILTO_PER_CLEANUP_MAX) {
  let sent = 0
  const transport = transportFor(cfg, true)
  return {
    async send(msg: MailtoMessage): Promise<void> {
      if (sent >= limit) throw new Error(`Ordo sends at most ${limit} unsubscribe emails at a time`)
      if (hasControlChars(msg.to) || hasControlChars(msg.subject) || msg.to.includes(','))
        throw new Error('Refused an unsafe unsubscribe email')
      sent++
      await transport.sendMail({
        from,
        to: msg.to,
        subject: msg.subject,
        text: msg.body,
        disableFileAccess: true,
        disableUrlAccess: true,
      })
    },
    close(): void {
      transport.close()
    },
  }
}

/** A message written in Ordo. Check it with checkOutgoing before building it. */
export interface OutgoingMessage {
  from: Address
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  text: string
  /** Message-ID of the message this replies to, and the thread's References. */
  inReplyTo?: string
  references?: string[]
  attachments: { filename: string; contentType?: string; content: Buffer }[]
}

/**
 * Why Ordo won't build this message, or null. Header values must be single lines (no header
 * injection), addresses valid, and the counts and sizes within COMPOSE_LIMITS.
 */
export function checkOutgoing(m: OutgoingMessage, opts: { needRecipients: boolean }): string | null {
  const all = [m.from, ...m.to, ...m.cc, ...m.bcc]
  if (all.some((a) => !isEmailAddress(a.address) || hasControlChars(a.name ?? '')))
    return 'One of the addresses isn’t valid.'
  const count = m.to.length + m.cc.length + m.bcc.length
  if (opts.needRecipients && count === 0) return 'Add at least one recipient.'
  if (count > COMPOSE_LIMITS.recipients)
    return `Ordo sends to at most ${COMPOSE_LIMITS.recipients} people at once.`
  if (hasControlChars(m.subject) || m.subject.length > COMPOSE_LIMITS.subject)
    return 'The subject isn’t valid.'
  if (m.text.length > COMPOSE_LIMITS.body) return 'The message is too long.'
  const ids = [...(m.inReplyTo ? [m.inReplyTo] : []), ...(m.references ?? [])]
  if (ids.some((id) => !/^<[^<>\s]+>$/.test(id) || hasControlChars(id)))
    return 'The reply’s thread isn’t valid.'
  if (m.attachments.length > COMPOSE_LIMITS.attachments)
    return `Attach at most ${COMPOSE_LIMITS.attachments} files.`
  if (m.attachments.some((a) => hasControlChars(a.filename) || hasControlChars(a.contentType ?? '')))
    return 'An attachment’s name isn’t valid.'
  if (m.attachments.reduce((n, a) => n + a.content.length, 0) > COMPOSE_LIMITS.attachmentBytes)
    return 'The attachments are too big to send by email.'
  return null
}

/**
 * The raw RFC 5322 message, plain text. Nodemailer never reads files or URLs here: every
 * attachment is already in memory. With `keepBcc` (the copy saved to Sent or Drafts) the Bcc
 * header stays; the copy that is sent leaves it out, so Bcc recipients stay hidden.
 */
export async function buildMessage(
  m: OutgoingMessage,
  opts: { keepBcc: boolean; messageId?: string; date?: Date },
): Promise<{ raw: Buffer; messageId: string }> {
  const problem = checkOutgoing(m, { needRecipients: false })
  if (problem) throw new Error(problem)
  const node = new MailComposer({
    from: m.from,
    to: m.to,
    cc: m.cc,
    bcc: m.bcc,
    subject: m.subject,
    text: m.text,
    ...(m.inReplyTo && { inReplyTo: m.inReplyTo }),
    ...(m.references?.length && { references: m.references }),
    ...(opts.messageId && { messageId: opts.messageId }),
    date: opts.date ?? new Date(),
    attachments: m.attachments.map((a) => ({
      filename: a.filename,
      content: a.content,
      ...(a.contentType && { contentType: a.contentType }),
    })),
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile()
  node.keepBcc = opts.keepBcc
  const raw = await node.build()
  return { raw, messageId: node.messageId() }
}

/**
 * Send a message by SMTP (iCloud: smtp.mail.me.com:587, STARTTLS required). Returns the copy
 * to keep in Sent, with its Bcc header, and the Message-ID both share.
 */
export async function sendMessage(
  cfg: SmtpConfig,
  m: OutgoingMessage,
  deps: { transport?: SendTransport } = {},
): Promise<{ sentCopy: Buffer; messageId: string; rejected: string[] }> {
  const problem = checkOutgoing(m, { needRecipients: true })
  if (problem) throw new Error(problem)
  const date = new Date()
  const sent = await buildMessage(m, { keepBcc: false, date })
  const copy = await buildMessage(m, { keepBcc: true, date, messageId: sent.messageId })
  const transport = deps.transport ?? (transportFor(cfg, false) as unknown as SendTransport)
  let info: unknown
  try {
    info = await transport.sendMail({
      envelope: { from: m.from.address, to: [...m.to, ...m.cc, ...m.bcc].map((a) => a.address) },
      raw: sent.raw,
    })
  } catch (err) {
    const e = err as { code?: string; rejected?: unknown }
    if (e?.code === 'EENVELOPE') throw new RecipientsRefused(addressesIn(e.rejected))
    throw err
  } finally {
    transport.close()
  }
  return {
    sentCopy: copy.raw,
    messageId: sent.messageId,
    rejected: addressesIn((info as { rejected?: unknown } | undefined)?.rejected),
  }
}

/** What sendMessage needs from a nodemailer transport; tests pass a fake. */
export interface SendTransport {
  sendMail(mail: { envelope: { from: string; to: string[] }; raw: Buffer }): Promise<unknown>
  close(): void
}

/** The server refused every recipient (or the sender), so nothing was sent. */
export class RecipientsRefused extends Error {
  override name = 'RecipientsRefused'
  constructor(readonly recipients: string[]) {
    super(recipients.length ? `Refused: ${recipients.join(', ')}` : 'The server refused the recipients')
  }
}

/** Addresses from nodemailer's accepted/rejected lists, which hold strings or {address}. */
function addressesIn(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  return list
    .map((x) => (typeof x === 'string' ? x : typeof x?.address === 'string' ? (x.address as string) : ''))
    .filter((a) => a && !hasControlChars(a))
    .slice(0, COMPOSE_LIMITS.recipients)
}
