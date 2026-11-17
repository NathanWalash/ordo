import { createTransport } from 'nodemailer'
import { hasControlChars, MAILTO_PER_CLEANUP_MAX, type MailtoMessage } from './unsubscribe'

export interface SmtpConfig {
  host: string
  port: number
  /** TLS from the start (port 465). iCloud uses STARTTLS on 587 instead. */
  secure: boolean
  /** Refuse to send unless the server upgrades to TLS with STARTTLS. */
  requireTLS: boolean
  user: string
  pass: string
}

/** iCloud Mail's SMTP server: STARTTLS on 587, same app-specific password as IMAP. */
export const ICLOUD_SMTP = { host: 'smtp.mail.me.com', port: 587, secure: false, requireTLS: true } as const

/**
 * A sender for mailto: unsubscribes, checked by planMailto first. One SMTP
 * connection is reused until close(). Each message has one recipient, a plain
 * text body, no attachments and no headers beyond From, To, Subject, Date and
 * Message-ID (plus the MIME headers a text body needs). Refuses to send more
 * than `limit` messages.
 */
export function createMailtoSender(cfg: SmtpConfig, from: string, limit = MAILTO_PER_CLEANUP_MAX) {
  let sent = 0
  const transport = createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: cfg.requireTLS,
    auth: { user: cfg.user, pass: cfg.pass },
    pool: true,
    maxConnections: 1,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  })
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
