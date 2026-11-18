/* eslint-disable @typescript-eslint/no-explicit-any -- a small in-memory IMAP server for tests */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The mail client's main-process flows end to end, against an in-memory IMAP server and a fake
// SMTP send: what they change on the server, in the cache, and what they report.

const dir = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => dir.path, isPackaged: true, on: vi.fn() },
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: {},
  BrowserWindow: {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().slice('enc:'.length),
  },
}))

interface Msg {
  uid: number
  flags: Set<string>
  subject: string
  from: string
  raw?: string
}
interface Box {
  uidValidity: string
  next: number
  use?: string
  msgs: Map<number, Msg>
}

const server = vi.hoisted(() => ({
  boxes: new Map<string, any>(),
  /** When set, fetching headers waits for it: a sync caught part way. */
  gate: null as Promise<void> | null,
  reachedGate: null as (() => void) | null,
  sent: [] as any[],
  send: null as null | ((m: any) => Promise<any>),
}))

vi.mock('@ordo/mail-core/node', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ordo/mail-core/node')>()
  const box = (path: string): Box => {
    const b = server.boxes.get(path)
    if (!b) throw new Error(`No mailbox ${path}`)
    return b
  }
  const header = (path: string, m: Msg) => ({
    uid: m.uid,
    mailbox: path,
    date: new Date(1_790_000_000_000 + m.uid * 1000),
    seen: m.flags.has('\\Seen'),
    flagged: m.flags.has('\\Flagged'),
    answered: m.flags.has('\\Answered'),
    from: { address: m.from },
    subject: m.subject,
    to: [],
    cc: [],
  })
  const wait = async () => {
    if (!server.gate) return
    server.reachedGate?.()
    await server.gate
  }
  class FakeImap {
    usable = true
    async connect() {}
    async close() {}
    async status(path: string) {
      const b = box(path)
      const unseen = [...b.msgs.values()].filter((m) => !m.flags.has('\\Seen')).length
      return { messages: b.msgs.size, uidNext: b.next, uidValidity: b.uidValidity, unseen }
    }
    async *fetchHeaders(path: string, fromUid: number) {
      await wait()
      for (const m of [...box(path).msgs.values()].sort((a, b) => a.uid - b.uid))
        if (m.uid >= fromUid) yield header(path, m)
    }
    async fetchRecentHeaders(path: string, count: number) {
      await wait()
      return [...box(path).msgs.values()].slice(-count).map((m) => header(path, m))
    }
    async fetchHeadersByUid(path: string, uids: number[]) {
      return uids.flatMap((u) => (box(path).msgs.has(u) ? [header(path, box(path).msgs.get(u)!)] : []))
    }
    async allUids(path: string) {
      return [...box(path).msgs.keys()]
    }
    async existingUids(path: string, uids: number[]) {
      return uids.filter((u) => box(path).msgs.has(u))
    }
    async fetchFlags(path: string, uids: readonly number[]) {
      return uids.flatMap((u) => {
        const m = box(path).msgs.get(u)
        return m
          ? [
              {
                uid: u,
                seen: m.flags.has('\\Seen'),
                flagged: m.flags.has('\\Flagged'),
                answered: m.flags.has('\\Answered'),
              },
            ]
          : []
      })
    }
    async listMailboxes() {
      const roles: Record<string, string> = {
        '\\Drafts': 'drafts',
        '\\Sent': 'sent',
        '\\Archive': 'archive',
        '\\Trash': 'trash',
      }
      return [...server.boxes.entries()].map(([path, b]: [string, Box]) => ({
        path,
        name: path,
        role: path === 'INBOX' ? 'inbox' : (b.use && roles[b.use]) || null,
        delimiter: '/',
        total: b.msgs.size,
        unread: 0,
      }))
    }
    async findMailbox(use: string) {
      return [...server.boxes.entries()].find(([, b]: [string, Box]) => b.use === use)?.[0] ?? null
    }
    async fetchRecipients() {
      return []
    }
    async fetchMessage(path: string, uid: number) {
      const m = box(path).msgs.get(uid)
      if (!m) return null
      const raw = m.raw ?? ''
      const head = (name: string) => new RegExp(`^${name}: (.*)$`, 'mi').exec(raw)?.[1]?.trim()
      return {
        mailbox: path,
        uid,
        date: new Date(),
        subject: m.subject,
        from: { address: m.from },
        to: [],
        cc: [],
        bcc: [],
        replyTo: [],
        messageId: `<m${uid}@fake>`,
        inReplyTo: head('In-Reply-To') ?? null,
        references: (head('References') ?? '').split(/\s+/).filter(Boolean),
        seen: m.flags.has('\\Seen'),
        flagged: m.flags.has('\\Flagged'),
        answered: m.flags.has('\\Answered'),
        draft: m.flags.has('\\Draft'),
        text: 'Hello',
        html: null,
        truncated: false,
        attachments: [...raw.matchAll(/filename=("?)([^";\r\n]+)\1/g)].map((f, i) => ({
          part: String(i + 2),
          filename: f[2],
          contentType: 'text/plain',
          size: 10,
          inline: false,
        })),
        inlineImages: {},
      }
    }
    async downloadPart() {
      return { content: Buffer.from('file contents'), contentType: 'text/plain' }
    }
    async setFlag(path: string, uids: readonly number[], flag: string, on: boolean) {
      for (const u of uids) {
        const m = box(path).msgs.get(u)
        if (m) {
          if (on) m.flags.add(flag)
          else m.flags.delete(flag)
        }
      }
    }
    async append(path: string, raw: Buffer, flags: string[]) {
      const b = box(path)
      const uid = b.next++
      const text = raw.toString()
      b.msgs.set(uid, {
        uid,
        flags: new Set(flags),
        subject: /^Subject: (.*)$/m.exec(text)?.[1] ?? '',
        from: 'me@icloud.com',
        raw: text,
      })
      return { uid, uidValidity: b.uidValidity }
    }
    async deleteDraft(path: string, uid: number) {
      const m = box(path).msgs.get(uid)
      if (!m?.flags.has('\\Draft')) return false
      box(path).msgs.delete(uid)
      return true
    }
    async search() {
      return []
    }
    async moveMessages(from: string, to: string, uids: number[]) {
      const src = box(from)
      const dst = box(to)
      const uidMap = new Map<number, number>()
      for (const u of uids) {
        const m = src.msgs.get(u)
        if (!m) continue
        src.msgs.delete(u)
        const nu = dst.next++
        dst.msgs.set(nu, { ...m, uid: nu })
        uidMap.set(u, nu)
      }
      return { uidValidity: dst.uidValidity, uidMap }
    }
  }
  return {
    ...real,
    ImapMailProvider: FakeImap,
    sendMessage: vi.fn(async (_cfg: unknown, m: any) => {
      server.sent.push(m)
      if (server.send) return server.send(m)
      return {
        sentCopy: Buffer.from(`Subject: ${m.subject}\r\n\r\ncopy`),
        messageId: '<new@x>',
        rejected: [],
      }
    }),
  }
})

