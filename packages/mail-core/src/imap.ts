import { ImapFlow, type FetchMessageObject, type FetchQueryObject } from 'imapflow'
import { parseHeaderBlock, SCAN_HEADER_FIELDS, toAddresses, toMessageHeader } from './headers'
import { toMailboxList } from './mailboxes'
import { decodeTextPart, decodeTransfer, findPart } from './decode'
import { planBodyParts, referencedCids, type BodyNode } from './mime'
import { toUidSet } from './sync'
import type { FlagUpdate } from './store'
import type {
  MailboxInfo,
  MailboxStatus,
  MailProvider,
  MessageContent,
  MessageHeader,
  MoveResult,
  SpecialMailbox,
} from './types'

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

/** Size limits when reading a message. */
export const READ_LIMITS = {
  /** Bytes of each body (HTML or text) downloaded; the rest is cut off and marked truncated. */
  body: 2 * 1024 * 1024,
  /** Bytes of inline images (cid:) shown inside a message, in all. */
  inlineImages: 5 * 1024 * 1024,
  /** Largest attachment Ordo downloads to save. */
  attachment: 100 * 1024 * 1024,
} as const

const HEADER_QUERY: FetchQueryObject = {
  uid: true,
  flags: true,
  internalDate: true,
  envelope: true,
  headers: [...SCAN_HEADER_FIELDS],
}

