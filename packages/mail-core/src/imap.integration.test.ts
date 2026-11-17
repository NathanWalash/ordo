// Runs against a real IMAP server. Start one with:
//   pnpm imap:start
// then: IMAP_TEST_PORT=3143 pnpm test:integration
import { ImapFlow } from 'imapflow'
import { beforeAll, describe, expect, it } from 'vitest'
import { analyseSenders } from './analyse'
import { ImapMailProvider, MailAuthError, testImapLogin } from './imap'
import { scanMailbox } from './scan'
import { MailStore } from './store'

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
})
