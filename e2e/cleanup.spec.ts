import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ImapFlow } from 'imapflow'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { imapPort, seedMailbox, TEST_ACCOUNT } from './imap'
import { launchApp } from './launch'

// The whole clean-up flow against GreenMail and a local one-click unsubscribe endpoint.
// Set ORDO_E2E_SCREENSHOTS=1 to save the review sheet, result and history in light and dark
// under test-results/screenshots/.

test.describe.configure({ mode: 'serial' })
test.skip(!imapPort, 'Set IMAP_TEST_PORT and run `pnpm imap:start` to test against a local IMAP server')

const run = Date.now().toString(36)
const STORE = `Mega Store ${run}`
const FROM = `deals-${run}@store.example`
const CLUB = `Club News ${run}`
const shots = process.env['ORDO_E2E_SCREENSHOTS'] === '1'

let app: ElectronApplication
let page: Page
let server: Server
const posts: { url?: string; headers: IncomingHttpHeaders; body: string }[] = []

function imap() {
  return new ImapFlow({
    host: '127.0.0.1',
    port: Number(imapPort),
    secure: false,
    auth: { user: TEST_ACCOUNT.email, pass: TEST_ACCOUNT.password },
    logger: false,
  })
}

/** How many emails from the test sender are in a mailbox right now. */
async function countFrom(mailbox: string): Promise<number> {
  const c = imap()
  await c.connect()
  try {
    const lock = await c.getMailboxLock(mailbox)
    try {
      return ((await c.search({ from: FROM }, { uid: true })) || []).length
    } finally {
      lock.release()
    }
  } finally {
    await c.logout()
  }
}

async function screenshot(name: string) {
  if (!shots) return
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => window.ordo.settings.set({ theme: t }), theme)
    await page.waitForTimeout(250)
    await page.screenshot({ path: `test-results/screenshots/${name}-${theme}.png` })
  }
  await page.evaluate(() => window.ordo.settings.set({ theme: 'system' }))
}

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => {
      if (req.method === 'POST') posts.push({ url: req.url, headers: req.headers, body })
      res.writeHead(200, { 'content-type': 'text/plain' }).end('You have been unsubscribed')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port

  await seedMailbox()
  const c = imap()
  await c.connect()
  if (!(await c.list()).some((b) => b.specialUse === '\\Trash')) await c.mailboxCreate('Trash')
  for (const n of [1, 2, 3])
    await c.append(
      'INBOX',
      `From: ${STORE} <${FROM}>\r\nTo: ${TEST_ACCOUNT.email}\r\nSubject: ${n * 10}% off everything, sale ends tonight\r\n` +
        `Date: Mon, 16 Nov 2026 1${n}:00:00 +0000\r\nList-Id: <deals.store.example>\r\n` +
        `List-Unsubscribe: <http://127.0.0.1:${port}/unsub/${run}>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n\r\nShop now\r\n`,
    )
  // A list whose unsubscribe address is on another domain: never sent without a tick.
  await c.append(
    'INBOX',
    `From: ${CLUB} <news-${run}@club.example>\r\nTo: ${TEST_ACCOUNT.email}\r\nSubject: This week at the club\r\n` +
      `Date: Mon, 16 Nov 2026 09:00:00 +0000\r\nList-Id: <news.club.example>\r\n` +
      `List-Unsubscribe: <mailto:optout@lists.mailhost.example?subject=Remove%20me%20${run}>\r\n\r\nNews\r\n`,
  )
  await c.logout()

  app = await launchApp({
    ORDO_IMAP_HOST: '127.0.0.1',
    ORDO_IMAP_PORT: imapPort!,
    // Unpackaged test builds only: let one-click unsubscribe reach the local http endpoint.
    ORDO_TEST_ALLOW_LOOPBACK_HTTP: '1',
  })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
})

const review = () => page.getByRole('dialog')
const storeCheckbox = () => page.getByRole('checkbox', { name: `Select ${STORE}` })