dir.path = mkdtempSync(join(tmpdir(), 'ordo-mail-flow-'))
const { saveAccount, deleteAccount } = await import('./account')
const mail = await import('./mail')
const client = await import('./mail-client')
const { RecipientsRefused } = await import('@ordo/mail-core/node')

function seed() {
  const msg = (uid: number, subject: string, flags: string[] = []): Msg => ({
    uid,
    subject,
    from: 'sam@friend.example',
    flags: new Set(flags),
  })
  server.boxes.clear()
  server.boxes.set('INBOX', {
    uidValidity: '1',
    next: 4,
    msgs: new Map([
      [1, msg(1, 'Lunch?')],
      [2, msg(2, 'Receipt', ['\\Seen'])],
      [3, msg(3, 'Notes')],
    ]),
  })
  server.boxes.set('Archive', { uidValidity: '7', next: 1, use: '\\Archive', msgs: new Map() })
  server.boxes.set('Drafts', { uidValidity: '8', next: 1, use: '\\Drafts', msgs: new Map() })
  server.boxes.set('Sent Messages', { uidValidity: '9', next: 1, use: '\\Sent', msgs: new Map() })
  server.gate = null
  server.sent = []
  server.send = null
}

const compose = (o: Record<string, unknown> = {}) => ({
  to: 'sam@friend.example',
  cc: '',
  bcc: '',
  subject: 'Hi',
  body: 'Hello',
  attachments: [],
  ...o,
})

const inbox = () => client.messages({ mailbox: 'INBOX' }).messages

beforeEach(async () => {
  client.closeMailClient()
  mail.mailStore().clear()
  seed()
  saveAccount('me@icloud.com', 'abcd-efgh-ijkl-mnop')
  expect(await client.refresh({ mailbox: 'INBOX' })).toMatchObject({ ok: true })
})
afterAll(() => {
  client.closeMailClient()
  deleteAccount()
  mail.closeMail()
})

describe('moving mail', () => {
  it('moves to Archive, and Undo puts it back in the inbox and the cache', async () => {
    const moved = await client.move({ mailbox: 'INBOX', uids: [1], to: 'archive' })
    expect(moved).toMatchObject({ ok: true, moved: 1, undoId: expect.any(Number) })
    expect([...server.boxes.get('Archive').msgs.values()].map((m: Msg) => m.subject)).toEqual(['Lunch?'])
    expect(inbox().map((m) => m.subject)).not.toContain('Lunch?')

    const undone = await client.undoMove((moved as { undoId: number }).undoId)
    expect(undone).toEqual({ ok: true, restored: 1 })
    expect(server.boxes.get('Archive').msgs.size).toBe(0)
    expect(inbox().map((m) => m.subject)).toContain('Lunch?')
    // Once only.
    expect(await client.undoMove((moved as { undoId: number }).undoId)).toMatchObject({ error: 'not-found' })
  })
})

