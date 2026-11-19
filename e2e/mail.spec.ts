import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImapFlow } from 'imapflow'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { imapPort, TEST_ACCOUNT } from './imap'
import { launchApp } from './launch'

// The mail client against GreenMail (IMAP and SMTP) and a local image server: reading HTML
// safely, links, images, attachments, flags, moves with undo, search, and writing mail.
// Set ORDO_E2E_SCREENSHOTS=1 to save the screens in light and dark under test-results/screenshots/.

test.describe.configure({ mode: 'serial' })
test.skip(!imapPort, 'Set IMAP_TEST_PORT and run `pnpm imap:start` to test against a local IMAP server')

const smtpPort = process.env['SMTP_TEST_PORT'] ?? '3025'
const run = Date.now().toString(36)
const NEWS = `Weekly news ${run}`
const LUNCH = `Lunch on Friday ${run}`
const OLD = `Old receipt ${run}`
const PLAIN = `Plain HTML ${run}`
const FOLDER = `Projects ${run}`
const shots = process.env['ORDO_E2E_SCREENSHOTS'] === '1'
const files = mkdtempSync(join(tmpdir(), 'ordo-mail-e2e-'))

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

let app: ElectronApplication
let page: Page
let server: Server
let imagePort = 0
const imageHits: { url?: string; headers: IncomingHttpHeaders }[] = []

function imap() {
  return new ImapFlow({
    host: '127.0.0.1',
    port: Number(imapPort),
    secure: false,
    auth: { user: TEST_ACCOUNT.email, pass: TEST_ACCOUNT.password },
    logger: false,
  })
}

/** Run something against the test account directly, to see what really happened on the server. */
async function withImap<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = imap()
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.logout()
  }
}

async function find(mailbox: string, subject: string) {
  return withImap(async (c) => {
    const lock = await c.getMailboxLock(mailbox)
    try {
      const uids = (await c.search({ subject }, { uid: true })) || []
      const out: { uid: number; flags: Set<string>; source: string }[] = []
      for (const uid of uids) {
        const m = await c.fetchOne(String(uid), { uid: true, flags: true, source: true }, { uid: true })
        if (m) out.push({ uid, flags: m.flags ?? new Set(), source: m.source?.toString() ?? '' })
      }
      return out
    } finally {
      lock.release()
    }
  })
}

/** Wait for the server to show what the app did. */
async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (ok(v) || Date.now() > until) return v
    await new Promise((r) => setTimeout(r, 200))
  }
}

async function screenshot(name: string) {
  if (!shots) return
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => window.ordo.settings.set({ theme: t }), theme)
    await page.waitForTimeout(300)
    await page.screenshot({ path: `test-results/screenshots/mail-${name}-${theme}.png` })
  }
  await page.evaluate(() => window.ordo.settings.set({ theme: 'system' }))
}

