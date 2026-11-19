import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImapFlow } from 'imapflow'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { imapPort, seedMailbox, TEST_ACCOUNT } from './imap'
import { launchApp } from './launch'

/*
 * Unclutter's per-sender Unsubscribe button against GreenMail and a local one-click endpoint:
 * the single-sender sheet (Move to Trash off), Cancel, a one-click that works and one that fails,
 * and "Unsubscribed" read back from clean-up history after a restart.
 */

test.describe.configure({ mode: 'serial' })
test.skip(!imapPort, 'Set IMAP_TEST_PORT and run `pnpm imap:start` to test against a local IMAP server')

const run = Date.now().toString(36)
const STORE = `Weekly Deals ${run}`
const FROM = `weekly-${run}@deals.example`
const BROKEN = `Flash Sale ${run}`
const BROKEN_FROM = `flash-${run}@sale.example`
const CLUB = `Club News ${run}`
const DAY = 24 * 60 * 60 * 1000

let app: ElectronApplication
let page: Page
let server: Server
const userData = mkdtempSync(join(tmpdir(), 'ordo-e2e-unsubscribe-'))
const posts: string[] = []

function imap() {
  return new ImapFlow({
    host: '127.0.0.1',
    port: Number(imapPort),
    secure: false,
    auth: { user: TEST_ACCOUNT.email, pass: TEST_ACCOUNT.password },
    logger: false,
  })
}

/** How many emails from an address are in a mailbox right now. */
async function countFrom(mailbox: string, from: string): Promise<number> {
  const c = imap()
  await c.connect()
  try {
    const lock = await c.getMailboxLock(mailbox)
    try {
      return ((await c.search({ from }, { uid: true })) || []).length
    } finally {
      lock.release()
    }
  } finally {
    await c.logout()
  }
}

async function screenshot(name: string) {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => window.ordo.settings.set({ theme: t }), theme)
    await expect
      .poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches))
      .toBe(theme === 'dark')
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    await page.screenshot({ path: `test-results/screenshots/${name}-${theme}.png`, animations: 'disabled' })
  }
  await page.evaluate(() => window.ordo.settings.set({ theme: 'light' }))
}

async function launch() {
  app = await launchApp({
    ORDO_USER_DATA: userData,
    ORDO_IMAP_HOST: '127.0.0.1',
    ORDO_IMAP_PORT: imapPort!,
    // Unpackaged test builds only: let one-click unsubscribe reach the local http endpoint.
    ORDO_TEST_ALLOW_LOOPBACK_HTTP: '1',
  })
  page = await app.firstWindow()
  // Ordo's narrowest window: the table must still fit.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(920, 760))
}

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => {
      if (req.method === 'POST') posts.push(`${req.url} ${body}`)
      if (req.url?.startsWith('/broken/')) return res.writeHead(500).end('Down for maintenance')
      res.writeHead(200, { 'content-type': 'text/plain' }).end('You have been unsubscribed')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port

  await seedMailbox()
  const c = imap()
  await c.connect()
  if (!(await c.list()).some((b) => b.specialUse === '\\Trash')) await c.mailboxCreate('Trash')
  const email = (name: string, from: string, path: string, n: number) =>
    `From: ${name} <${from}>\r\nTo: ${TEST_ACCOUNT.email}\r\nSubject: Offer ${n} from ${name}\r\n` +
    `Date: Tue, 17 Nov 2026 1${n}:00:00 +0000\r\nList-Id: <${path}.example>\r\n` +
    `List-Unsubscribe: <http://127.0.0.1:${port}/${path}/${run}>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n\r\nShop now\r\n`
  for (const n of [1, 2, 3]) await c.append('INBOX', email(STORE, FROM, 'weekly', n))
  for (const n of [1, 2]) await c.append('INBOX', email(BROKEN, BROKEN_FROM, 'broken', n))
  // Unsubscribes by email to another domain: off until ticked, so the sheet's button starts disabled.
  await c.append(
    'INBOX',
    `From: ${CLUB} <news-${run}@club.example>\r\nTo: ${TEST_ACCOUNT.email}\r\nSubject: This week at the club\r\n` +
      `Date: Mon, 16 Nov 2026 09:00:00 +0000\r\nList-Id: <news.club.example>\r\n` +
      `List-Unsubscribe: <mailto:optout@lists.mailhost.example?subject=Remove%20me%20${run}>\r\n\r\nNews\r\n`,
  )
  await c.logout()

  await launch()
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
})

const sheet = () => page.getByRole('dialog')
const button = (name: string) => page.getByRole('button', { name: `Unsubscribe from ${name}`, exact: true })
const tryAgain = (name: string) =>
  page.getByRole('button', { name: `Unsubscribe from ${name} again`, exact: true })
