// The mail client's IMAP and SMTP parts against a real server. Start one with:
//   pnpm imap:start
// then: IMAP_TEST_PORT=3143 pnpm test:integration
// (SMTP_TEST_PORT defaults to 3025, which `pnpm imap:start` also opens.)
import { ImapFlow } from 'imapflow'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ImapMailProvider, READ_LIMITS } from './imap'
import { buildMessage, sendMessage } from './smtp'
import { MailStore } from './store'
import { syncFolder } from './sync'

const port = Number(process.env['IMAP_TEST_PORT'])
const cfg = {
  host: process.env['IMAP_TEST_HOST'] ?? '127.0.0.1',
  port,
  secure: false,
  user: 'test@ordo.test',
  pass: 'abcd-efgh-ijkl-mnop',
}
const run = `${Date.now()}`
const FOLDER = `Client ${run}`

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** HTML with an inline image, a plain-text part and a PDF attachment. */
const rich = (subject: string) =>
  [
    `From: Shop <shop-${run}@store.example>`,
    'To: test@ordo.test',
    `Subject: ${subject}`,
    'Date: Mon, 16 Nov 2026 10:00:00 +0000',
    'Message-ID: <rich-' + run + '@store.example>',
    'References: <a-' + run + '@store.example>',
    'In-Reply-To: <b-' + run + '@store.example>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="mixed"',
    '',
    '--mixed',
    'Content-Type: multipart/alternative; boundary="alt"',
    '',
    '--alt',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `Plain body ${run} £5`,
    '--alt',
    'Content-Type: multipart/related; boundary="rel"',
    '',
    '--rel',
    'Content-Type: text/html; charset=iso-8859-1',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    `<p>HTML body ${run} =A35</p><img src=3D"cid:logo@store">`,
    '--rel',
    'Content-Type: image/png',
    'Content-ID: <logo@store>',
    'Content-Disposition: inline',
    'Content-Transfer-Encoding: base64',
    '',
    PNG.toString('base64'),
    '--rel--',
    '--alt--',
    '--mixed',
    'Content-Type: application/pdf; name="Invoice.pdf"',
    'Content-Disposition: attachment; filename="Invoice.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('%PDF-1.4 fake').toString('base64'),
    '--mixed--',
    '',
  ].join('\r\n')