const newsletter = () =>
  [
    `From: News Desk <digest-${run}@news.example>`,
    `To: ${TEST_ACCOUNT.email}`,
    `Subject: ${NEWS}`,
    'Date: Mon, 16 Nov 2026 09:00:00 +0000',
    `Message-ID: <news-${run}@news.example>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="mixed"',
    '',
    '--mixed',
    'Content-Type: multipart/related; boundary="rel"',
    '',
    '--rel',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<html><head><title>x</title><style>h1 { color: rgb(1, 2, 3) }</style></head><body>',
    `<h1>Hello from the newsletter ${run}</h1>`,
    `<p>Tracked: <img id="pixel" src="http://127.0.0.1:${'{PORT}'}/pixel.png?r=${run}" width="1" height="1"></p>`,
    '<p>Logo: <img id="logo" src="cid:logo@news"></p>',
    '<script>document.title = "pwned"; parent.document.title = "pwned"</script>',
    '<img id="evil" src="x" onerror="parent.document.title=\'pwned\'">',
    '<p><a id="phish" href="https://evil.example/login">www.mybank.co.uk</a></p>',
    '<p><a id="mailto-link" href="mailto:editor@news.example?subject=Feedback&bcc=spy@evil.example">Write to us</a></p>',
    '<p><a id="js" href="javascript:parent.document.title=\'pwned\'">Script link</a></p>',
    '<form action="https://evil.example/steal"><input name="q"><button id="submit">Go</button></form>',
    '<iframe src="https://evil.example/frame"></iframe>',
    '</body></html>',
    '--rel',
    'Content-Type: image/png',
    'Content-ID: <logo@news>',
    'Content-Disposition: inline',
    'Content-Transfer-Encoding: base64',
    '',
    PNG.toString('base64'),
    '--rel--',
    '--mixed',
    `Content-Type: text/plain; name="notes-${run}.txt"`,
    `Content-Disposition: attachment; filename="notes-${run}.txt"`,
    '',
    `These are the notes ${run}.`,
    '--mixed--',
    '',
  ].join('\r\n')

test.beforeAll(async () => {
  server = createServer((req, res) => {
    imageHits.push({ url: req.url, headers: req.headers })
    res.writeHead(200, { 'content-type': 'image/png' }).end(PNG)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  imagePort = (server.address() as AddressInfo).port

  await withImap(async (c) => {
    const have = new Set((await c.list()).map((b) => b.path))
    for (const name of ['Sent', 'Drafts', 'Archive', 'Junk', 'Trash', FOLDER])
      if (!have.has(name)) await c.mailboxCreate(name)
    await c.append('INBOX', newsletter().replace('{PORT}', String(imagePort)))
    await c.append(
      'INBOX',
      `From: Sam <sam@friend.example>\r\nTo: ${TEST_ACCOUNT.email}\r\nCc: Pat <pat@friend.example>\r\n` +
        `Subject: ${LUNCH}\r\nMessage-ID: <lunch-${run}@friend.example>\r\nDate: Mon, 16 Nov 2026 12:00:00 +0000\r\n\r\n` +
        `Are you free on Friday? The menu is at https://cafe.example/menu. Codeword pumpkin${run}.\r\n`,
    )
    await c.append(
      'INBOX',
      `From: Order Desk <orders@shop.example>\r\nTo: ${TEST_ACCOUNT.email}\r\nSubject: ${OLD}\r\n` +
        `Date: Sun, 15 Nov 2026 08:00:00 +0000\r\n\r\nThanks for your order.\r\n`,
    )
    // HTML with no colours of its own: it should follow the app into dark mode.
    await c.append(
      'INBOX',
      `From: Pat <pat@friend.example>\r\nTo: ${TEST_ACCOUNT.email}\r\nSubject: ${PLAIN}\r\n` +
        `Date: Sat, 14 Nov 2026 08:00:00 +0000\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Just words ${run}</p>\r\n`,
    )
  })

  app = await launchApp({
    ORDO_IMAP_HOST: '127.0.0.1',
    ORDO_IMAP_PORT: imapPort!,
    ORDO_SMTP_HOST: '127.0.0.1',
    ORDO_SMTP_PORT: smtpPort,
    // Unpackaged test builds only: let Load images reach the local image server.
    ORDO_TEST_ALLOW_LOOPBACK_HTTP: '1',
  })
  page = await app.firstWindow()
  // Never open a real browser or a real dialog from a test.
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { opened: string[] }
    g.opened = []
    shell.openExternal = async (url: string) => {
      g.opened.push(url)
    }
  })
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
})

const list = () => page.getByRole('listbox')
const row = (subject: string) => list().getByRole('option', { name: new RegExp(subject) })
const frame = () => page.frameLocator('iframe[title="Message body"]')
const toolbar = () => page.getByRole('group', { name: 'Mail' })
const reader = () => page.getByRole('region', { name: 'Reading pane' })
const recipients = (dialog: ReturnType<Page['getByRole']>, field: string) =>
  dialog.getByRole('list', { name: `${field} recipients` })

