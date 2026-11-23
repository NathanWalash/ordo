// The main process with two accounts against a real IMAP server (GreenMail). Start it with:
//   pnpm imap:start
// then: IMAP_TEST_PORT=3143 pnpm test:integration
// Both accounts reach the same local server (the unpackaged build's ORDO_IMAP_HOST), each with its
// own user and password, exactly as an iCloud and a Gmail account would reach theirs.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImapFlow } from 'imapflow'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const port = vi.hoisted(() => {
  const p = process.env['IMAP_TEST_PORT']
  if (p) {
    process.env['ORDO_IMAP_HOST'] = process.env['IMAP_TEST_HOST'] ?? '127.0.0.1'
    process.env['ORDO_IMAP_PORT'] = p
    process.env['ORDO_SMTP_HOST'] = process.env['IMAP_TEST_HOST'] ?? '127.0.0.1'
    process.env['ORDO_SMTP_PORT'] = process.env['SMTP_TEST_PORT'] ?? '3025'
  }
  return Number(p)
})
const dir = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => dir.path, isPackaged: false, on: vi.fn() },
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

dir.path = mkdtempSync(join(tmpdir(), 'ordo-accounts-int-'))
const accounts = await import('./accounts')
const mail = await import('./mail')
const client = await import('./mail-client')
const account = await import('./account')

const HOME = { email: 'test@ordo.test', password: 'abcd-efgh-ijkl-mnop' }
const WORK = { email: 'work@work.ordo.test', password: 'qrst-uvwx-yzab-cdef' }
const run = `${Date.now()}`
let workBin = ''
const raw = (from: string, to: string, subject: string) =>
  `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: Mon, 16 Nov 2026 10:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nBody\r\n`

describe.skipIf(!port)('two accounts in the main process (GreenMail)', () => {
  let home = ''
  let work = ''
  beforeAll(async () => {
    for (const [who, subject] of [
      [HOME, `Home hello ${run}`],
      [WORK, `Work hello ${run}`],
    ] as const) {
      const c = new ImapFlow({
        host: process.env['ORDO_IMAP_HOST']!,
        port,
        secure: false,
        auth: { user: who.email, pass: who.password },
        logger: false,
      })
      await c.connect()
      const listed = await c.list()
      const d = listed.find((b) => b.path === 'INBOX')?.delimiter || '/'
      // The work account is laid out like Gmail ([Gmail]/Sent Mail, [Gmail]/Bin), as in mail-core's
      // integration test, which shares this server.
      const wanted = who === WORK ? [`[Gmail]${d}Sent Mail`, `[Gmail]${d}Bin`] : ['Sent', 'Trash']
      if (who === WORK) workBin = `[Gmail]${d}Bin`
      for (const box of wanted)
        if (!listed.some((b) => b.path === box)) await c.mailboxCreate(box).catch(() => {})
      await c.append('INBOX', raw('Sam <sam@friend.example>', who.email, subject))
      await c.logout()
    }
    const h = await accounts.add({ provider: 'icloud', ...HOME })
    const w = await accounts.add({ provider: 'gmail', ...WORK, label: 'Work' })
    if (!h.ok || !w.ok) throw new Error(`Couldn't add the test accounts: ${JSON.stringify([h, w])}`)
    home = h.account.id
    work = w.account.id
  })
  afterAll(async () => {
    client.closeMailClient()
    await mail.disconnect()
    mail.closeMail()
  })

  it('checks every inbox at once and shows them together', async () => {
    const r = await client.refresh({ account: 'all', mailbox: 'INBOX' })
    expect(r).toMatchObject({ ok: true })
    expect(r.ok && r.failed).toBeUndefined()
    const all = client.messages({ account: 'all', mailbox: 'INBOX', limit: 500 })
    const subjects = all.messages.map((m) => [m.account, m.subject])
    expect(subjects).toContainEqual([home, `Home hello ${run}`])
    expect(subjects).toContainEqual([work, `Work hello ${run}`])
    expect(client.mailboxes({ account: work }).map((m) => m.path)).toContain('INBOX')
  })

  it('reads and moves a message in its own account, and undoes the move', async () => {
    const msg = client
      .messages({ account: work, mailbox: 'INBOX', limit: 500 })
      .messages.find((m) => m.subject === `Work hello ${run}`)!
    const opened = await client.open({ account: work, mailbox: 'INBOX', uid: msg.uid })
    expect(opened).toMatchObject({ ok: true, message: { subject: `Work hello ${run}` } })
    const moved = await client.move({ account: work, mailbox: 'INBOX', uids: [msg.uid], to: 'trash' })
    expect(moved).toMatchObject({ ok: true, moved: 1 })
    expect(client.lastMove()).toMatchObject({ account: work, from: 'INBOX', to: workBin })
    // The home inbox didn't change.
    expect(
      client
        .messages({ account: home, mailbox: 'INBOX', limit: 500 })
        .messages.some((m) => m.subject.includes(run)),
    ).toBe(true)
    const undone = await client.undoMove(moved.ok ? moved.undoId : 0)
    expect(undone).toMatchObject({ ok: true, restored: 1 })
  })

  it('one account with a wrong password fails on its own and backs off; the other is checked', async () => {
    // A password that worked once and was then revoked.
    account.setSecret(work, 'revoked-password')
    const r = await client.refresh({ account: 'all', mailbox: 'INBOX' })
    expect(r).toMatchObject({ ok: true, failed: [{ account: work, error: 'auth' }] })
    expect(r.ok && r.failed?.[0]?.message).toMatch(/Gmail didn't accept/)
    const listed = accounts.list().find((a) => a.id === work)!
    expect(listed.sync).toMatchObject({ error: 'auth' })
    expect(accounts.list().find((a) => a.id === home)!.sync).toEqual({})
    // Entering the password again signs in first, then clears the back-off.
    expect(await accounts.setPassword({ id: work, password: WORK.password })).toMatchObject({ ok: true })
    expect(accounts.list().find((a) => a.id === work)!.sync).toEqual({})
  })

  it('sends from the account picked, with its own sign-in, and keeps a copy in its Sent', async () => {
    const r = await client.send({
      account: work,
      to: HOME.email,
      cc: '',
      bcc: '',
      subject: `From work ${run}`,
      body: 'Hi from work',
      attachments: [],
    })
    expect(r).toEqual({ ok: true })
    const sent = client.mailboxes({ account: work }).find((m) => m.role === 'sent')!.path
    await client.refresh({ account: work, mailbox: sent })
    expect(
      client.messages({ account: work, mailbox: sent, limit: 500 }).messages.map((m) => m.subject),
    ).toContain(`From work ${run}`)
  })

  it('removing one account clears only its cache', async () => {
    await accounts.remove(work)
    expect(
      client
        .messages({ account: 'all', mailbox: 'INBOX', limit: 500 })
        .messages.every((m) => m.account === home),
    ).toBe(true)
    expect(mail.mailStore().cachedAccounts()).toEqual([home])
  })
})
