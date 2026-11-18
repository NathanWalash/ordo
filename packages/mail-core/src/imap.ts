import { ImapFlow } from 'imapflow'
import { SCAN_HEADER_FIELDS, toMessageHeader } from './headers'
import type { MailboxStatus, MailProvider, MessageHeader, MoveResult, SpecialMailbox } from './types'

export interface ImapConfig {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  /** How long to wait for the connection, and then for the server's greeting. Default 15 seconds. */
  timeoutMs?: number
}

export const ICLOUD_IMAP = { host: 'imap.mail.me.com', port: 993, secure: true } as const

/** The server rejected the username or password. */
export class MailAuthError extends Error {
  override name = 'MailAuthError'
}

/**
 * Why the server couldn't be talked to: `offline` (no network, DNS failed, nothing listening),
 * `timeout` (no answer in time), `tls` (the secure connection failed: a Wi-Fi sign-in page, or a
 * VPN or antivirus that inspects traffic) or `dropped` (the connection closed part way).
 */
export type MailConnectionReason = 'offline' | 'timeout' | 'tls' | 'dropped'

/** The server couldn't be reached or dropped the connection. */
export class MailConnectionError extends Error {
  override name = 'MailConnectionError'
  constructor(
    message: string,
    readonly reason: MailConnectionReason = 'offline',
  ) {
    super(message)
  }
}

/**
 * The server answered but won't serve us for now: throttling, too many connections, maintenance
 * (`NO [UNAVAILABLE]`, `[LIMIT]`, `[INUSE]`, a `BYE`). `serverText` is the server's own words,
 * cleaned and trimmed, so the app can show what it said.
 */
export class MailUnavailableError extends Error {
  override name = 'MailUnavailableError'
  constructor(
    message: string,
    readonly serverText: string | null = null,
  ) {
    super(message)
  }
}

const OFFLINE =
  /^(ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_FAIL|ECONNREFUSED|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EHOSTDOWN|EADDRNOTAVAIL)$/
const TIMEOUT = /^(ETIMEDOUT|ETIMEOUT|CONNECT_TIMEOUT|GREETING_TIMEOUT|UPGRADE_TIMEOUT)$/
const DROPPED =
  /^(ECONNRESET|ECONNABORTED|EPIPE|NoConnection|EConnectionClosed|ClosedAfterConnectText|ClosedAfterConnectTLS)$/
const TLS = /^(ERR_SSL_|ERR_TLS_|CERT_|UNABLE_TO_|SELF_SIGNED_|DEPTH_ZERO_|HOSTNAME_MISMATCH|EPROTO$)/
/** RFC 5530 response codes that mean "not now" rather than "wrong password". */
const REFUSING_CODES = new Set(['UNAVAILABLE', 'LIMIT', 'INUSE', 'SERVERBUG'])
const REFUSING_TEXT = /too many|temporar|throttl|rate.?limit|maintenance|unavailable|overload|busy/i

/** The server's words without control, invisible or bidi characters, short enough to show. */
export function serverWords(text: unknown): string | null {
  if (typeof text !== 'string') return null
  const clean = text.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g,
    ' ',
  )
  const words = clean.replace(/\s+/g, ' ').trim()
  if (!words) return null
  return words.length > 160 ? `${words.slice(0, 159)}…` : words
}

/** Sort an imapflow or socket error into the errors above, so the app can say what went wrong. */
export function classifyImapError(err: unknown): Error {
  if (
    err instanceof MailAuthError ||
    err instanceof MailConnectionError ||
    err instanceof MailUnavailableError
  )
    return err
  const e = (err ?? {}) as {
    authenticationFailed?: boolean
    serverResponseCode?: string
    responseText?: string
    response?: unknown
    responseStatus?: string
    reason?: string
    code?: string
    message?: string
  }
  const text = serverWords(e.responseText) ?? serverWords(e.response) ?? serverWords(e.reason)
  const code = String(e.code ?? '')
  const responseCode = String(e.serverResponseCode ?? '').toUpperCase()
  if (code === 'ETHROTTLE' || REFUSING_CODES.has(responseCode))
    return new MailUnavailableError(text ?? 'The server is refusing connections for now', text)
  if (
    e.authenticationFailed ||
    responseCode === 'AUTHENTICATIONFAILED' ||
    responseCode === 'AUTHORIZATIONFAILED'
  ) {
    // Refused at sign-in, but not because of the password ("try again later").
    if (
      !responseCode.startsWith('AUTH') &&
      text &&
      REFUSING_TEXT.test(text) &&
      !/password|credential|authent/i.test(text)
    )
      return new MailUnavailableError(text, text)
    return new MailAuthError(text ?? 'Authentication failed')
  }
  // The server said BYE: it's turning us away, usually because of load or too many connections.
  if (e.responseStatus === 'BYE' || (DROPPED.test(code) && e.reason))
    return new MailUnavailableError(text ?? 'The server closed the connection', text)
  if (OFFLINE.test(code)) return new MailConnectionError(e.message ?? code, 'offline')
  if (TIMEOUT.test(code)) return new MailConnectionError(e.message ?? code, 'timeout')
  if (TLS.test(code)) return new MailConnectionError(e.message ?? code, 'tls')
  if (DROPPED.test(code)) return new MailConnectionError(e.message ?? code, 'dropped')
  return err instanceof Error ? err : new Error(String(err))
}

/** IMAP access for iCloud (or any IMAP server, for tests). Read-mostly: only moveMessages changes anything. */
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
      connectionTimeout: cfg.timeoutMs ?? 15_000,
      greetingTimeout: cfg.timeoutMs ?? 15_000,
    })
    // Without a listener, a dropped socket would crash the process.
    this.client.on('error', () => {})
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect()
    } catch (err) {
      throw classifyImapError(err)
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

  async moveMessages(from: string, to: string, uids: number[]): Promise<MoveResult> {
    if (!uids.length) return { uidValidity: null, uidMap: new Map() }
    const lock = await this.client.getMailboxLock(from)
    try {
      // imapflow uses UID MOVE when the server has MOVE, else COPY, flag \Deleted and (UID) EXPUNGE.
      const res = await this.client.messageMove(uids.join(','), to, { uid: true })
      if (!res) throw new Error(`Couldn't move messages to ${to}`)
      return {
        uidValidity: res.uidValidity !== undefined ? String(res.uidValidity) : null,
        uidMap: res.uidMap ?? null,
      }
    } finally {
      lock.release()
    }
  }

  async existingUids(mailbox: string, uids: number[]): Promise<number[]> {
    if (!uids.length) return []
    const lock = await this.client.getMailboxLock(mailbox, { readOnly: true })
    try {
      if (!this.client.mailbox || this.client.mailbox.exists === 0) return []
      const found = await this.client.search({ uid: uids.join(',') }, { uid: true })
      return found ? found.filter((u) => uids.includes(u)) : []
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