test('connects and shows the mailboxes and inbox', async () => {
  await page.getByRole('navigation').getByRole('button', { name: 'Mail' }).click()
  await page.getByRole('button', { name: 'Connect iCloud' }).click()
  await page.getByLabel('Apple ID email').fill(TEST_ACCOUNT.email)
  await page.getByLabel('App-specific password').fill(TEST_ACCOUNT.password)
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click()
  // Connecting opens Unclutter; go to the mail client from there.
  await expect(page.getByRole('heading', { level: 1, name: 'Unclutter' })).toBeVisible()
  await page.getByRole('navigation').getByRole('button', { name: 'Mail' }).click()

  await expect(row(NEWS)).toBeVisible({ timeout: 20_000 })
  await expect(row(NEWS)).toHaveAccessibleName(new RegExp(`^Unread\\. News Desk: ${NEWS}`))
  const boxes = page.getByRole('complementary', { name: 'Mailboxes' })
  for (const name of ['Drafts', 'Sent', 'Archive', 'Junk', 'Bin', FOLDER])
    await expect(boxes.getByRole('button', { name, exact: true })).toBeVisible()
  await expect(boxes.getByRole('button', { name: /^Inbox, \d+ unread$/ })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible()
})

test('shows HTML mail in a locked-down frame with remote images blocked', async () => {
  await row(NEWS).click()
  await expect(frame().getByRole('heading', { name: `Hello from the newsletter ${run}` })).toBeVisible()
  const iframe = page.locator('iframe[title="Message body"]')
  await expect(iframe).toHaveAttribute('sandbox', 'allow-same-origin')

  // Scripts, handlers, forms and frames are gone, and nothing ran.
  expect(await page.title()).toBe('Ordo')
  await expect(frame().locator('script, form, iframe, input, [onerror]')).toHaveCount(0)
  await expect(frame().locator('#js')).not.toHaveAttribute('href')
  await expect(frame().locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
    'content',
    /default-src 'none'; img-src data:/,
  )
  // The message's own styles still apply.
  await expect(frame().locator('h1')).toHaveCSS('color', 'rgb(1, 2, 3)')

  // The tracking pixel never loaded; the inline logo did, from the message itself.
  await expect(
    page.getByText('Ordo blocked 1 remote image so the sender can’t tell you’ve opened it.'),
  ).toBeVisible()
  await expect(frame().locator('#pixel')).not.toHaveAttribute('src')
  await expect(frame().locator('#logo')).toHaveAttribute('src', /^data:image\/png;base64,/)
  expect(imageHits).toHaveLength(0)

  // Opening it marked it read, on the server too.
  await expect(row(NEWS)).toHaveAccessibleName(new RegExp(`^News Desk: ${NEWS}`))
  const [msg] = await eventually(
    () => find('INBOX', NEWS),
    (m) => m[0]?.flags.has('\\Seen') === true,
  )
  expect(msg?.flags.has('\\Seen')).toBe(true)

  // The frame is as tall as the message, so only the reading pane scrolls.
  const sizes = await frame()
    .locator('html')
    .evaluate((html) => ({ doc: html.scrollHeight, view: html.clientHeight }))
  expect(sizes.view).toBeGreaterThanOrEqual(sizes.doc)
  await expect(frame().locator('html')).toHaveCSS('overflow-y', 'hidden')
  await screenshot('reading')
})

test('Load images fetches them through Ordo, without cookies, for this message only', async () => {
  await page.getByRole('button', { name: 'Load images' }).click()
  await expect(frame().locator('#pixel')).toHaveAttribute('src', /^data:image\/png;base64,/)
  expect(imageHits).toHaveLength(1)
  expect(imageHits[0]).toMatchObject({ url: `/pixel.png?r=${run}`, headers: { 'user-agent': 'Ordo' } })
  expect(imageHits[0]!.headers.cookie).toBeUndefined()
  expect(imageHits[0]!.headers.referer).toBeUndefined()
  await expect(page.getByRole('button', { name: 'Load images' })).toHaveCount(0)
})

test('links ask first, warn about lookalikes and open in the browser, never in Ordo', async () => {
  await frame().locator('#phish').click()
  const sheet = page.getByRole('dialog', { name: 'This link may be a scam' })
  await expect(sheet).toBeVisible()
  await expect(sheet).toHaveAccessibleDescription(
    /The email shows mybank\.co\.uk, but the link really goes to evil\.example\./,
  )
  await expect(sheet.getByLabel('Link address')).toHaveText('https://evil.example/login')
  // The safe choice is the default: Return or Space doesn't open it.
  await expect(sheet.getByRole('button', { name: 'Don’t open' })).toBeFocused()
  await screenshot('link')
  await page.keyboard.press('Enter')
  await expect(sheet).toBeHidden()
  expect(await app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)).toEqual([])

  await frame().locator('#phish').click()
  await page.getByRole('dialog').getByRole('button', { name: 'Open anyway' }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  expect(await app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)).toEqual([
    'https://evil.example/login',
  ])
  // The frame stayed on the message.
  await expect(frame().getByRole('heading', { name: `Hello from the newsletter ${run}` })).toBeVisible()

  // Even a navigation the window didn't catch is refused by the main process: the request to
  // load a page into the frame never leaves Ordo.
  const before = imageHits.length
  await page.evaluate((port) => {
    const f = document.querySelector<HTMLIFrameElement>('iframe[title="Message body"]')!
    f.contentWindow!.location.href = `http://127.0.0.1:${port}/elsewhere`
  }, imagePort)
  await page.waitForTimeout(500)
  expect(imageHits.length).toBe(before)
  expect(page.frames().map((f) => f.url())).not.toContain(`http://127.0.0.1:${imagePort}/elsewhere`)
  // Show the message again for the next tests.
  await row(LUNCH).click()
  await row(NEWS).click()
  await expect(frame().getByRole('heading', { name: `Hello from the newsletter ${run}` })).toBeVisible()
})