describe.skipIf(!port)('mail client against GreenMail', () => {
  let admin: ImapFlow
  let provider: ImapMailProvider

  beforeAll(async () => {
    admin = new ImapFlow({ ...cfg, auth: { user: cfg.user, pass: cfg.pass }, logger: false })
    await admin.connect()
    const boxes = await admin.list()
    for (const name of ['Sent', 'Trash', 'Drafts', 'Archive', FOLDER])
      if (!boxes.some((b) => b.path === name)) await admin.mailboxCreate(name).catch(() => {}) // the other integration file may create it at the same moment
    await admin.append(FOLDER, rich(`Rich ${run}`))
    for (const n of [1, 2, 3])
      await admin.append(
        FOLDER,
        `From: Sam <sam@friend.example>\r\nTo: test@ordo.test\r\nSubject: Note ${n} ${run}\r\n` +
          `Date: Mon, 16 Nov 2026 1${n}:00:00 +0000\r\n\r\nNote body ${n} pineapple-${run}\r\n`,
        n === 1 ? ['\\Seen'] : [],
      )
    provider = new ImapMailProvider(cfg)
    await provider.connect()
  })

  afterAll(async () => {
    await provider?.close()
    await admin?.logout()
  })

  it('lists folders with roles and counts', async () => {
    const list = await provider.listMailboxes()
    expect(list[0]).toMatchObject({ path: 'INBOX', name: 'Inbox', role: 'inbox' })
    expect(list.find((m) => m.path === 'Drafts')?.role).toBe('drafts')
    expect(list.find((m) => m.path === 'Archive')?.role).toBe('archive')
    expect(list.find((m) => m.path === FOLDER)).toMatchObject({ role: null, total: 4, unread: 3 })
  })

  it('syncs a folder into the cache and keeps flags current', async () => {
    const store = new MailStore(':memory:')
    try {
      expect(await syncFolder(provider, store, FOLDER, { initialLimit: 3 })).toMatchObject({ added: 3 })
      expect(store.messages(FOLDER, { limit: 10 }).messages.map((m) => m.subject)).toEqual([
        `Note 3 ${run}`,
        `Note 2 ${run}`,
        `Note 1 ${run}`,
      ])
      const [newest] = store.messages(FOLDER, { limit: 1 }).messages
      await provider.setFlag(FOLDER, [newest!.uid], '\\Flagged', true)
      await provider.setFlag(FOLDER, [newest!.uid], '\\Seen', true)
      expect(await syncFolder(provider, store, FOLDER)).toMatchObject({ added: 0, changed: 1 })
      expect(store.message(FOLDER, newest!.uid)).toMatchObject({ seen: true, flagged: true })
    } finally {
      store.close()
    }
  })

  it('reads a rich message without marking it read', async () => {
    const [uid] = (await provider.search(FOLDER, [`Rich`, run], 5)).map((h) => h.uid)
    const m = await provider.fetchMessage(FOLDER, uid!)
    expect(m).toMatchObject({
      subject: `Rich ${run}`,
      from: { address: `shop-${run}@store.example`, name: 'Shop' },
      messageId: `<rich-${run}@store.example>`,
      references: [`<a-${run}@store.example>`, `<b-${run}@store.example>`],
      inReplyTo: `<b-${run}@store.example>`,
      seen: false,
      truncated: false,
    })
    expect(m!.text).toContain(`Plain body ${run} £5`)
    // Quoted-printable Latin-1 comes back as UTF-8.
    expect(m!.html).toContain(`HTML body ${run} £5`)
    expect(m!.inlineImages['logo@store']).toBe(`data:image/png;base64,${PNG.toString('base64')}`)
    expect(m!.attachments.filter((a) => !a.inline).map((a) => a.filename)).toEqual(['Invoice.pdf'])
    const pdf = m!.attachments.find((a) => a.filename === 'Invoice.pdf')!
    expect((await provider.downloadPart(FOLDER, uid!, pdf.part))?.content.toString()).toBe('%PDF-1.4 fake')
    // Still unread on the server.
    expect((await provider.fetchFlags(FOLDER, [uid!]))[0]?.seen).toBe(false)
    expect(await provider.fetchMessage(FOLDER, 999_999)).toBeNull()
  })

  it('reads at most the body limit however many parts an email splits its HTML into', async () => {
    const piece = `<p>${'x'.repeat(1024 * 1024)}</p>`
    const parts = Array.from({ length: 4 }, () =>
      ['--mixed', 'Content-Type: text/html; charset=utf-8', '', piece].join('\r\n'),
    )
    await admin.append(
      FOLDER,
      [
        `From: Big <big-${run}@store.example>`,
        `Subject: Huge ${run}`,
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="mixed"',
        '',
        ...parts,
        '--mixed--',
        '',
      ].join('\r\n'),
    )
    const [h] = await provider.search(FOLDER, ['Huge', run], 1)
    const m = await provider.fetchMessage(FOLDER, h!.uid)
    expect(m!.truncated).toBe(true)
    expect(m!.html!.length).toBeLessThanOrEqual(Math.ceil(READ_LIMITS.body * 1.4) + 100)
    expect(m!.html!.length).toBeGreaterThan(2 * 1024 * 1024)
  })

  it('searches the server for every word, in bodies too', async () => {
    const found = await provider.search(FOLDER, [`pineapple-${run}`], 10)
    expect(found.map((h) => h.subject).sort()).toEqual([`Note 1 ${run}`, `Note 2 ${run}`, `Note 3 ${run}`])
    expect(await provider.search(FOLDER, [`pineapple-${run}`, 'nothing-like-this'], 10)).toEqual([])
    expect((await provider.search(FOLDER, [`pineapple-${run}`], 1)).map((h) => h.subject)).toEqual([
      `Note 3 ${run}`,
    ])
  })

  it('saves a draft and replaces only that draft', async () => {
    const draft = await buildMessage(
      {
        from: { address: cfg.user },
        to: [],
        cc: [],
        bcc: [{ address: 'hidden@friend.example' }],
        subject: `Draft ${run}`,
        text: 'Half written',
        attachments: [],
      },
      { keepBcc: true },
    )
    const saved = await provider.append('Drafts', draft.raw, ['\\Draft', '\\Seen'])
    expect(saved.uid).toBeGreaterThan(0)
    const m = await provider.fetchMessage('Drafts', saved.uid!)
    expect(m).toMatchObject({
      subject: `Draft ${run}`,
      draft: true,
      bcc: [{ address: 'hidden@friend.example' }],
    })
    expect(await provider.deleteDraft('Drafts', saved.uid!)).toBe(true)
    expect(await provider.fetchMessage('Drafts', saved.uid!)).toBeNull()
    // Something that isn't a draft is never removed.
    const [note] = await provider.search(FOLDER, [`pineapple-${run}`], 1)
    expect(await provider.deleteDraft(FOLDER, note!.uid)).toBe(false)
  })

  it('sends a message over SMTP, with Bcc kept out of what is delivered', async () => {
    const smtpPort = Number(process.env['SMTP_TEST_PORT'] ?? 3025)
    const { sentCopy, messageId } = await sendMessage(
      { host: cfg.host, port: smtpPort, secure: false, requireTLS: false, user: cfg.user, pass: cfg.pass },
      {
        from: { address: cfg.user, name: 'Test' },
        to: [{ address: cfg.user }],
        cc: [],
        bcc: [{ address: 'hidden@friend.example' }],
        subject: `Sent ${run}`,
        text: 'Hello from Ordo',
        inReplyTo: `<rich-${run}@store.example>`,
        references: [`<rich-${run}@store.example>`],
        attachments: [{ filename: 'hello.txt', content: Buffer.from('hi') }],
      },
    )
    expect(sentCopy.toString()).toMatch(/^Bcc: hidden@friend\.example/m)
    const lock = await admin.getMailboxLock('INBOX')
    try {
      let uids: number[] = []
      for (let i = 0; i < 20 && !uids.length; i++) {
        uids = (await admin.search({ subject: `Sent ${run}` }, { uid: true })) || []
        if (!uids.length) await new Promise((r) => setTimeout(r, 100))
      }
      expect(uids).toHaveLength(1)
      const got = await admin.fetchOne(String(uids[0]), { source: true, envelope: true }, { uid: true })
      const source = got && got.source ? got.source.toString() : ''
      expect(source).not.toMatch(/^Bcc:/m)
      expect(source).toMatch(/^In-Reply-To: <rich-/m)
      expect(got && got.envelope?.messageId).toBe(messageId)
    } finally {
      lock.release()
    }
  })
})
