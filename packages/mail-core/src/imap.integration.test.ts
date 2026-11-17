// Runs against a real IMAP server. Start one with:
//   pnpm imap:start
// then: IMAP_TEST_PORT=3143 pnpm test:integration
// (SMTP_TEST_PORT defaults to 3025, which `pnpm imap:start` also opens.)
import { ImapFlow } from 'imapflow'
import { beforeAll, describe, expect, it } from 'vitest'
import { analyseSenders } from './analyse'
import { runCleanup, undoCleanup } from './cleanup'
import { buildCleanupPlan } from './cleanup-plan'
import { ImapMailProvider, MailAuthError, testImapLogin } from './imap'
import { scanMailbox } from './scan'
import { createMailtoSender } from './smtp'
import { MailStore } from './store'
import { parseMailto } from './unsubscribe'

const port = Number(process.env['IMAP_TEST_PORT'])
const cfg = {
  host: process.env['IMAP_TEST_HOST'] ?? '127.0.0.1',
  port,
  secure: false,
  user: 'test@ordo.test',
  pass: 'abcd-efgh-ijkl-mnop',
}

const raw = (from: string, subject: string, extra = '') =>
  `From: ${from}\r\nTo: test@ordo.test\r\nSubject: ${subject}\r\nDate: Mon, 16 Nov 2026 10:00:00 +0000\r\n${extra}Content-Type: text/plain\r\n\r\nBody\r\n`

describe.skipIf(!port)('IMAP integration (GreenMail)', () => {
  beforeAll(async () => {
    const c = new ImapFlow({ ...cfg, auth: { user: cfg.user, pass: cfg.pass }, logger: false })
    await c.connect()
    const boxes = await c.list()
    if (!boxes.some((b) => b.path === 'Sent')) await c.mailboxCreate('Sent')
    // GreenMail starts with INBOX only; imapflow recognises a mailbox named Trash as \Trash.
    if (!boxes.some((b) => b.path === 'Trash')) await c.mailboxCreate('Trash')
    await c.append(
      'INBOX',
      raw(
        'Shop <deals@shop.example>',
        '50% off everything',
        'List-Unsubscribe: <https://shop.example/u>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n',
      ),
    )
    await c.append(
      'INBOX',
      raw('Shop <deals@shop.example>', 'Sale ends tonight', 'List-Id: <deals.shop.example>\r\n'),
      ['\\Seen'],
    )
    await c.append('INBOX', raw('Sam <sam@friend.example>', 'Dinner?'))
    await c.append(
      'Sent',
      raw('Me <test@ordo.test>', 'Re: Dinner?').replace('To: test@ordo.test', 'To: sam@friend.example'),
    )
    await c.logout()
  })

  it('rejects a wrong password with MailAuthError', async () => {
    await expect(testImapLogin({ ...cfg, pass: 'wrong' })).rejects.toBeInstanceOf(MailAuthError)
  })

  it('scans headers and sorts senders end to end', async () => {
    const provider = new ImapMailProvider(cfg)
    await provider.connect()
    const store = new MailStore(':memory:')
    try {
      const res = await scanMailbox(provider, store)
      expect(res.total).toBeGreaterThanOrEqual(3)
      const senders = analyseSenders(store.headers('INBOX'), store.repliedTo())
      const shop = senders.find((s) => s.address === 'deals@shop.example')
      const sam = senders.find((s) => s.address === 'sam@friend.example')
      expect(shop).toMatchObject({ category: 'promotions', bulk: true, unsubscribe: { kind: 'one-click' } })
      expect(shop?.unread).toBeGreaterThanOrEqual(1)
      expect(sam?.category).toBe('people')
      // A second scan finds nothing new.
      expect((await scanMailbox(provider, store)).added).toBe(0)
    } finally {
      store.close()
      await provider.close()
    }
  })

  it('moves a sender to Trash with a UID map, and undo puts the emails back', async () => {
    const run = `${Date.now()}`
    const from = `promo-${run}@store.example`
    const c = new ImapFlow({ ...cfg, auth: { user: cfg.user, pass: cfg.pass }, logger: false })
    await c.connect()
    for (const n of [1, 2, 3])
      await c.append(
        'INBOX',
        raw(`Store <${from}>`, `Deal ${n} ${run}`, 'List-Id: <deals.store.example>\r\n'),
      )

    const provider = new ImapMailProvider(cfg)
    await provider.connect()
    const store = new MailStore(':memory:')
    const countIn = async (mailbox: string) => {
      const lock = await c.getMailboxLock(mailbox)
      try {
        return ((await c.search({ from }, { uid: true })) || []).length
      } finally {
        lock.release()
      }
    }
    try {
      await scanMailbox(provider, store)
      const senders = analyseSenders(store.headers('INBOX'), store.repliedTo())
      const plan = buildCleanupPlan(senders, store.repliedTo(), [
        { address: from, unsubscribe: false, trash: true },
        { address: 'sam@friend.example', unsubscribe: false, trash: true },
      ])
      expect(plan.rejected.map((r) => r.address)).toEqual(['sam@friend.example'])

      const record = await runCleanup(provider, store, plan.senders, {
        batchSize: 2,
        unsubscribe: async () => {
          throw new Error('not called')
        },
      })
      expect(record).toMatchObject({ moved: 3, trashMailbox: 'Trash', error: null, canUndo: true })
      expect(record.uidMap).toHaveLength(3)
      expect(record.trashUidValidity).toBe((await provider.status('Trash')).uidValidity)
      expect(await countIn('INBOX')).toBe(0)
      expect(await countIn('Trash')).toBe(3)
      expect(store.uidsFrom('INBOX', [from]).get(from)).toEqual([])

      expect(await undoCleanup(provider, store, record.id)).toEqual({ restored: 3, missing: 0 })
      expect(await countIn('INBOX')).toBe(3)
      expect(await countIn('Trash')).toBe(0)
      // The restored emails come back on the next scan.
      await scanMailbox(provider, store)
      expect(store.uidsFrom('INBOX', [from]).get(from)).toHaveLength(3)
    } finally {
      store.close()
      await provider.close()
      await c.logout()
    }
  })

  it('sends a mailto unsubscribe over SMTP', async () => {
    const run = `${Date.now()}`
    const sender = createMailtoSender(
      {
        host: cfg.host,
        port: Number(process.env['SMTP_TEST_PORT'] ?? 3025),
        secure: false,
        requireTLS: false,
        user: cfg.user,
        pass: cfg.pass,
      },
      cfg.user,
    )
    try {
      await sender.send(parseMailto(`mailto:${cfg.user}?subject=unsubscribe%20${run}&body=list%3Dweekly`)!)
    } finally {
      sender.close()
    }
    const c = new ImapFlow({ ...cfg, auth: { user: cfg.user, pass: cfg.pass }, logger: false })
    await c.connect()
    try {
      const lock = await c.getMailboxLock('INBOX')
      try {
        const found = (await c.search({ subject: `unsubscribe ${run}` }, { uid: true })) || []
        expect(found).toHaveLength(1)
      } finally {
        lock.release()
      }
    } finally {
      await c.logout()
    }
  })
})