test('a mailto: link starts a message, without the hidden Bcc', async () => {
  await frame().locator('#mailto-link').click()
  const compose = page.getByRole('dialog', { name: 'New message' })
  await expect(recipients(compose, 'To').getByRole('listitem')).toHaveText(['editor@news.example'])
  await expect(compose.getByLabel('Subject')).toHaveValue('Feedback')
  await expect(compose.getByRole('button', { name: 'Add Bcc' })).toBeVisible()
  // With changes, closing asks whether to keep a draft.
  await compose.getByLabel('Message').fill('Hello')
  await page.keyboard.press('Escape')
  await compose.getByRole('button', { name: 'Don’t save' }).click()
  await expect(compose).toBeHidden()
})

test('saves an attachment with the save dialog', async () => {
  const target = join(files, `saved-${run}.txt`)
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath: path,
    })) as typeof dialog.showSaveDialog
  }, target)
  const attachments = page.getByRole('region', { name: 'Attachments' })
  await expect(attachments.getByText(`notes-${run}.txt`)).toBeVisible()
  await attachments.getByRole('button', { name: `Save notes-${run}.txt` }).click()
  await expect(attachments.getByRole('status')).toHaveText(`Saved notes-${run}.txt.`)
  expect(readFileSync(target, 'utf8')).toContain(`These are the notes ${run}.`)
  // Marked as downloaded, so the system checks it before it opens.
  if (process.platform === 'darwin')
    expect(execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', target]).toString()).toMatch(
      /^0083;[0-9a-f]+;Ordo;/,
    )
})

test('flags and marks unread, on the server too', async () => {
  await toolbar().getByRole('button', { name: 'Flag' }).click()
  await expect(row(NEWS)).toHaveAccessibleName(new RegExp(`^Flagged\\. News Desk: ${NEWS}`))
  await toolbar().getByRole('button', { name: 'Mark as unread' }).click()
  await expect(row(NEWS)).toHaveAccessibleName(new RegExp(`^Unread\\. Flagged\\. News Desk`))
  const [msg] = await eventually(
    () => find('INBOX', NEWS),
    (m) => m[0]?.flags.has('\\Flagged') === true && !m[0]?.flags.has('\\Seen'),
  )
  expect(msg?.flags.has('\\Flagged')).toBe(true)
  expect(msg?.flags.has('\\Seen')).toBe(false)
})

