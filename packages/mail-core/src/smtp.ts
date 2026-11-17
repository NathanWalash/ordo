import { createTransport } from 'nodemailer'
import type { MailtoMessage } from './unsubscribe'

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
 * A sender for mailto: unsubscribes. One SMTP connection is reused for every
 * message until close(). Only the parsed to/subject/body are used.
 */
export function createMailtoSender(cfg: SmtpConfig, from: string) {
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
      await transport.sendMail({ from, to: msg.to, subject: msg.subject, text: msg.body })
    },
    close(): void {
      transport.close()
    },
  }
}