test('connects and scans', async () => {
  await page.getByRole('navigation').getByRole('button', { name: 'Mail' }).click()
  await page.getByRole('button', { name: 'Connect iCloud' }).click()
  await page.getByLabel('Apple ID email').fill(TEST_ACCOUNT.email)
  await page.getByLabel('App-specific password').fill(TEST_ACCOUNT.password)
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByRole('button', { name: 'Scan inbox' }).click()
  await expect(storeCheckbox()).toBeEnabled({ timeout: 15_000 })
  await expect(page.getByRole('checkbox', { name: 'Select Sam' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Review and clear' })).toBeDisabled()
})

test('the review sheet lists the selected senders and closes with Escape', async () => {
  const club = page.getByRole('checkbox', { name: `Select ${CLUB}` })
  await storeCheckbox().check()
  await club.check()
  await page.getByRole('button', { name: 'Review and clear' }).click()
  // The email unsubscribe shows its exact recipient and subject, and stays off until ticked.
  await expect(
    review().getByText(
      `Email unsubscribe to a different domain (optout@lists.mailhost.example). Sends “Remove me ${run}” to optout@lists.mailhost.example`,
      { exact: false },
    ),
  ).toBeVisible()
  await expect(review().getByRole('switch', { name: `Unsubscribe from ${CLUB}` })).not.toBeChecked()
  await screenshot('review-sheet')
  await page.keyboard.press('Escape')
  await club.uncheck()

  await page.getByRole('button', { name: 'Review and clear' }).click()
  await expect(review().getByRole('heading', { name: 'Review clean-up' })).toBeVisible()
  await expect(review().getByText(FROM)).toBeVisible()
  await expect(review().getByText('One-click')).toBeVisible()
  await expect(review().getByRole('switch', { name: `Unsubscribe from ${STORE}` })).toBeChecked()
  await expect(review().getByRole('switch', { name: `Move emails from ${STORE} to Trash` })).toBeChecked()
  await expect(review().getByText('Unsubscribe from 1 sender and move 3 emails to Trash')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(review()).toBeHidden()
})

test('Clear unsubscribes with one click and moves the emails to Trash', async () => {
  await page.getByRole('button', { name: 'Review and clear' }).click()
  await review().getByRole('button', { name: 'Clear' }).click()

  await expect(review().getByRole('heading', { name: 'Clean-up done' })).toBeVisible({ timeout: 20_000 })
  await expect(review().getByText('Moved 3 emails to Trash. Unsubscribed from 1 sender.')).toBeVisible()
  await expect(review().getByText('Unsubscribed', { exact: true })).toBeVisible()
  await expect(review().getByRole('button', { name: 'Undo move' })).toBeVisible()
  await screenshot('result')

  expect(posts).toHaveLength(1)
  expect(posts[0]).toMatchObject({
    url: `/unsub/${run}`,
    body: 'List-Unsubscribe=One-Click',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Ordo' },
  })
  expect(posts[0]!.headers.cookie).toBeUndefined()
  expect(await countFrom('INBOX')).toBe(0)
  expect(await countFrom('Trash')).toBe(3)

  await review().getByRole('button', { name: 'Done' }).click()
  await expect(review()).toBeHidden()
  await expect(storeCheckbox()).toHaveCount(0)
})

test('History lists the clean-up and Undo puts the emails back', async () => {
  await page.getByRole('navigation').getByRole('button', { name: 'History' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Clean-up history' })).toBeVisible()
  const card = page.getByRole('region').filter({ hasText: STORE })
  await expect(card).toBeVisible()
  await expect(card.getByText('Unsubscribed', { exact: true })).toBeVisible()
  await expect(card.getByText('3 emails moved')).toBeVisible()
  await expect(page.getByText('Unsubscribes can’t be undone.')).toBeVisible()
  await screenshot('history')

  await card.getByRole('button', { name: 'Undo move' }).click()
  await expect(card.getByRole('status')).toHaveText('Moved 3 emails back to your inbox.', { timeout: 20_000 })
  await expect(card.getByRole('button', { name: 'Undo move' })).toHaveCount(0)
  expect(await countFrom('INBOX')).toBe(3)
  expect(await countFrom('Trash')).toBe(0)

  await page.getByRole('navigation').getByRole('button', { name: 'Unclutter' }).click()
  await expect(storeCheckbox()).toBeEnabled()
})