test('the arrow keys move through the list', async () => {
  await row(NEWS).click()
  await expect(row(NEWS)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(row(NEWS)).toHaveAttribute('aria-selected', 'false')
  await page.keyboard.press('ArrowUp')
  await expect(row(NEWS)).toHaveAttribute('aria-selected', 'true')
})

test('archive moves to Archive, and Undo puts it back', async () => {
  await row(OLD).click()
  await expect(reader().getByText('Thanks for your order.')).toBeVisible()
  await page.keyboard.press('e')
  await expect(page.getByRole('status').filter({ hasText: 'Moved to Archive.' })).toBeVisible()
  await expect(row(OLD)).toHaveCount(0)
  expect(
    await eventually(
      () => find('Archive', OLD),
      (m) => m.length === 1,
    ),
  ).toHaveLength(1)
  expect(await find('INBOX', OLD)).toHaveLength(0)

  await page.getByRole('status').getByRole('button', { name: 'Undo move' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Moved back.' })).toBeVisible()
  await expect(row(OLD)).toBeVisible()
  expect(await find('INBOX', OLD)).toHaveLength(1)
  expect(await find('Archive', OLD)).toHaveLength(0)
})

test('Move to Bin, then from Bin back to Inbox', async () => {
  await row(OLD).click()
  await toolbar().getByRole('button', { name: 'Move to Bin' }).click()
  await expect(row(OLD)).toHaveCount(0)
  await page
    .getByRole('complementary', { name: 'Mailboxes' })
    .getByRole('button', { name: 'Bin', exact: true })
    .click()
  await expect(page.getByRole('heading', { level: 1, name: 'Bin' })).toBeVisible()
  await row(OLD).click()
  await toolbar().getByRole('button', { name: 'Move to Inbox' }).click()
  await expect(row(OLD)).toHaveCount(0)
  expect(
    await eventually(
      () => find('INBOX', OLD),
      (m) => m.length === 1,
    ),
  ).toHaveLength(1)
  await page
    .getByRole('complementary', { name: 'Mailboxes' })
    .getByRole('button', { name: /^Inbox/ })
    .click()
  await expect(row(OLD)).toBeVisible({ timeout: 15_000 })
})

test('search finds downloaded mail, and searches the server for the rest', async () => {
  const search = page.getByRole('searchbox', { name: 'Search mail' })
  await row(LUNCH).click()
  await expect(reader().getByText(`pumpkin${run}`)).toBeVisible()
  await search.fill(`pumpkin${run}`)
  await expect(list().getByRole('option')).toHaveCount(1)
  await expect(row(LUNCH)).toBeVisible()

  // A word only the server knows (never opened here): found with the server search.
  await search.fill(`order`)
  await search.fill(`Thanks for your order`)
  await page.getByRole('button', { name: 'Search all of Inbox on iCloud' }).click()
  await expect(page.getByText('Searched all of Inbox on iCloud.')).toBeVisible()
  await expect(row(OLD)).toBeVisible()
  await search.press('Escape')
  await expect(search).toHaveValue('')
})

test('Send only works straight after a click', async () => {
  // Playwright's evaluate counts as a user gesture, which lasts five seconds in Chromium: call
  // send after it has run out, like a timer or a script would.
  const subject = `Sneaky ${run}`
  const r = await page.evaluate(
    (s) =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve(
              window.ordo.mail.send({
                to: 'test@ordo.test',
                cc: '',
                bcc: '',
                subject: s,
                body: 'x',
                attachments: [],
              }),
            ),
          5500,
        ),
      ),
    subject,
  )
  expect(r).toEqual({ ok: false, error: 'invalid', message: 'Click Send to send a message.' })
  expect(await find('INBOX', subject)).toHaveLength(0)
})

test('writes and sends a message with an attachment, keeping a copy in Sent', async () => {
  const file = join(files, `plan-${run}.txt`)
  writeFileSync(file, `The plan ${run}`)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [path],
    })) as typeof dialog.showOpenDialog
  }, file)

  await toolbar().getByRole('button', { name: 'New message' }).click()
  const compose = page.getByRole('dialog', { name: 'New message' })
  await expect(compose.getByLabel('To', { exact: true })).toBeFocused()
  await compose.getByLabel('To', { exact: true }).fill('not an address')
  await compose.getByLabel('Subject').fill(`Plan ${run}`)
  await compose.getByLabel('Message').fill(`Here is the plan ${run}.`)
  // Return in a field never sends.
  await compose.getByLabel('Subject').press('Enter')
  await compose.getByRole('button', { name: 'Send' }).click()
  await expect(compose.getByText('Check this address: not an address')).toBeVisible()
  // The cursor goes back to the field to fix.
  await expect(compose.getByLabel('To', { exact: true })).toBeFocused()

  await recipients(compose, 'To').getByRole('button', { name: 'Remove not an address' }).click()
  await compose.getByLabel('To', { exact: true }).fill(`Me <${TEST_ACCOUNT.email}>`)
  await compose.getByLabel('To', { exact: true }).press('Enter')
  // The token always shows the real address.
  await expect(recipients(compose, 'To').getByRole('listitem')).toHaveText([`Me <${TEST_ACCOUNT.email}>`])
  await compose.getByRole('button', { name: 'Add Bcc' }).click()
  await compose.getByLabel('Bcc', { exact: true }).fill('hidden@friend.example')
  await compose.getByRole('button', { name: 'Attach files…' }).click()
  await expect(compose.getByRole('list', { name: 'Attachments' }).getByText(`plan-${run}.txt`)).toBeVisible()
  await screenshot('compose')
  await compose.getByRole('button', { name: 'Send' }).click()
  await expect(compose).toBeHidden({ timeout: 15_000 })
  await expect(page.getByRole('status').filter({ hasText: 'Message sent.' })).toBeVisible()

  const [received] = await eventually(
    () => find('INBOX', `Plan ${run}`),
    (m) => m.length > 0,
  )
  expect(received?.source).toContain(`Here is the plan ${run}.`)
  expect(received?.source).toContain(`filename=plan-${run}.txt`)
  expect(received?.source).not.toMatch(/^Bcc:/m)
  const [copy] = await eventually(
    () => find('Sent', `Plan ${run}`),
    (m) => m.length > 0,
  )
  expect(copy?.source).toMatch(/^Bcc: hidden@friend\.example/m)
  expect(copy?.flags.has('\\Seen')).toBe(true)
})