describe('sending', () => {
  it('sends, keeps a read copy in Sent and marks the original answered', async () => {
    const r = await client.send(compose({ replyTo: { mailbox: 'INBOX', uid: 1 } }))
    expect(r).toEqual({ ok: true })
    expect(server.sent[0]).toMatchObject({
      subject: 'Hi',
      inReplyTo: '<m1@fake>',
      to: [{ address: 'sam@friend.example' }],
    })
    const copy = [...server.boxes.get('Sent Messages').msgs.values()][0] as Msg
    expect(copy.flags.has('\\Seen')).toBe(true)
    expect(server.boxes.get('INBOX').msgs.get(1).flags.has('\\Answered')).toBe(true)
    expect(inbox().find((m) => m.uid === 1)?.answered).toBe(true)
  })

  it('warns about recipients iCloud refused when it took the rest', async () => {
    server.send = async () => ({
      sentCopy: Buffer.from('x'),
      messageId: '<x@y>',
      rejected: ['nobody@friend.example'],
    })
    expect(await client.send(compose({ cc: 'nobody@friend.example' }))).toEqual({
      ok: true,
      warning: 'Sent. iCloud refused nobody@friend.example, so they won’t get it.',
    })
  })

  it('says which recipients were refused when none could be sent to, not "check your connection"', async () => {
    server.send = async () => {
      throw new RecipientsRefused(['sam@friend.example'])
    }
    expect(await client.send(compose())).toEqual({
      ok: false,
      error: 'invalid',
      message: 'iCloud refused sam@friend.example. Check the addresses. Nothing was sent.',
    })
    expect(server.boxes.get('Sent Messages').msgs.size).toBe(0)
  })
})

describe('drafts', () => {
  it('saves to Drafts, replaces the earlier version and carries its attachments on', async () => {
    const first = await client.saveDraft(compose({ subject: 'Plan' }))
    expect(first).toMatchObject({ ok: true, draft: { mailbox: 'Drafts', uid: 1 } })
    const second = await client.saveDraft(
      compose({ subject: 'Plan v2', draft: { mailbox: 'Drafts', uid: 1 } }),
    )
    expect(second).toMatchObject({ ok: true, draft: { mailbox: 'Drafts', uid: 2 } })
    expect([...server.boxes.get('Drafts').msgs.values()].map((m: Msg) => m.subject)).toEqual(['Plan v2'])
  })

  it('sending a reply that was saved as a draft keeps it in the thread', async () => {
    const saved = await client.saveDraft(compose({ replyTo: { mailbox: 'INBOX', uid: 1 } }))
    const draft = (saved as { draft: { mailbox: string; uid: number } }).draft
    expect(await client.send(compose({ draft }))).toEqual({ ok: true })
    expect(server.sent[0]).toMatchObject({ inReplyTo: '<m1@fake>' })
    expect(server.boxes.get('Drafts').msgs.size).toBe(0)
  })

  it('finds Drafts and Sent on the server before the folder list has been cached', async () => {
    mail.mailStore().saveMailboxes([])
    mail.mailStore().clear()
    expect(await client.saveDraft(compose())).toMatchObject({ ok: true, draft: { mailbox: 'Drafts' } })
    expect(await client.send(compose())).toEqual({ ok: true })
    expect(server.boxes.get('Sent Messages').msgs.size).toBe(1)
  })
})

describe('refreshing', () => {
  it('lists the folders before a long first inbox scan finishes', async () => {
    mail.mailStore().clear()
    let release!: () => void
    server.gate = new Promise((r) => (release = r))
    const reached = new Promise<void>((r) => (server.reachedGate = r))
    const running = client.refresh({ mailbox: 'INBOX' })
    await reached
    expect(
      mail
        .mailStore()
        .mailboxes()
        .map((m) => m.role),
    ).toEqual(expect.arrayContaining(['drafts', 'sent', 'archive']))
    release()
    expect(await running).toMatchObject({ ok: true })
  })

  it('a sync running when you disconnect leaves nothing behind', async () => {
    let release!: () => void
    server.gate = new Promise((r) => (release = r))
    const reached = new Promise<void>((r) => (server.reachedGate = r))
    server.boxes.get('Archive').msgs.set(5, { uid: 5, subject: 'Old', from: 'a@x.example', flags: new Set() })
    server.boxes.get('Archive').next = 6
    const running = client.refresh({ mailbox: 'Archive' })
    await reached
    client.closeMailClient()
    const disconnecting = mail.disconnect()
    release()
    await disconnecting
    await running
    expect(mail.mailStore().count('Archive')).toBe(0)
    expect(mail.mailStore().count('INBOX')).toBe(0)
    expect(mail.mailStore().mailboxes()).toEqual([])
  })
})