/** IMAP access for iCloud (or any IMAP server, for tests). */
export class ImapMailProvider implements MailProvider {
  private client: ImapFlow
  private closed = false

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
    this.client.on('close', () => {
      this.closed = true
    })
  }

  /** False once the connection has dropped or been closed; start a new provider then. */
  get usable(): boolean {
    return !this.closed && this.client.usable
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect()
    } catch (err) {
      throw wrap(err)
    }
  }

  async status(mailbox: string): Promise<MailboxStatus & { unseen: number }> {
    const s = await this.client.status(mailbox, {
      messages: true,
      uidNext: true,
      uidValidity: true,
      unseen: true,
    })
    if (!s) throw new Error(`Couldn't read mailbox ${mailbox}`)
    return {
      messages: s.messages ?? 0,
      uidNext: s.uidNext ?? 1,
      uidValidity: String(s.uidValidity ?? '0'),
      unseen: s.unseen ?? 0,
    }
  }

  async *fetchHeaders(mailbox: string, fromUid: number): AsyncIterable<MessageHeader> {
    const lock = await this.client.getMailboxLock(mailbox, { readOnly: true })
    try {
      const mb = this.client.mailbox
      if (!mb || mb.exists === 0) return
      for await (const msg of this.client.fetch(`${Math.max(1, fromUid)}:*`, HEADER_QUERY, { uid: true })) {
        // `n:*` always returns the last message, even if its UID is below n.
        if (msg.uid < fromUid) continue
        const h = toMessageHeader(msg, mailbox)
        if (h) yield h
      }
    } finally {
      lock.release()
    }
  }

  /** Headers of the newest `count` messages (by position in the mailbox), oldest first. */
  async fetchRecentHeaders(mailbox: string, count: number): Promise<MessageHeader[]> {
    const lock = await this.client.getMailboxLock(mailbox, { readOnly: true })
    try {
      const exists = this.client.mailbox ? this.client.mailbox.exists : 0
      if (!exists) return []
      const out: MessageHeader[] = []
      for await (const msg of this.client.fetch(`${Math.max(1, exists - count + 1)}:*`, HEADER_QUERY)) {
        const h = toMessageHeader(msg, mailbox)
        if (h) out.push(h)
      }
      return out.sort((a, b) => a.uid - b.uid)
    } finally {
      lock.release()
    }
  }

  /** Headers for these UIDs (those that still exist). */
  async fetchHeadersByUid(mailbox: string, uids: readonly number[]): Promise<MessageHeader[]> {
    if (!uids.length) return []
    const lock = await this.client.getMailboxLock(mailbox, { readOnly: true })
    try {
      if (!this.client.mailbox || this.client.mailbox.exists === 0) return []
      const out: MessageHeader[] = []
      for await (const msg of this.client.fetch(toUidSet(uids), HEADER_QUERY, { uid: true })) {
        const h = toMessageHeader(msg, mailbox)
        if (h) out.push(h)
      }
      return out
    } finally {
      lock.release()
    }
  }

  /** Every UID in the mailbox right now. */
  async allUids(mailbox: string): Promise<number[]> {
    const lock = await this.client.getMailboxLock(mailbox, { readOnly: true })
    try {
      if (!this.client.mailbox || this.client.mailbox.exists === 0) return []
      return (await this.client.search({ all: true }, { uid: true })) || []
    } finally {
      lock.release()
    }
  }

  /** Current flags of these UIDs (those that still exist). */
  async fetchFlags(mailbox: string, uids: readonly number[]): Promise<FlagUpdate[]> {
    if (!uids.length) return []
    const lock = await this.client.getMailboxLock(mailbox, { readOnly: true })
    try {
      if (!this.client.mailbox || this.client.mailbox.exists === 0) return []
      const out: FlagUpdate[] = []
      for await (const msg of this.client.fetch(toUidSet(uids), { uid: true, flags: true }, { uid: true }))
        out.push({
          uid: msg.uid,
          seen: msg.flags?.has('\\Seen') ?? false,
          flagged: msg.flags?.has('\\Flagged') ?? false,
          answered: msg.flags?.has('\\Answered') ?? false,
        })
      return out
    } finally {
      lock.release()
    }
  }

  async findMailbox(use: SpecialMailbox): Promise<string | null> {
    const list = await this.client.list()
    return list.find((m) => m.specialUse === use)?.path ?? null
  }

  /** The account's folders with message and unread counts, special ones first. */
  async listMailboxes(): Promise<MailboxInfo[]> {
    const list = await this.client.list({ statusQuery: { messages: true, unseen: true } })
    return toMailboxList(list)
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

  /**
   * Read one message: headers, the HTML and plain-text bodies (up to READ_LIMITS.body each) and
   * the attachment list, plus inline images the HTML uses. Opens the mailbox read-only and
   * fetches with BODY.PEEK, so reading never marks a message as read. Null if it's gone.
   */
  async fetchMessage(mailbox: string, uid: number): Promise<MessageContent | null> {
    const lock = await this.client.getMailboxLock(mailbox, { readOnly: true })
    try {
      if (!this.client.mailbox || this.client.mailbox.exists === 0) return null
      const msg = await this.client.fetchOne(
        String(uid),
        {
          uid: true,
          flags: true,
          internalDate: true,
          envelope: true,
          bodyStructure: true,
          headers: ['references', 'in-reply-to'],
        },
        { uid: true },
      )
      if (!msg || msg.uid !== uid) return null
      const structure = (msg.bodyStructure as BodyNode | undefined) ?? { type: 'text/plain' }
      const plan = planBodyParts(structure)

      let truncated = false
      const readText = async (part: string | null): Promise<string | null> => {
        if (!part) return null
        const node = findPart(structure, part)
        // Transfer encoding makes the raw part up to a third bigger than the text.
        const limit = Math.ceil(READ_LIMITS.body * 1.4)
        const raw = await this.rawPart(uid, part, limit)
        if (!raw || !node) return null
        if ((node.size ?? 0) > limit) truncated = true
        return decodeTextPart(raw, node)
      }
      const html = await readText(plan.html)
      const text = await readText(plan.text)

      // Inline images the HTML actually uses become data: URLs, within a total budget.
      const inlineImages: Record<string, string> = {}
      const used = html ? referencedCids(html) : new Set<string>()
      let budget: number = READ_LIMITS.inlineImages
      for (const a of plan.attachments) {
        const cid = a.contentId?.toLowerCase()
        if (!a.inline || !cid || !used.has(cid)) {
          a.inline = false
          continue
        }
        if (a.size > budget * 1.4 || !/^image\/(png|jpeg|gif|webp|bmp)$/.test(a.contentType)) continue
        const raw = await this.rawPart(uid, a.part, Math.ceil(budget * 1.4))
        const node = findPart(structure, a.part)
        if (!raw || !node) continue
        const bytes = decodeTransfer(raw, node.encoding)
        if (bytes.length > budget) continue
        budget -= bytes.length
        inlineImages[cid] = `data:${a.contentType};base64,${bytes.toString('base64')}`
      }

      return toContent(msg, mailbox, { html, text, truncated, attachments: plan.attachments, inlineImages })
    } finally {
      lock.release()
    }
  }

  /** A part's raw bytes, still transfer-encoded, at most `maxLength` of them. */
  private async rawPart(uid: number, part: string, maxLength: number): Promise<Buffer | null> {
    const msg = await this.client.fetchOne(
      String(uid),
      { uid: true, bodyParts: [{ key: part, maxLength }] },
      { uid: true },
    )
    if (!msg || msg.uid !== uid) return null
    return msg.bodyParts?.get(part) ?? msg.bodyParts?.get(part.toLowerCase()) ?? null
  }

  /**
   * Download one body part (an attachment) as the file it is: transfer encoding removed, bytes
   * otherwise untouched. Null if the message or part is gone, or the part is too big.
   */
  async downloadPart(
    mailbox: string,
    uid: number,
    part: string,
    maxBytes: number = READ_LIMITS.attachment,
  ): Promise<{ content: Buffer; contentType: string } | null> {
    const lock = await this.client.getMailboxLock(mailbox, { readOnly: true })
    try {
      if (!this.client.mailbox || this.client.mailbox.exists === 0) return null
      const msg = await this.client.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true })
      if (!msg || msg.uid !== uid || !msg.bodyStructure) return null
      const node = findPart(msg.bodyStructure as BodyNode, part)
      if (!node || (node.size ?? 0) > maxBytes * 1.4) return null
      const raw = await this.rawPart(uid, part, Math.ceil(maxBytes * 1.4))
      if (!raw) return null
      const content = decodeTransfer(raw, node.encoding)
      if (content.length > maxBytes) return null
      return { content, contentType: node.type.toLowerCase() }
    } finally {
      lock.release()
    }
  }

  /** Add or remove a flag on messages. */
  async setFlag(
    mailbox: string,
    uids: readonly number[],
    flag: '\\Seen' | '\\Flagged' | '\\Answered',
    on: boolean,
  ): Promise<void> {
    if (!uids.length) return
    const lock = await this.client.getMailboxLock(mailbox)
    try {
      const range = toUidSet(uids)
      const ok = on
        ? await this.client.messageFlagsAdd(range, [flag], { uid: true })
        : await this.client.messageFlagsRemove(range, [flag], { uid: true })
      if (!ok) throw new Error(`Couldn't change ${flag} in ${mailbox}`)
    } finally {
      lock.release()
    }
  }

  /** Upload a message (a draft, or a copy of one sent). Returns its UID when the server says. */
  async append(
    mailbox: string,
    raw: Buffer,
    flags: string[],
  ): Promise<{ uid: number | null; uidValidity: string | null }> {
    const res = await this.client.append(mailbox, raw, flags, new Date())
    if (!res) throw new Error(`Couldn't save the message to ${mailbox}`)
    return {
      uid: res.uid ?? null,
      uidValidity: res.uidValidity !== undefined ? String(res.uidValidity) : null,
    }
  }

  /**
   * Permanently remove one message. Ordo only does this to a draft it is replacing with a newer
   * version, and only with UID EXPUNGE (UIDPLUS), which can't touch any other message. Returns
   * false (and changes nothing) on servers without it.
   */
  async deleteDraft(mailbox: string, uid: number): Promise<boolean> {
    if (!this.client.capabilities.has('UIDPLUS')) return false
    const lock = await this.client.getMailboxLock(mailbox)
    try {
      const found = await this.client.search({ uid: String(uid), draft: true }, { uid: true })
      if (!found || !found.includes(uid)) return false
      return await this.client.messageDelete(String(uid), { uid: true })
    } finally {
      lock.release()
    }
  }

  /**
   * IMAP SEARCH on the server for older mail the cache doesn't have: every word must appear in
   * the subject, sender, recipients or body. Returns headers of the newest `limit` matches.
   */
  async search(mailbox: string, words: readonly string[], limit: number): Promise<MessageHeader[]> {
    if (!words.length) return []
    let uids: number[] | null = null
    const lock = await this.client.getMailboxLock(mailbox, { readOnly: true })
    try {
      if (!this.client.mailbox || this.client.mailbox.exists === 0) return []
      for (const w of words) {
        const found =
          (await this.client.search(
            { or: [{ subject: w }, { from: w }, { to: w }, { cc: w }, { body: w }] },
            { uid: true },
          )) || []
        const set = new Set(found)
        uids = uids === null ? found : uids.filter((u) => set.has(u))
        if (!uids.length) return []
      }
    } finally {
      lock.release()
    }
    const newest = (uids ?? []).sort((a, b) => b - a).slice(0, limit)
    return this.fetchHeadersByUid(mailbox, newest)
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

/** Message-IDs in a References or In-Reply-To header, in order. */
export function messageIds(header: string | undefined): string[] {
  return [...(header ?? '').matchAll(/<[^<>\s]+>/g)].map((m) => m[0])
}

function toContent(
  msg: FetchMessageObject,
  mailbox: string,
  body: Pick<MessageContent, 'html' | 'text' | 'truncated' | 'attachments' | 'inlineImages'>,
): MessageContent {
  const env = msg.envelope
  const raw = msg.headers ? msg.headers.toString('utf8') : ''
  const h = parseHeaderBlock(raw)
  const when = env?.date ?? msg.internalDate
  const date = when ? new Date(when) : new Date(0)
  const from = toAddresses(env?.from)[0] ?? null
  const references = [...messageIds(h['references']), ...messageIds(h['in-reply-to'] ?? env?.inReplyTo)]
  return {
    mailbox,
    uid: msg.uid,
    date: Number.isNaN(date.getTime()) ? new Date(0) : date,
    subject: env?.subject ?? '',
    from,
    to: toAddresses(env?.to),
    cc: toAddresses(env?.cc),
    bcc: toAddresses(env?.bcc),
    // Servers fill the envelope's Reply-To with From when there is none: only keep a real one.
    replyTo: toAddresses(env?.replyTo).filter((a) => a.address.toLowerCase() !== from?.address.toLowerCase()),
    messageId: env?.messageId?.trim() || null,
    references: [...new Set(references)],
    seen: msg.flags?.has('\\Seen') ?? false,
    flagged: msg.flags?.has('\\Flagged') ?? false,
    answered: msg.flags?.has('\\Answered') ?? false,
    draft: msg.flags?.has('\\Draft') ?? false,
    ...body,
  }
}

/** Sign in and out again, to check credentials. */
export async function testImapLogin(cfg: ImapConfig): Promise<void> {
  const p = new ImapMailProvider(cfg)
  await p.connect()
  await p.close()
}