test('replies in the thread and marks the original answered', async () => {
  await row(LUNCH).click()
  await toolbar().getByRole('button', { name: 'Reply all' }).click()
  const compose = page.getByRole('dialog', { name: 'Reply all' })
  await expect(recipients(compose, 'To').getByRole('listitem')).toHaveText(['Sam <sam@friend.example>'])
  await expect(recipients(compose, 'Cc').getByRole('listitem')).toHaveText(['Pat <pat@friend.example>'])
  await expect(compose.getByLabel('Subject')).toHaveValue(`Re: ${LUNCH}`)
  await expect(compose.getByLabel('Message')).toBeFocused()
  await expect(compose.getByLabel('Message')).toHaveValue(
    /Sam <sam@friend\.example> wrote:\n\n> Are you free on Friday\?/,
  )
  await compose.getByLabel('Message').press('Home')
  await compose.getByLabel('Message').pressSequentially('Yes please!')
  await compose.getByRole('button', { name: 'Send' }).click()
  await expect(compose).toBeHidden({ timeout: 15_000 })

  const [copy] = await eventually(
    () => find('Sent', `Re: ${LUNCH}`),
    (m) => m.length > 0,
  )
  expect(copy?.source).toMatch(new RegExp(`^In-Reply-To: <lunch-${run}@friend\\.example>`, 'm'))
  expect(copy?.source).toContain('Yes please!')
  const [original] = await eventually(
    () => find('INBOX', LUNCH),
    (m) => m[0]?.flags.has('\\Answered') === true,
  )
  expect(original?.flags.has('\\Answered')).toBe(true)
})

test('forwards with the attachment', async () => {
  await row(NEWS).click()
  await toolbar().getByRole('button', { name: 'Forward' }).click()
  const compose = page.getByRole('dialog', { name: 'Forward' })
  await expect(compose.getByLabel('Subject')).toHaveValue(`Fwd: ${NEWS}`)
  await expect(compose.getByLabel('Message')).toHaveValue(/---------- Forwarded message ----------/)
  await expect(compose.getByRole('list', { name: 'Attachments' }).getByText(`notes-${run}.txt`)).toBeVisible()
  await compose.getByLabel('To', { exact: true }).fill(TEST_ACCOUNT.email)
  await compose.getByRole('button', { name: 'Send' }).click()
  await expect(compose).toBeHidden({ timeout: 15_000 })
  const [got] = await eventually(
    () => find('INBOX', `Fwd: ${NEWS}`),
    (m) => m.length > 0,
  )
  expect(got?.source).toContain(`filename=notes-${run}.txt`)
})