const primary = () => sheet().getByRole('button', { name: 'Unsubscribe', exact: true })
const row = (name: string) => page.getByRole('row').filter({ hasText: name })

test('connects and scans: one-click senders get a button, people never do', async () => {
  await page.getByRole('navigation').getByRole('button', { name: 'Mail' }).click()
  await page.getByRole('button', { name: 'Connect iCloud' }).click()
  await page.getByLabel('Apple ID email').fill(TEST_ACCOUNT.email)
  await page.getByLabel('App-specific password').fill(TEST_ACCOUNT.password)
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByRole('button', { name: 'Scan inbox' }).click()
  await expect(button(STORE)).toBeVisible({ timeout: 15_000 })
  await expect(button(STORE)).toHaveAccessibleDescription('One-click: Ordo unsubscribes for you')
  await expect(button(BROKEN)).toBeVisible()
  await expect(page.getByRole('checkbox', { name: 'Select Sam' })).toBeDisabled()
  await expect(button('Sam')).toHaveCount(0)
  // The button fits in its column at Ordo's narrowest window, with its label whole.
  const cell = await row(STORE).getByRole('cell').last().boundingBox()
  const box = await button(STORE).boundingBox()
  expect(box!.x + box!.width).toBeLessThanOrEqual(cell!.x + cell!.width)
  await expect(button(STORE)).toHaveText('Unsubscribe')
  expect(
    await button(STORE)
      .locator('span')
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true)
})

test('Unsubscribe opens the sheet for that sender, with Move to Trash off; Cancel changes nothing', async () => {
  await button(STORE).click()
  // The button never selects the row.
  await expect(page.getByRole('checkbox', { name: `Select ${STORE}` })).not.toBeChecked()

  await expect(sheet().getByRole('heading', { name: `Unsubscribe from ${STORE}` })).toBeVisible()
  await expect(sheet().getByRole('switch', { name: `Unsubscribe from ${STORE}` })).toBeChecked()
  await expect(sheet().getByRole('switch', { name: `Move emails from ${STORE} to Trash` })).not.toBeChecked()
  await expect(sheet().getByText('Unsubscribe from 1 sender', { exact: true })).toBeVisible()
  await expect(
    sheet().getByText('Your emails stay in your inbox. Unsubscribing can’t be undone.'),
  ).toBeVisible()
  // Cancel has focus, not Unsubscribe, so a stray Return can't unsubscribe.
  await expect(sheet().getByRole('button', { name: 'Cancel' })).toBeFocused()
  await screenshot('unsubscribe-sheet')

  await sheet().getByRole('button', { name: 'Cancel' }).click()
  await expect(sheet()).toBeHidden()
  expect(posts).toEqual([])
  await expect(button(STORE)).toBeFocused()
  expect(await countFrom('INBOX', FROM)).toBe(3)
})

test('the keyboard opens it too, and Escape closes it', async () => {
  await button(STORE).focus()
  await page.keyboard.press('Enter')
  await expect(sheet().getByRole('heading', { name: `Unsubscribe from ${STORE}` })).toBeVisible()
  await expect(page.getByRole('checkbox', { name: `Select ${STORE}` })).not.toBeChecked()
  await page.keyboard.press('Escape')
  await expect(sheet()).toBeHidden()
  expect(posts).toEqual([])
})

test('Return twice on the button, or a held Return, never unsubscribes', async () => {
  // Return opens the sheet; Return again straight away lands on Cancel.
  await button(STORE).focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await expect(sheet()).toBeHidden()
  expect(posts).toEqual([])

  // Even with focus moved to Unsubscribe at once, it ignores presses for a moment after opening.
  await button(STORE).focus()
  await page.keyboard.press('Enter')
  await expect(sheet()).toBeVisible()
  await primary().focus()
  await expect(primary()).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Enter')
  await expect(sheet().getByRole('heading', { name: `Unsubscribe from ${STORE}` })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sheet()).toBeHidden()

  // Held down: the press opens the sheet, and its repeats never press Unsubscribe, even once it's ready.
  await button(STORE).focus()
  await page.keyboard.down('Enter')
  await expect(sheet()).toBeVisible()
  await expect(primary()).not.toHaveAttribute('aria-disabled')
  await primary().focus()
  await page.keyboard.down('Enter')
  await page.keyboard.down('Enter')
  await page.keyboard.up('Enter')
  await expect(sheet().getByRole('heading', { name: `Unsubscribe from ${STORE}` })).toBeVisible()
  await page.waitForTimeout(300)
  expect(posts).toEqual([])
  await page.keyboard.press('Escape')
  await expect(sheet()).toBeHidden()
  expect(await countFrom('INBOX', FROM)).toBe(3)
})

