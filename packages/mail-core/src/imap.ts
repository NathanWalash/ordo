import { ImapFlow } from 'imapflow'
import { SCAN_HEADER_FIELDS, toMessageHeader } from './headers'
import type { MailboxStatus, MailProvider, MessageHeader, SpecialMailbox } from './types'

export interface ImapConfig {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
}

export const ICLOUD_IMAP = { host: 'imap.mail.me.com', port: 993, secure: true } as const

/** The server rejected the username or password. */
export class MailAuthError extends Error {
  override name = 'MailAuthError'
}
/** The server couldn't be reached or dropped the connection. */
export class MailConnectionError extends Error {
  override name = 'MailConnectionError'
}

function wrap(err: unknown): Error {
  const e = err as { authenticationFailed?: boolean; responseText?: string; code?: string; message?: string }
  if (e?.authenticationFailed || /auth/i.test(e?.responseText ?? ''))
    return new MailAuthError(e.responseText || 'Authentication failed')
  if (e?.code && /^(ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|NoConnection)$/.test(e.code))
    return new MailConnectionError(e.message ?? e.code)
  return err instanceof Error ? err : new Error(String(err))
}

/** IMAP access for iCloud (or any IMAP server, for tests). Read-mostly: only moveToTrash changes anything. */
export class ImapMailProvider implements MailProvider {
  private client: ImapFlow

  constructor(cfg: ImapConfig) {
    this.client = new ImapFlow({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      logger: false,
      emitLogs: false,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
    })
    // Without a listener, a dropped socket would crash the process.
    this.client.on('error', () => {})
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect()
    } catch (err) {
      throw wrap(err)
    }
  }

  async status(mailbox: string): Promise<MailboxStatus> {
    const s = await this.client.status(mailbox, { messages: true, uidNext: true, uidValidity: true })
    if (!s) throw new Error(`Couldn't read mailbox ${mailbox}`)
    return { messages: s.messages ?? 0, uidNext: s.uidNext ?? 1, uidValidity: String(s.uidValidity ?? '0') }
  }

  async *fetchHeaders(mailbox: string, fromUid: number): AsyncIterable<MessageHeader> {
    const lock = await this.client.getMailboxLock(mailbox, { readOnly: true })
    try {
      const mb = this.client.mailbox
      if (!mb || mb.exists === 0) return
      for await (const msg of this.client.fetch(
        `${Math.max(1, fromUid)}:*`,
        { uid: true, flags: true, internalDate: true, envelope: true, headers: [...SCAN_HEADER_FIELDS] },
        { uid: true },
      )) {
        // `n:*` always returns the last message, even if its UID is below n.
        if (msg.uid < fromUid) continue
        const h = toMessageHeader(msg, mailbox)
        if (h) yield h
      }
    } finally {
      lock.release()
    }
  }

  async findMailbox(use: SpecialMailbox): Promise<string | null> {
    const list = await this.client.list()
    return list.find((m) => m.specialUse === use)?.path ?? null
  }

  async fetchRecipients(mailbox: string, limit: number): Promise<string[]> {
    const lock = await this.client.getMailboxLock(mailbox, { readOnly: true })
    try {
      const exists = this.client.mailbox ? this.client.mailbox.exists : 0
      if (!exists) return []
      const out = new Set<string>()
      for await (const msg of this.client.fetch(`${Math.max(1, exists - limit + 1)}:*`, { envelope: true })) {
        for (const r of [...(msg.envelope?.to ?? []), ...(msg.envelope?.cc ?? [])])
          if (r.address) out.add(r.address.trim().toLowerCase())
      }
      return [...out]
    } finally {
      lock.release()
    }
  }

  async moveToTrash(mailbox: string, uids: number[]): Promise<void> {
    if (!uids.length) return
    const trash = await this.findMailbox('\\Trash')
    if (!trash) throw new Error('No Trash mailbox found')
    const lock = await this.client.getMailboxLock(mailbox)
    try {
      await this.client.messageMove(uids.join(','), trash, { uid: true })
    } finally {
      lock.release()
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.logout()
    } catch {
      this.client.close()
    }
  }
}

/** Sign in and out again, to check credentials. */
export async function testImapLogin(cfg: ImapConfig): Promise<void> {
  const p = new ImapMailProvider(cfg)
  await p.connect()
  await p.close()
}