test('saves a draft with an attachment twice, and sending it removes the draft', async () => {
  const file = join(files, `draft-file-${run}.txt`)
  writeFileSync(file, `Attached to the draft ${run}`)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [path],
    })) as typeof dialog.showOpenDialog
  }, file)
  await toolbar().getByRole('button', { name: 'New message' }).click()
  const compose = page.getByRole('dialog', { name: 'New message' })
  await compose.getByLabel('Subject').fill(`Draft ${run}`)
  await compose.getByLabel('Message').fill('Not finished')
  await compose.getByRole('button', { name: 'Attach files…' }).click()
  await compose.getByRole('button', { name: 'Save draft' }).click()
  await expect(compose.getByRole('status')).toHaveText('Saved to Drafts.')
  // A second save replaces the first, keeping the attachment that now lives in the draft.
  await compose.getByLabel('Message').fill('Not finished yet')
  await compose.getByRole('button', { name: 'Save draft' }).click()
  await expect(compose.getByRole('status')).toHaveText('Saved to Drafts.')
  await expect(
    compose.getByRole('list', { name: 'Attachments' }).getByText(`draft-file-${run}.txt`),
  ).toBeVisible()
  // Saved, so closing doesn't ask.
  await compose.getByRole('button', { name: 'Cancel' }).click()
  await expect(compose).toBeHidden()
  expect(
    await eventually(
      () => find('Drafts', `Draft ${run}`),
      (m) => m.length === 1,
    ),
  ).toHaveLength(1)

  await page
    .getByRole('complementary', { name: 'Mailboxes' })
    .getByRole('button', { name: 'Drafts', exact: true })
    .click()
  await row(`Draft ${run}`).click()
  await page.getByRole('button', { name: 'Edit draft' }).click()
  const draft = page.getByRole('dialog', { name: 'Draft' })
  await expect(draft.getByLabel('Message')).toHaveValue('Not finished yet')
  await expect(
    draft.getByRole('list', { name: 'Attachments' }).getByText(`draft-file-${run}.txt`),
  ).toBeVisible()
  await draft.getByLabel('To', { exact: true }).fill(TEST_ACCOUNT.email)
  await draft.getByRole('button', { name: 'Send' }).click()
  await expect(draft).toBeHidden({ timeout: 15_000 })
  expect(
    await eventually(
      () => find('Drafts', `Draft ${run}`),
      (m) => m.length === 0,
    ),
  ).toHaveLength(0)
  const [delivered] = await eventually(
    () => find('INBOX', `Draft ${run}`),
    (m) => m.length > 0,
  )
  expect(delivered?.source).toContain(`filename=draft-file-${run}.txt`)
  expect(delivered?.source).toContain('Not finished yet')
})