test('confirming unsubscribes with one click and keeps the emails in the inbox', async () => {
  await button(STORE).click()
  await expect(page.getByRole('checkbox', { name: `Select ${STORE}` })).not.toBeChecked()
  await primary().click()
  await expect(sheet().getByRole('heading', { name: `Unsubscribed from ${STORE}` })).toBeVisible({
    timeout: 20_000,
  })
  await expect(sheet().getByText('Unsubscribed from 1 sender.')).toBeVisible()
  await expect(sheet().getByText('Kept in inbox')).toBeVisible()
  expect(posts).toEqual([`/weekly/${run} List-Unsubscribe=One-Click`])

  await sheet().getByRole('button', { name: 'Done' }).click()
  await expect(sheet()).toBeHidden()
  const status = row(STORE).getByText('Unsubscribed', { exact: true })
  await expect(status).toBeVisible()
  await expect(status).toBeFocused()
  await expect(button(STORE)).toHaveCount(0)
  // It can still be tried again.
  await expect(tryAgain(STORE)).toBeVisible()
  await tryAgain(STORE).click()
  await expect(page.getByRole('checkbox', { name: `Select ${STORE}` })).not.toBeChecked()
  await expect(sheet().getByRole('heading', { name: `Unsubscribe from ${STORE}` })).toBeVisible()
  await sheet().getByRole('button', { name: 'Cancel' }).click()
  await expect(sheet()).toBeHidden()
  expect(posts).toEqual([`/weekly/${run} List-Unsubscribe=One-Click`])
  expect(await countFrom('INBOX', FROM)).toBe(3)
  expect(await countFrom('Trash', FROM)).toBe(0)
  // The row is still there, with all its emails.
  await expect(row(STORE).getByRole('cell').nth(2)).toHaveText('3')
})

test('a failed unsubscribe says why, and the button stays', async () => {
  await button(BROKEN).click()
  await primary().click()
  await expect(sheet().getByRole('heading', { name: 'Couldn’t unsubscribe' })).toBeVisible({
    timeout: 20_000,
  })
  await expect(sheet().getByText('Failed: The server answered 500')).toBeVisible()
  await sheet().getByRole('button', { name: 'Done' }).click()
  await expect(button(BROKEN)).toBeVisible()
  await expect(button(BROKEN)).toBeFocused()
  await expect(tryAgain(BROKEN)).toHaveCount(0)
  expect(await countFrom('INBOX', BROKEN_FROM)).toBe(2)
  await row(STORE).scrollIntoViewIfNeeded()
  await screenshot('unsubscribe-table')
})

test('when Unsubscribe starts off (an email to another domain), focus stays in the sheet', async () => {
  const before = posts.length
  await button(CLUB).click()
  await expect(sheet().getByRole('heading', { name: `Unsubscribe from ${CLUB}` })).toBeVisible()
  await expect(sheet().getByRole('switch', { name: `Unsubscribe from ${CLUB}` })).not.toBeChecked()
  await expect(primary()).toBeDisabled()
  await expect(sheet().getByRole('button', { name: 'Cancel' })).toBeFocused()
  // Tab goes round the sheet and never out behind it.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab')
    expect(await sheet().evaluate((el) => el.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(sheet()).toBeHidden()
  expect(posts).toHaveLength(before)
})

test('Unsubscribed is read back from clean-up history after a restart', async () => {
  await app.close()
  await launch()
  await page.getByRole('navigation').getByRole('button', { name: 'Unclutter' }).click()
  await expect(row(STORE).getByText('Unsubscribed', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(button(STORE)).toHaveCount(0)
  await expect(button(BROKEN)).toBeVisible()
})

test('a sender still emailing two days after unsubscribing gets its button back', async () => {
  const c = imap()
  await c.connect()
  const later = new Date(Date.now() + 3 * DAY).toUTCString().replace('GMT', '+0000')
  await c.append(
    'INBOX',
    `From: ${STORE} <${FROM}>\r\nTo: ${TEST_ACCOUNT.email}\r\nSubject: We miss you\r\nDate: ${later}\r\n` +
      `List-Id: <weekly.example>\r\n\r\nCome back\r\n`,
  )
  await c.logout()
  await page.getByRole('button', { name: 'Scan again' }).click()
  await expect(row(STORE).getByText('Still emailing', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(button(STORE)).toBeVisible()
  await expect(row(STORE).getByText('Unsubscribed', { exact: true })).toHaveCount(0)
  await row(STORE).scrollIntoViewIfNeeded()
  await screenshot('unsubscribe-still-emailing')
})
