// Two accounts at once against a real IMAP server. Start one with:
//   pnpm imap:start
// then: IMAP_TEST_PORT=3143 pnpm test:integration
// `pnpm imap:start` creates two users: test@ordo.test (iCloud-style folders: Sent, Trash) and
// work@work.ordo.test, given a Gmail-style layout here ([Gmail]/Sent Mail, [Gmail]/Bin,
// [Gmail]/Spam, [Gmail]/All Mail and a label folder). GreenMail has no SPECIAL-USE, so roles come
// from imapflow's name guesses; Gmail's real `\All` flag is covered by recorded LIST responses in
// folder-roles.test.ts.
import { ImapFlow } from 'imapflow'
import { beforeAll, describe, expect, it } from 'vitest'
import { analyseSenders } from './analyse'
import { runCleanup, undoCleanup } from './cleanup'
import { buildCleanupPlan } from './cleanup-plan'
import { ImapMailProvider, MailAuthError } from './imap'
import { scanMailbox } from './scan'
import { sendMessage } from './smtp'
import { MailStore } from './store'
import { syncFolder } from './sync'

const port = Number(process.env['IMAP_TEST_PORT'])
const host = process.env['IMAP_TEST_HOST'] ?? '127.0.0.1'
const smtpPort = Number(process.env['SMTP_TEST_PORT'] ?? 3025)
const HOME = { host, port, secure: false, user: 'test@ordo.test', pass: 'abcd-efgh-ijkl-mnop' }
const WORK = { host, port, secure: false, user: 'work@work.ordo.test', pass: 'qrst-uvwx-yzab-cdef' }
const run = `${Date.now()}`
/** Gmail's folders, under the server's own delimiter (GreenMail uses `.`, Gmail itself `/`). */
const G = { sent: '', bin: '', spam: '', all: '' }

const raw = (from: string, to: string, subject: string, extra = '') =>
  `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: Mon, 16 Nov 2026 10:00:00 +0000\r\n${extra}Content-Type: text/plain\r\n\r\nBody\r\n`

async function client(cfg: typeof HOME) {
  const c = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: false,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  })
  await c.connect()
  return c
}

async function count(c: ImapFlow, mailbox: string, query: Record<string, string>) {
  const lock = await c.getMailboxLock(mailbox)
  try {
    return ((await c.search(query, { uid: true })) || []).length
  } finally {
    lock.release()
  }
}