test('Mail’s own shortcuts work: ⌘R replies, ? lists them, and a sheet gives focus back', async () => {
  await page
    .getByRole('complementary', { name: 'Mailboxes' })
    .getByRole('button', { name: /^Inbox/ })
    .click()
  await row(LUNCH).click()
  await expect(reader().getByText(`pumpkin${run}`)).toBeVisible()
  await page.keyboard.press('Meta+r')
  const compose = page.getByRole('dialog', { name: 'Reply' })
  await expect(compose).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(compose).toBeHidden()
  // Focus is back in the list, so the arrow keys carry on working.
  await expect(list()).toBeFocused()
  await page.keyboard.press('?')
  const keys = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(keys.getByRole('cell', { name: 'Reply all' })).toBeVisible()
  await expect(keys.getByRole('button', { name: 'Done' })).toBeFocused()
  // Tab stays inside the sheet.
  await page.keyboard.press('Tab')
  await expect(keys.getByRole('button', { name: 'Done' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(keys).toBeHidden()
  // Typing in search never triggers a single-key shortcut.
  await page.getByRole('searchbox', { name: 'Search mail' }).fill('e')
  await expect(page.getByRole('status').filter({ hasText: 'Moved to Archive.' })).toHaveCount(0)
  await page.getByRole('searchbox', { name: 'Search mail' }).press('Escape')
})

test('scrolls past 500 messages without losing the list', async () => {
  test.setTimeout(120_000)
  const BIG = `Big ${run}`
  await withImap(async (c) => {
    await c.mailboxCreate(BIG)
    for (let i = 0; i < 520; i++)
      await c.append(
        BIG,
        `From: Bulk <bulk@x.example>\r\nSubject: Bulk ${i}\r\nDate: Mon, 16 Nov 2026 10:00:00 +0000\r\n\r\nx\r\n`,
      )
  })
  // The folder appears after the next check.
  await page.getByRole('button', { name: 'Check for new mail' }).click()
  await page
    .getByRole('complementary', { name: 'Mailboxes' })
    .getByRole('button', { name: new RegExp(`^${BIG}`) })
    .click()
  await expect(list().getByRole('option').first()).toBeVisible({ timeout: 20_000 })
  // Keep moving to the bottom: every page loads, past the 500 a single request can return (the
  // folder's first sync keeps its newest 500). Scroll events never reach the list here, so paging
  // has to come from the list noticing its end is in view, not from scrolling.
  await page.evaluate(() => {
    const block = (e: Event) => e.stopImmediatePropagation()
    window.addEventListener('scroll', block, true)
    ;(window as unknown as { unblockScroll: () => void }).unblockScroll = () =>
      window.removeEventListener('scroll', block, true)
  })
  await expect
    .poll(
      async () => {
        await list().evaluate((el) => {
          const box = el.parentElement!
          box.scrollTop = box.scrollHeight
        })
        return list().getByRole('option').count()
      },
      { timeout: 30_000 },
    )
    .toBe(500)
  await page.evaluate(() => (window as unknown as { unblockScroll: () => void }).unblockScroll())
  await expect(list().getByRole('option').first()).toBeAttached()
})

test('fits a small window: the folders become a rail, and Send stays in view', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(920, 600))
  await page.waitForTimeout(300)
  await page
    .getByRole('complementary', { name: 'Mailboxes' })
    .getByRole('button', { name: /^Inbox/ })
    .click()
  await row(`News Desk: ${NEWS}`).click()
  await expect(frame().getByRole('heading', { name: `Hello from the newsletter ${run}` })).toBeVisible()
  await screenshot('narrow')
  await toolbar().getByRole('button', { name: 'New message' }).click()
  const compose = page.getByRole('dialog', { name: 'New message' })
  await expect(compose.getByRole('button', { name: 'Send' })).toBeInViewport()
  await screenshot('narrow-compose')
  await page.keyboard.press('Escape')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1240, 800))
})

test('in dark mode, an email without colours of its own goes dark; a designed one stays on white', async () => {
  await page.evaluate(() => window.ordo.settings.set({ theme: 'dark' }))
  try {
    await page
      .getByRole('complementary', { name: 'Mailboxes' })
      .getByRole('button', { name: /^Inbox/ })
      .click()
    await row(PLAIN).click()
    await expect(frame().getByText(`Just words ${run}`)).toBeVisible()
    await expect(frame().locator('body')).toHaveCSS('background-color', 'rgb(30, 30, 30)')
    await row(`News Desk: ${NEWS}`).click()
    await expect(frame().locator('h1')).toBeVisible()
    await expect(frame().locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  } finally {
    await page.evaluate(() => window.ordo.settings.set({ theme: 'system' }))
  }
})

test('your own folders open too', async () => {
  await page
    .getByRole('complementary', { name: 'Mailboxes' })
    .getByRole('button', { name: FOLDER, exact: true })
    .click()
  await expect(page.getByRole('heading', { level: 1, name: FOLDER })).toBeVisible()
  await expect(page.getByText(`Nothing in ${FOLDER}.`)).toBeVisible({ timeout: 15_000 })
  await screenshot('empty-folder')
})