describe.skipIf(!port)('two accounts at once (GreenMail)', () => {
  beforeAll(async () => {
    const home = await client(HOME)
    const homeBoxes = (await home.list()).map((b) => b.path)
    for (const box of ['Sent', 'Trash'])
      if (!homeBoxes.includes(box)) await home.mailboxCreate(box).catch(() => {})
    await home.append('INBOX', raw('Sam <sam@friend.example>', HOME.user, `Dinner ${run}?`))
    await home.logout()

    const work = await client(WORK)
    const listed = await work.list()
    const d = listed.find((b) => b.path === 'INBOX')?.delimiter || '/'
    Object.assign(G, {
      sent: `[Gmail]${d}Sent Mail`,
      bin: `[Gmail]${d}Bin`,
      spam: `[Gmail]${d}Spam`,
      all: `[Gmail]${d}All Mail`,
    })
    const workBoxes = listed.map((b) => b.path)
    for (const box of [G.sent, G.bin, G.spam, G.all, 'Receipts'])
      if (!workBoxes.includes(box)) await work.mailboxCreate(box).catch(() => {})
    for (const n of [1, 2, 3])
      await work.append(
        'INBOX',
        raw(
          `Tool <news-${run}@saas.example>`,
          WORK.user,
          `Release notes ${n} ${run}`,
          'List-Id: <news.saas.example>\r\n',
        ),
      )
    await work.append(G.sent, raw(`Me <${WORK.user}>`, 'boss@corp.example', `Re: Plan ${run}`))
    await work.logout()
  })

  it('scans both inboxes into one cache at once, each on its own connection, kept apart', async () => {
    const root = new MailStore(':memory:')
    const home = root.forAccount('acc-home')
    const work = root.forAccount('acc-work')
    const homeP = new ImapMailProvider(HOME)
    const workP = new ImapMailProvider(WORK)
    try {
      await Promise.all([homeP.connect(), workP.connect()])
      const [h, w] = await Promise.all([scanMailbox(homeP, home), scanMailbox(workP, work)])
      expect(h.total).toBeGreaterThanOrEqual(1)
      expect(w.total).toBeGreaterThanOrEqual(3)
      expect(home.headers('INBOX').every((m) => m.account === 'acc-home')).toBe(true)
      expect(work.search(`Release notes ${run}`, { limit: 10 })).toHaveLength(3)
      expect(home.search(`Release notes ${run}`, { limit: 10 })).toHaveLength(0)
      // The unified inbox has both, newest first, with the same UIDs told apart by account.
      const all = root.messagesAcross(['acc-home', 'acc-work'], 'INBOX', { limit: 500 })
      expect(all.total).toBe(home.count('INBOX') + work.count('INBOX'))
      expect(new Set(all.messages.map((m) => m.account))).toEqual(new Set(['acc-home', 'acc-work']))
      // People you've written to from the work account are protected in the home inbox too.
      expect(root.repliedTo().has('boss@corp.example')).toBe(true)
    } finally {
      await Promise.all([homeP.close(), workP.close()])
      root.close()
    }
  })

  it('one account with a wrong password fails on its own; the other scans', async () => {
    const root = new MailStore(':memory:')
    const bad = new ImapMailProvider({ ...WORK, pass: 'wrong-pass-word-here' })
    const good = new ImapMailProvider(HOME)
    try {
      const [b, g] = await Promise.allSettled([
        bad.connect().then(() => scanMailbox(bad, root.forAccount('acc-work'))),
        good.connect().then(() => scanMailbox(good, root.forAccount('acc-home'))),
      ])
      expect(b.status).toBe('rejected')
      expect((b as PromiseRejectedResult).reason).toBeInstanceOf(MailAuthError)
      expect(g).toMatchObject({ status: 'fulfilled', value: { stopped: false } })
      expect(root.cachedAccounts()).toEqual(['acc-home'])
    } finally {
      await bad.close()
      await good.close()
      root.close()
    }
  })

  it('finds a Gmail-style account’s Sent, Bin and Spam, with labels as folders', async () => {
    const p = new ImapMailProvider(WORK)
    try {
      await p.connect()
      const list = await p.listMailboxes()
      const role = (r: string) => list.find((m) => m.role === r)?.path
      expect(role('inbox')).toBe('INBOX')
      expect(role('sent')).toBe(G.sent)
      expect(role('trash')).toBe(G.bin)
      expect(role('junk')).toBe(G.spam)
      expect(list.find((m) => m.path === 'Receipts')?.role).toBeNull()
      expect(await p.findMailbox('\\Trash')).toBe(G.bin)
      // A label folder syncs like any other.
      const store = new MailStore(':memory:').forAccount('acc-work')
      await syncFolder(p, store, 'Receipts')
      expect(store.mailboxState('Receipts')).not.toBeNull()
    } finally {
      await p.close()
    }
  })

  it('clears a sender in the Gmail-style account by moving to its Bin, and undo puts it back', async () => {
    const root = new MailStore(':memory:')
    const work = root.forAccount('acc-work')
    const home = root.forAccount('acc-home')
    const workP = new ImapMailProvider(WORK)
    const homeP = new ImapMailProvider(HOME)
    const c = await client(WORK)
    const from = `news-${run}@saas.example`
    try {
      await Promise.all([workP.connect(), homeP.connect()])
      await scanMailbox(workP, work)
      await scanMailbox(homeP, home)
      const homeBefore = home.count('INBOX')
      const plan = buildCleanupPlan(
        analyseSenders(work.headers('INBOX'), root.repliedTo()),
        root.repliedTo(),
        [{ address: from, unsubscribe: false, trash: true }],
      )
      const record = await runCleanup(workP, work, plan.senders, {
        unsubscribe: async () => {
          throw new Error('not called')
        },
      })
      expect(record).toMatchObject({
        account: 'acc-work',
        moved: 3,
        trashMailbox: G.bin,
        canUndo: true,
      })
      expect(await count(c, 'INBOX', { from })).toBe(0)
      expect(await count(c, G.bin, { from })).toBe(3)
      // The other account is untouched, in the cache and on its server.
      expect(home.count('INBOX')).toBe(homeBefore)
      expect(home.cleanup(record.id)?.account).toBe('acc-work')

      expect(await undoCleanup(workP, work, record.id)).toEqual({ restored: 3, missing: 0 })
      expect(await count(c, 'INBOX', { from })).toBe(3)
    } finally {
      await c.logout()
      await Promise.all([workP.close(), homeP.close()])
      root.close()
    }
  })

  it('sends from the work account with its own sign-in, and it arrives from that address', async () => {
    const subject = `From work ${run}`
    const sent = await sendMessage(
      { host, port: smtpPort, secure: false, requireTLS: false, user: WORK.user, pass: WORK.pass },
      {
        from: { address: WORK.user },
        to: [{ address: HOME.user }],
        cc: [],
        bcc: [],
        subject,
        text: 'Hello from the other account',
        attachments: [],
      },
    )
    expect(sent.rejected).toEqual([])
    const c = await client(HOME)
    try {
      // Delivery is quick but not instant.
      let found = 0
      for (let i = 0; i < 20 && !found; i++) {
        found = await count(c, 'INBOX', { subject })
        if (!found) await new Promise((r) => setTimeout(r, 100))
      }
      expect(found).toBe(1)
      expect(await count(c, 'INBOX', { subject, from: WORK.user })).toBe(1)
    } finally {
      await c.logout()
    }
  })
})
